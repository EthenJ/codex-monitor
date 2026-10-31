#!/usr/bin/env python3
"""Run a command and enqueue a follow-up Codex turn when output matches.

The monitor is deliberately event-driven. A reader thread blocks on the child
process's stdout/stderr and the main thread handles lines as they arrive. It
does not poll a PID or repeatedly ask Codex for status.
"""

from __future__ import annotations

import argparse
import codecs
import datetime as dt
import json
import os
import queue
import re
import shlex
import shutil
import string
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from owned_process import run_owned, start_owned, stop_owned, termination_signals


DEFAULT_TIMEOUT_MS = 300_000
MAX_TIMEOUT_MS = 1_800_000
MAX_EVENT_CHARS = 16_000
MAX_MESSAGE_CHARS = 6000


def bounded_message(message: str) -> str:
    if len(message) > MAX_MESSAGE_CHARS:
        return message[:MAX_MESSAGE_CHARS] + "\n[truncated]"
    return message


def validate_template(template: str) -> None:
    for _, field, specification, conversion in string.Formatter().parse(template):
        if field is not None and (not field.isidentifier() or specification or conversion):
            raise ValueError("use plain {field} placeholders without conversions or format specifications")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def emit(record: dict[str, Any], stream: Any = None) -> None:
    stream = stream or sys.stdout
    # Escaped JSON survives Windows consoles/pipes using a legacy code page.
    stream.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
    stream.flush()


def event_record(
    kind: str,
    *,
    source: str,
    command: str,
    pid: int | None,
    event: str | None = None,
    event_index: int | None = None,
    **extra: Any,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "type": kind,
        "timestamp": now_iso(),
        "source": source,
        "command": command,
    }
    if pid is not None:
        record["pid"] = pid
    if event is not None:
        record["event"] = event[:MAX_EVENT_CHARS]
    if event_index is not None:
        record["event_index"] = event_index
    record.update(extra)
    return record


def terminate_process(proc: subprocess.Popen[str]) -> None:
    stop_owned(proc)


def start_process(command: str, cwd: str | None, encoding: str = "utf-8") -> subprocess.Popen[str]:
    kwargs: dict[str, Any] = {
        "shell": True,
        "cwd": cwd or None,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "text": True,
        "encoding": encoding,
        "errors": "replace",
        "bufsize": 1,
    }
    return start_owned(command, **kwargs)


def stream_lines(proc: subprocess.Popen[str], output: queue.Queue[tuple[str, str | None]],
                 stop: threading.Event, pattern: re.Pattern[str]) -> None:
    assert proc.stdout is not None
    def publish(kind, value):
        while not stop.is_set():
            try:
                output.put((kind, value), timeout=0.1)
                return
            except queue.Full:
                continue
    try:
        while not stop.is_set():
            line = proc.stdout.readline(MAX_EVENT_CHARS + 1)
            if not line:
                break
            if len(line.rstrip("\r\n")) > MAX_EVENT_CHARS:
                raise ValueError(f"command output line exceeds {MAX_EVENT_CHARS} characters")
            line = line.rstrip("\r\n")
            if pattern.search(line):
                publish("line", line)
    except Exception as exc:
        publish("error", str(exc))
    finally:
        publish("eof", None)


def safe_format(template: str, values: dict[str, Any]) -> str:
    class Values(dict[str, Any]):
        def __missing__(self, key: str) -> str:
            return "{" + key + "}"

    return template.format_map(Values(values))


def codex_executable(explicit: str | None) -> str:
    if explicit:
        return explicit
    if os.name == "nt":
        native = shutil.which("codex.exe")
        if native:
            return native
        # npm's .cmd shim would route event text through cmd.exe. Resolve its
        # packaged native executable so callback messages stay argv data.
        roots = []
        if os.environ.get("CODEX_MANAGED_PACKAGE_ROOT"):
            roots.append(Path(os.environ["CODEX_MANAGED_PACKAGE_ROOT"]))
        shim = shutil.which("codex")
        if shim:
            roots.append(Path(shim).parent / "node_modules" / "@openai" / "codex")
        for root in roots:
            for candidate in root.glob("node_modules/@openai/codex-win32-*/vendor/*/bin/codex.exe"):
                return str(candidate)
    return "codex.exe" if os.name == "nt" else "codex"


