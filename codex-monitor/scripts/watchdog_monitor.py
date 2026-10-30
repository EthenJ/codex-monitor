#!/usr/bin/env python3
"""Observe file events, inactivity, GPU utilization, or an existing training PID.

This sidecar never terminates or restarts the observed process. Only meaningful
state transitions invoke the callback; GPU samples stay in the local process.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import queue
import select
import subprocess
import threading
import time
from pathlib import Path

from file_events import FileWatcher
from monitor_callback import (MAX_EVENT_CHARS, enqueue_codex, emit,
                              invoke_callback_command, now_iso, safe_format)


class HealthState:
    """Monotonic timers and edge-triggered any/all health transitions."""
    def __init__(self, enabled, mode, started, warmup_ms, stalled_ms=None,
                 gpu_threshold=None, gpu_dwell_ms=120000, gpu_recover=None, gpu_mode="all"):
        self.enabled, self.mode = set(enabled), mode
        self.armed_at = started + warmup_ms / 1000
        self.last_progress = self.armed_at
        self.stalled_ms = stalled_ms
        self.threshold, self.dwell = gpu_threshold, gpu_dwell_ms / 1000
        self.recover = gpu_recover if gpu_recover is not None else gpu_threshold
        self.gpu_mode = gpu_mode
        self.low_since = None
        self.active = {}
        self.alerting = False

    def progress(self, now):
        self.last_progress = max(now, self.armed_at)
        self.active.pop("file_stalled", None)

    def gpu_sample(self, now, values):
        if now < self.armed_at:
            self.low_since = None
            return
        combine = all if self.gpu_mode == "all" else any
        low = combine(value < self.threshold for value in values.values())
        # Recover above the higher boundary to avoid threshold flapping.
        recovered = not combine(value < self.recover for value in values.values())
        if recovered:
            self.active.pop("gpu_low", None)
            self.low_since = None
        elif "gpu_low" not in self.active:
            if not low:
                self.low_since = None
            else:
                if self.low_since is None:
                    self.low_since = now
                if now - self.low_since >= self.dwell:
                    self.active["gpu_low"] = {"utilization": values, "threshold": self.threshold,
                                              "duration_ms": int((now - self.low_since) * 1000)}

    def gpu_unknown(self):
        # Missing/invalid samples break continuous-low evidence; never count
        # provider downtime toward the low-utilization dwell time.
        self.low_since = None
        self.active.pop("gpu_low", None)
        # Unknown is neither healthy nor a recovery notification. Re-arm from
        # the remaining known conditions without generating a healthy edge.
        self.alerting = bool(self.active) if self.mode == "any" else bool(self.enabled) and self.enabled.issubset(self.active)

    def tick(self, now):
        if self.stalled_ms is not None and now >= self.armed_at:
            duration = int((now - self.last_progress) * 1000)
            if duration >= self.stalled_ms:
                self.active["file_stalled"] = {"duration_ms": duration, "threshold_ms": self.stalled_ms}
        ready = bool(self.active) if self.mode == "any" else bool(self.enabled) and self.enabled.issubset(self.active)
        if ready != self.alerting:
            self.alerting = ready
            return {"event_type": "watchdog_stalled" if ready else "watchdog_recovered",
                    "status": "suspected_stall" if ready else "recovered",
                    "conditions": dict(self.active), "dead_if": self.mode}
        return None


def gpu_values(gpu_id="0", binary="nvidia-smi"):
    argv = [binary, "--query-gpu=index,utilization.gpu", "--format=csv,noheader,nounits"]
    if gpu_id != "all":
        argv.append(f"--id={gpu_id}")
    result = subprocess.run(argv, text=True, capture_output=True, timeout=10, check=False)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "nvidia-smi failed").strip())
    values = {}
    for row in result.stdout.splitlines():
        parts = [value.strip() for value in row.split(",")]
        if len(parts) != 2:
            raise ValueError(f"invalid GPU sample: {row}")
        value = float(parts[1])
        if not math.isfinite(value) or not 0 <= value <= 100:
            raise ValueError(f"invalid GPU utilization: {row}")
        values[parts[0]] = value
    if not values:
        raise ValueError("no GPU utilization values returned")
    return values


def gpu_worker(args, events, stop):
    while not stop.is_set():
        try:
            values = gpu_values(args.gpu_id, args.nvidia_smi)
            events.put({"kind": "gpu_sample", "values": values, "at": time.monotonic()})
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
            events.put({"kind": "sensor_error", "sensor": "gpu", "error": str(exc)})
        stop.wait(args.gpu_sample_ms / 1000)


def process_worker(pid, events, stop, ready):
    """Bind to a process identity once; wait for exit without touching it."""
    try:
        if os.name == "nt":
            import ctypes as c
            from ctypes import wintypes as w
            k = c.WinDLL("kernel32", use_last_error=True)
            k.OpenProcess.argtypes, k.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
            k.WaitForSingleObject.argtypes, k.WaitForSingleObject.restype = [w.HANDLE, w.DWORD], w.DWORD
            k.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
            k.CloseHandle.argtypes = [w.HANDLE]
            handle = k.OpenProcess(0x100000 | 0x1000, False, pid)
            if not handle:
                raise c.WinError(c.get_last_error())
            try:
                ready.set()
                while not stop.is_set():
                    result = k.WaitForSingleObject(handle, 250)
                    if result == 0:
                        code = w.DWORD()
                        if not k.GetExitCodeProcess(handle, c.byref(code)):
                            raise c.WinError(c.get_last_error())
                        events.put({"kind": "process_exit", "returncode": code.value})
                        return
                    if result != 258:
                        raise c.WinError(c.get_last_error())
            finally:
                k.CloseHandle(handle)
        elif hasattr(os, "pidfd_open"):
            descriptor = os.pidfd_open(pid)
            try:
                ready.set()
                while not stop.is_set():
                    if select.select([descriptor], [], [], 0.25)[0]:
                        events.put({"kind": "process_exit", "returncode": None})
                        return
            finally:
                os.close(descriptor)
        else:
            import psutil
            proc = psutil.Process(pid)
            ready.set()
            while not stop.is_set():
                try:
                    code = proc.wait(timeout=0.5)
                    events.put({"kind": "process_exit", "returncode": code})
                    return
                except psutil.TimeoutExpired:
                    continue
    except Exception as exc:
        events.put({"kind": "sensor_error", "sensor": "process", "fatal": True, "error": str(exc)})
    finally:
        ready.set()


def build_parser():
    p = argparse.ArgumentParser(description=__doc__)
    paths = p.add_mutually_exclusive_group()
    paths.add_argument("--watch-directory")
    paths.add_argument("--watch-file", help="May be created later if its parent already exists")
    p.add_argument("--recursive", action="store_true")
    p.add_argument("--pattern", help="Include changed paths matching this glob, e.g. '*.ckpt'")
    p.add_argument("--file-backend", choices=("auto", "native", "polling"), default="auto")
    p.add_argument("--poll-ms", type=int, default=1000, help="Local snapshot fallback interval")
    p.add_argument("--stalled-for-ms", type=int, help="No progress on the selected file/directory for this long")
    p.add_argument("--gpu-util-below", type=float)
    p.add_argument("--gpu-recover-above", type=float, help="Recovery boundary; defaults to the low threshold")
    p.add_argument("--gpu-below-for-ms", type=int, default=120000)
    p.add_argument("--gpu-sample-ms", type=int, default=10000)
    p.add_argument("--gpu-id", default="0", help="Physical index/UUID, comma-separated list, or all")
    p.add_argument("--gpu-match", choices=("all", "any"), default="all")
    p.add_argument("--nvidia-smi", default="nvidia-smi", help="Executable path")
    p.add_argument("--pid", type=int, help="Observe an already-running training process; never kill it")
    p.add_argument("--dead-if", choices=("any", "all"), default="any", help="Combine enabled inactivity/GPU conditions")
    p.add_argument("--warmup-ms", type=int, default=0, help="Startup grace period before health timers start")
    p.add_argument("--watchdog-only", action="store_true", help="Suppress ordinary file-change callbacks")
    p.add_argument("--report-recovery", action="store_true")
    p.add_argument("--codex-thread", default=os.environ.get("CODEX_THREAD_ID"))
    p.add_argument("--callback-command", help="Shell callback receiving event JSON on stdin")
    p.add_argument("--message-template", default="Monitor {event_type}: {event}. Investigate within the authorized scope.")
    p.add_argument("--codex-bin")
    p.add_argument("--cwd")
    p.add_argument("--timeout-ms", type=int, default=1800000, help="Explicit lifetime; larger values allowed for training runs")
    p.add_argument("--max-events", type=int, default=0)
    p.add_argument("--debounce-ms", type=int, default=500)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--stop-on-callback-error", action="store_true")
    p.add_argument("--source", default="watchdog")
    return p


def validate(args, parser):
    if not (args.watch_file or args.watch_directory or args.gpu_util_below is not None or args.pid):
        parser.error("provide a file/directory, GPU threshold, or --pid")
    if not (args.codex_thread or args.callback_command):
        parser.error("provide --codex-thread or --callback-command")
    for field in ("timeout_ms", "poll_ms", "gpu_sample_ms", "gpu_below_for_ms", "stalled_for_ms", "pid"):
        value = getattr(args, field)
        if value is not None and value <= 0:
            parser.error(f"--{field.replace('_', '-')} must be positive")
    for field in ("max_events", "debounce_ms", "warmup_ms"):
        if getattr(args, field) < 0:
            parser.error(f"--{field.replace('_', '-')} must be non-negative")
    if args.warmup_ms >= args.timeout_ms:
        parser.error("warmup must be shorter than the monitor lifetime")
    if args.stalled_for_ms is not None and not (args.watch_file or args.watch_directory):
        parser.error("--stalled-for-ms needs --watch-file or --watch-directory")
    if args.gpu_util_below is not None:
        if not 0 <= args.gpu_util_below <= 100:
            parser.error("GPU threshold must be between 0 and 100")
        if args.gpu_recover_above is not None and not args.gpu_util_below <= args.gpu_recover_above <= 100:
            parser.error("GPU recovery boundary must be between the low threshold and 100")
    elif args.gpu_recover_above is not None:
        parser.error("--gpu-recover-above requires --gpu-util-below")
    if args.watchdog_only and not (args.stalled_for_ms or args.gpu_util_below is not None or args.pid):
        parser.error("--watchdog-only needs an inactivity/GPU/PID condition")
    if args.cwd:
        args.cwd = str(Path(args.cwd).expanduser().resolve())
        if not Path(args.cwd).is_dir():
            parser.error("--cwd must be an existing directory")
    for field in ("watch_file", "watch_directory"):
        if getattr(args, field):
            path = Path(getattr(args, field)).expanduser()
            path = Path(os.path.abspath(Path(args.cwd or os.getcwd()) / path))
            if field == "watch_directory" and not path.is_dir():
                parser.error(f"directory does not exist: {path}")
            if field == "watch_file" and (path.is_dir() or not path.parent.is_dir()):
                parser.error(f"file parent must exist and target must not be a directory: {path}")
            setattr(args, field, path)


def run(args):
    events = queue.Queue()
    stop = threading.Event()
    watcher = None
    workers = []
    started = time.monotonic()
    enabled = []
    if args.stalled_for_ms:
        enabled.append("file_stalled")
    if args.gpu_util_below is not None:
        enabled.append("gpu_low")
    health = HealthState(enabled, args.dead_if, started, args.warmup_ms, args.stalled_for_ms,
                         args.gpu_util_below, args.gpu_below_for_ms, args.gpu_recover_above, args.gpu_match)
    count, errors, sensor_errors = 0, False, {}
    last_callback = {}
    reason = "deadline"

    def log(kind, **data):
        emit({"type": kind, "timestamp": now_iso(), "source": args.source, "pid": args.pid, **data})

    def dispatch(event_type, details):
        nonlocal count, errors, reason
        event_text = json.dumps(details, ensure_ascii=False, separators=(",", ":"))[:MAX_EVENT_CHARS]
        # Key on the path, not the change kind: one save can surface as
        # created+modified and must not wake Codex twice.
        key = (event_type, details.get("path"))
        now = time.monotonic()
        if event_type == "file_change" and (now - last_callback.get(key, -float("inf"))) * 1000 < args.debounce_ms:
            return
        last_callback[key] = now
        count += 1
        payload = {"event_type": event_type, "event": event_text, "timestamp": now_iso(),
                   "source": args.source, "pid": args.pid, "event_index": count, **details}
        message = safe_format(args.message_template, payload)
        payload["message"] = message
        log("event", **{k: v for k, v in payload.items() if k not in {"source", "timestamp", "pid"}})
        if args.callback_command:
            ok, output = invoke_callback_command(command=args.callback_command, payload=payload, cwd=args.cwd, dry_run=args.dry_run)
        else:
            ok, output = enqueue_codex(thread=args.codex_thread, message=message, codex_bin=args.codex_bin,
                                       cwd=args.cwd, dry_run=args.dry_run)
        errors = errors or not ok
        log("callback", event_type=event_type, event_index=count, ok=ok, output=output[-MAX_EVENT_CHARS:])
        if not ok and args.stop_on_callback_error:
            reason = "callback_error"
            stop.set()
        elif args.max_events and count >= args.max_events:
            reason = "max_events"
            stop.set()

    try:
        if args.watch_file or args.watch_directory:
            watcher = FileWatcher(args.watch_file or args.watch_directory, bool(args.watch_file), events,
                                  recursive=args.recursive, pattern=args.pattern, backend=args.file_backend,
                                  poll_ms=args.poll_ms).start()
            log("backend", backend=watcher.backend, poll_ms=args.poll_ms if watcher.backend == "snapshot-fallback" else None)
        if args.pid:
            ready = threading.Event()
            worker = threading.Thread(target=process_worker, args=(args.pid, events, stop, ready), daemon=True)
            workers.append(worker)
            worker.start()
            if not ready.wait(10):
                raise RuntimeError("process watcher did not become ready")
        if args.gpu_util_below is not None:
            worker = threading.Thread(target=gpu_worker, args=(args, events, stop), daemon=True)
            workers.append(worker)
            worker.start()
        log("started", path=str(args.watch_file or args.watch_directory or ""), enabled_conditions=enabled,
            dead_if=args.dead_if, timeout_ms=args.timeout_ms, warmup_ms=args.warmup_ms)
        while not stop.is_set():
            now = time.monotonic()
            remaining = args.timeout_ms / 1000 - (now - started)
            if remaining <= 0:
                break
            try:
                item = events.get(timeout=min(0.1, remaining))
            except queue.Empty:
                item = {}
            kind = item.get("kind")
            now = time.monotonic()
            if kind == "file_change":
                # Deletion/rename-away are changes, but do not prove progress.
                if item["change"] in {"created", "modified", "renamed_new"}:
                    health.progress(now)
                if not args.watchdog_only:
                    dispatch("file_change", {k: v for k, v in item.items() if k != "kind"})
            elif kind == "gpu_sample":
                if sensor_errors.pop("gpu", None):
                    log("sensor_recovered", sensor="gpu")
                health.gpu_sample(item["at"], item["values"])
            elif kind == "process_exit":
                # Definitive exit is independent of the heuristic any/all rule.
                code = item["returncode"]
                dispatch("process_exit", {"returncode": code, "status": "completed" if code == 0 else "failed" if code is not None else "exited"})
                reason = "process_exit" if reason not in {"callback_error", "max_events"} else reason
                break
            elif kind == "sensor_error":
                sensor = item["sensor"]
                if sensor == "gpu":
                    health.gpu_unknown()
                if sensor not in sensor_errors:
                    sensor_errors[sensor] = item["error"]
                    dispatch("monitor_error", {"sensor": sensor, "error": item["error"], "status": "unknown"})
                if item.get("fatal"):
                    reason, errors = "sensor_error", True
                    break
            if not stop.is_set():
                transition = health.tick(now)
                if transition and (transition["event_type"] != "watchdog_recovered" or args.report_recovery):
                    dispatch(transition.pop("event_type"), transition)
    except KeyboardInterrupt:
        reason = "cancelled"
    except Exception as exc:
        reason, errors = "monitor_error", True
        dispatch("monitor_error", {"error": str(exc), "status": "unknown"})
    finally:
        stop.set()
        if watcher:
            watcher.close()
        for worker in workers:
            worker.join(timeout=11)
        log("stopped", reason=reason, matched=count, active_conditions=health.active,
            unavailable_sensors=list(sensor_errors))
    return 1 if errors or sensor_errors else 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    validate(args, parser)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