def enqueue_codex(
    *,
    thread: str,
    message: str,
    codex_bin: str | None,
    cwd: str | None,
    dry_run: bool,
    timeout: float = 30,
) -> tuple[bool, str]:
    executable = codex_executable(codex_bin)
    if os.name == "nt" and Path(executable).suffix.lower() in {".cmd", ".bat"}:
        return False, "--codex-bin must point to the native codex.exe, not a shell shim"
    argv = [executable, "queue", f"--thread={thread}", f"--message={bounded_message(message)}", "--resume"]
    if dry_run:
        return True, shlex.join(argv)
    try:
        result = run_owned(argv, cwd=cwd, timeout=timeout)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    output = (result.stdout or "").strip()
    if result.returncode != 0:
        return False, output or f"codex exited with status {result.returncode}"
    if re.search(r"\bwarn(?:ing)?\b", output, re.IGNORECASE):
        # queue --resume can exit zero even when it only queued the message
        # and failed to wake the thread. Preserve that diagnostic as failure.
        return False, output
    return True, output


def invoke_callback_command(
    *,
    command: str,
    payload: dict[str, Any],
    cwd: str | None,
    dry_run: bool,
    timeout: float = 30,
) -> tuple[bool, str]:
    """Invoke an optional user callback with the event JSON on stdin."""
    if dry_run:
        return True, f"callback-command: {command}"
    try:
        result = run_owned(
            command,
            shell=True,
            cwd=cwd or None,
            input=json.dumps(payload, ensure_ascii=True),
            timeout=timeout,
        )
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    output = (result.stdout or "").strip()
    if result.returncode != 0:
        return False, output or f"callback exited with status {result.returncode}"
    return True, output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", required=True, help="Long-running command whose output is the event source")
    parser.add_argument("--match", required=True, help="Regular expression matched against each output line")
    parser.add_argument("--encoding", default="utf-8", help="Command output encoding; invalid bytes are replaced")
    parser.add_argument("--codex-thread", help="Codex thread UUID or exact session name; defaults to CODEX_THREAD_ID")
    parser.add_argument(
        "--callback-command",
        help="Optional shell callback; receives the event JSON on stdin instead of calling codex queue",
    )
    parser.add_argument(
        "--message-template",
        default="Monitor event from {source}: {event}",
        help="Follow-up message template; fields: event, timestamp, source, command, pid, event_index",
    )
    parser.add_argument("--codex-bin", help="Explicit codex executable path")
    parser.add_argument("--cwd", help="Working directory for the command and callback")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--max-events", type=int, default=0, help="Stop after this many matches; 0 means no count limit")
    parser.add_argument("--debounce-ms", type=int, default=0, help="Suppress identical matches inside this interval")
    parser.add_argument("--dry-run", action="store_true", help="Print callback commands without invoking Codex")
    parser.add_argument(
        "--stop-on-callback-error",
        action="store_true",
        help="Stop the monitor after the first failed callback",
    )
    parser.add_argument("--source", default="command", help="Stable source label included in events")
    return parser


def validate(args: argparse.Namespace, parser: argparse.ArgumentParser) -> tuple[str, re.Pattern[str]]:
    if not args.codex_thread:
        args.codex_thread = os.environ.get("CODEX_THREAD_ID")
    if not args.codex_thread and not args.callback_command:
        parser.error("--codex-thread is required when CODEX_THREAD_ID is not set")
    if args.timeout_ms <= 0 or args.timeout_ms > MAX_TIMEOUT_MS:
        parser.error(f"--timeout-ms must be between 1 and {MAX_TIMEOUT_MS}")
    if args.max_events < 0:
        parser.error("--max-events must be 0 or greater")
    if args.debounce_ms < 0:
        parser.error("--debounce-ms must be 0 or greater")
    try:
        pattern = re.compile(args.match)
    except re.error as exc:
        parser.error(f"invalid --match regex: {exc}")
    if args.cwd and not Path(args.cwd).is_dir():
        parser.error(f"--cwd is not a directory: {args.cwd}")
    try:
        codecs.lookup(args.encoding)
        validate_template(args.message_template)
    except (LookupError, ValueError) as exc:
        parser.error(str(exc))
    return args.codex_thread, pattern


def run(args: argparse.Namespace, thread: str, pattern: re.Pattern[str], *,
        record_sink=None, dispatcher=None, stop_event=None) -> int:
    proc = start_process(args.command, args.cwd, args.encoding)
    try:
        return observe_command(args, thread, pattern, proc, record_sink=record_sink,
                               dispatcher=dispatcher, stop_event=stop_event)
    finally:
        # Covers cancellation/resource failures before the reader is created.
        terminate_process(proc)
        reader = getattr(proc, "monitor_reader", None)
        if reader is None or not reader.is_alive():
            proc.stdout.close()


def observe_command(args, thread, pattern, proc, *, record_sink=None, dispatcher=None, stop_event=None):
    log = record_sink or emit
    started = time.monotonic()
    output: queue.Queue[tuple[str, str | None]] = queue.Queue(maxsize=256)
    stop = stop_event or threading.Event()
    reader = threading.Thread(target=stream_lines, args=(proc, output, stop, pattern), daemon=True)
    proc.monitor_reader = reader

    matched = 0
    last_event: str | None = None
    last_event_at = 0.0
    saw_eof = False
    exit_reason = "completed"
    callback_failed = False
    try:
        reader.start()
        log(event_record("started", source=args.source, command=args.command, pid=proc.pid))
        while True:
            if stop.is_set():
                exit_reason = "cancelled"
                break
            remaining = args.timeout_ms / 1000 - (time.monotonic() - started)
            if remaining <= 0:
                exit_reason = "deadline"
                break
            try:
                kind, line = output.get(timeout=min(0.25, remaining))
            except queue.Empty:
                if saw_eof and proc.poll() is not None:
                    break
                continue
            if time.monotonic() - started >= args.timeout_ms / 1000:
                exit_reason = "deadline"
                break
            if kind == "error":
                exit_reason = "monitor_error"
                log(event_record("monitor_error", source=args.source, command=args.command,
                                  pid=proc.pid, error=line))
                break
            if kind == "eof":
                saw_eof = True
                try:
                    proc.wait(timeout=min(0.2, max(0, args.timeout_ms / 1000 - (time.monotonic() - started))))
                except subprocess.TimeoutExpired:
                    # A child may close its current stream before it exits.
                    # Keep the monitor alive until the process actually ends.
                    continue
                else:
                    break
            assert line is not None
            if not pattern.search(line):
                continue
            current = time.monotonic()
            if (
                args.debounce_ms
                and last_event == line
                and (current - last_event_at) * 1000 < args.debounce_ms
            ):
                continue
            last_event = line
            last_event_at = current
            matched += 1
            values = {
                "event_type": "command_output",
                "event": line,
                "timestamp": now_iso(),
                "source": args.source,
                "command": args.command,
                "pid": proc.pid,
                "event_index": matched,
            }
            message = bounded_message(safe_format(args.message_template, values))
            log(event_record("event", source=args.source, command=args.command, pid=proc.pid, event=line, event_index=matched))
            payload = {
                "event_type": "command_output",
                "timestamp": values["timestamp"],
                "source": args.source,
                "event": line,
                "command": args.command,
                "pid": proc.pid,
                "event_index": matched,
                "message": message,
            }
            if dispatcher is not None:
                ok, callback_output = dispatcher(payload)
            elif args.callback_command:
                ok, callback_output = invoke_callback_command(
                    command=args.callback_command,
                    payload=payload,
                    cwd=args.cwd,
                    dry_run=args.dry_run,
                    timeout=max(0.001, min(30, args.timeout_ms / 1000 - (time.monotonic() - started))),
                )
            else:
                ok, callback_output = enqueue_codex(
                    thread=thread,
                    message=message,
                    codex_bin=args.codex_bin,
                    cwd=args.cwd,
                    dry_run=args.dry_run,
                    timeout=max(0.001, min(30, args.timeout_ms / 1000 - (time.monotonic() - started))),
                )
            log(
                event_record(
                    "callback",
                    source=args.source,
                    command=args.command,
                    pid=proc.pid,
                    event=line,
                    event_index=matched,
                    ok=ok,
                    message=message[:MAX_EVENT_CHARS],
                    output=callback_output[-MAX_EVENT_CHARS:] if callback_output else "",
                )
            )
            callback_failed = callback_failed or not ok
            if not ok and args.stop_on_callback_error:
                exit_reason = "callback_error"
                break
            if args.max_events and matched >= args.max_events:
                exit_reason = "max_events"
                break
    except KeyboardInterrupt:
        exit_reason = "cancelled"
    finally:
        stop.set()
        terminate_process(proc)
        if reader.ident is not None:
            reader.join(timeout=1)
        if not reader.is_alive():
            proc.stdout.close()

    return_code = proc.returncode
    log(
        event_record(
            "stopped",
            source=args.source,
            command=args.command,
            pid=proc.pid,
            reason=exit_reason,
            returncode=return_code,
            matched=matched,
            saw_eof=saw_eof,
        )
    )
    if callback_failed or exit_reason in {"callback_error", "monitor_error"} or (exit_reason == "completed" and return_code not in (0, None)):
        return 1
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    thread, pattern = validate(args, parser)
    with termination_signals():
        return run(args, thread, pattern)


if __name__ == "__main__":
    raise SystemExit(main())
