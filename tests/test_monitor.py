"""Behavior tests: real file events/callbacks and deterministic health clocks."""
import contextlib
import io
import json
import os
import queue
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from file_events import FileWatcher
from watchdog_monitor import HealthState, build_parser, gpu_values, main, process_worker
from monitor_callback import codex_executable, enqueue_codex


class HealthTests(unittest.TestCase):
    def health(self, **overrides):
        config = dict(enabled=["file_stalled", "gpu_low"], mode="all", started=0,
                      warmup_ms=0, stalled_ms=1000, gpu_threshold=10,
                      gpu_dwell_ms=1000, gpu_recover=20)
        config.update(overrides)
        return HealthState(**config)

    def test_all_requires_both_and_fires_once(self):
        state = self.health()
        state.gpu_sample(0, {"0": 2})
        self.assertIsNone(state.tick(1))
        state.gpu_sample(1, {"0": 2})
        self.assertEqual(state.tick(1)["status"], "suspected_stall")
        self.assertIsNone(state.tick(100))

    def test_any_recovers_only_when_every_active_condition_clears(self):
        state = self.health(mode="any")
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(1, {"0": 1})
        self.assertIsNotNone(state.tick(1))
        state.progress(1.1)
        self.assertIsNone(state.tick(1.1))  # GPU still low
        state.gpu_sample(1.2, {"0": 40})
        self.assertEqual(state.tick(1.2)["event_type"], "watchdog_recovered")
        self.assertIsNotNone(state.tick(2.2))  # subsequent file stall re-arms

    def test_all_recovery_and_rearm(self):
        state = self.health()
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(1, {"0": 1})
        state.tick(1)
        state.progress(1.1)
        self.assertEqual(state.tick(1.1)["event_type"], "watchdog_recovered")
        self.assertEqual(state.tick(2.2)["event_type"], "watchdog_stalled")

    def test_low_gpu_dwell_breaks_on_a_high_sample(self):
        state = self.health(enabled=["gpu_low"], stalled_ms=None)
        for at, value in [(0, 1), (0.9, 30), (1, 1), (1.9, 1)]:
            state.gpu_sample(at, {"0": value})
        self.assertIsNone(state.tick(1.9))
        state.gpu_sample(2.1, {"0": 1})
        self.assertIsNotNone(state.tick(2.1))

    def test_warmup_starts_fresh_timers(self):
        state = self.health(enabled=["file_stalled"], warmup_ms=2000)
        self.assertIsNone(state.tick(2.9))
        self.assertIsNotNone(state.tick(3.1))

    def test_gpu_hysteresis(self):
        state = self.health(enabled=["gpu_low"], stalled_ms=None)
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(1, {"0": 1})
        state.tick(1)
        state.gpu_sample(2, {"0": 15})
        self.assertIsNone(state.tick(2))
        state.gpu_sample(3, {"0": 21})
        self.assertEqual(state.tick(3)["status"], "recovered")

    def test_unknown_gpu_never_counts_as_dead_or_recovered(self):
        state = self.health()
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(1, {"0": 1})
        state.tick(1)
        state.gpu_unknown()
        self.assertIsNone(state.tick(20))
        state.gpu_sample(20, {"0": 1})
        self.assertIsNone(state.tick(20))
        state.gpu_sample(21, {"0": 1})
        self.assertIsNone(state.tick(21))
        state.gpu_sample(22, {"0": 50})
        self.assertEqual(state.tick(22)["event_type"], "watchdog_recovered")

    def test_multi_gpu_all_and_any(self):
        for mode, expected in [("all", False), ("any", True)]:
            state = self.health(enabled=["gpu_low"], stalled_ms=None, gpu_mode=mode)
            state.gpu_sample(0, {"0": 1, "1": 80})
            state.gpu_sample(1.1, {"0": 1, "1": 80})
            self.assertEqual(state.tick(1.1) is not None, expected)


class GpuTests(unittest.TestCase):
    def test_gpu_all_omits_invalid_all_selector(self):
        with patch("watchdog_monitor.run_owned", return_value=subprocess.CompletedProcess(
                [], 0, "0, GPU-first, 00000000:01:00.0, 5\n1, GPU-second, 00000000:02:00.0, 80\n", "")) as run:
            self.assertEqual(gpu_values("all"), {"0": 5.0, "1": 80.0})
            self.assertFalse(any(arg.startswith("--id=") for arg in run.call_args.args[0]))

    def test_invalid_metrics_are_unknown_not_zero(self):
        for raw in ["0, GPU-first, 00000000:01:00.0, N/A", "0, GPU-first, 00000000:01:00.0, nan",
                    "0, GPU-first, 00000000:01:00.0, 200", "", "invalid"]:
            with self.subTest(raw=raw), patch("watchdog_monitor.run_owned", return_value=subprocess.CompletedProcess([], 0, raw, "")):
                with self.assertRaises(ValueError):
                    gpu_values()


class FileTests(unittest.TestCase):
    def wait_change(self, events, path, changes):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            item = events.get(timeout=max(0.01, deadline - time.monotonic()))
            if item.get("kind") == "sensor_error":
                self.fail(str(item))
            if item.get("path") == str(path) and item.get("change") in changes:
                return item
        self.fail(f"missing {changes} on {path}")

    def test_directory_create_modify_rename_delete_and_close(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            events = queue.Queue()
            watcher = FileWatcher(root, False, events, recursive=True, pattern="*.ckpt").start()
            try:
                first, second = root / "模型.ckpt", root / "epoch2.ckpt"
                first.write_text("one", encoding="utf-8")
                self.wait_change(events, first, {"created"})
                first.write_text("two with more bytes", encoding="utf-8")
                self.wait_change(events, first, {"modified"})
                first.rename(second)
                self.wait_change(events, second, {"renamed_new", "created"})
                second.unlink()
                self.wait_change(events, second, {"deleted"})
                (root / "ignored.txt").write_text("ignored")
                time.sleep(0.1)
                self.assertFalse(any(item.get("path", "").endswith("ignored.txt") for item in list(events.queue)))
            finally:
                watcher.close()
            self.assertFalse(watcher.thread.is_alive())

    def test_missing_file_creation_with_snapshot_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "future.json"
            events = queue.Queue()
            watcher = FileWatcher(path, True, events, backend="polling", poll_ms=20).start()
            try:
                path.write_text("progress")
                self.wait_change(events, path, {"created"})
            finally:
                watcher.close()


class IntegrationTests(unittest.TestCase):
    def run_monitor(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            # emit in monitor_callback binds stdout at import time; watchdog
            # logs explicitly route it to the current stream for this test.
            with patch("watchdog_monitor.emit", lambda record: print(json.dumps(record))):
                code = main(["--codex-thread", "test-thread", "--dry-run", *args])
        return code, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_stall_calls_real_callback_with_unicode_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "metrics.json"
            path.write_text("step=1")
            callback, payload = root / "callback.py", root / "payload.json"
            callback.write_text("import sys,json,pathlib\np=json.load(sys.stdin)\npathlib.Path(sys.argv[1]).write_text(json.dumps(p,ensure_ascii=False),encoding='utf-8')\n", encoding="utf-8")
            argv = [sys.executable, str(callback), str(payload)]
            command = subprocess.list2cmdline(argv) if os.name == "nt" else shlex.join(argv)
            result = subprocess.run([sys.executable, str(SCRIPTS / "watchdog_monitor.py"),
                                     "--watch-file", str(path), "--stalled-for-ms", "150",
                                     "--watchdog-only", "--max-events", "1", "--timeout-ms", "3000",
                                     "--callback-command", command, "--message-template", "训练：{event_type}"],
                                    capture_output=True, text=True, encoding="utf-8", timeout=8)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            data = json.loads(payload.read_text(encoding="utf-8"))
            self.assertEqual(data["event_type"], "watchdog_stalled")
            self.assertEqual(data["event_index"], 1)
            self.assertIn("训练", data["message"])

    def test_monitored_training_survives_watchdog_expiry(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])
        try:
            code, records = self.run_monitor("--pid", str(child.pid), "--timeout-ms", "200")
            self.assertEqual(code, 0)
            self.assertIsNone(child.poll())
            self.assertEqual(records[-1]["reason"], "deadline")
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_process_exit_is_independent_of_all_heuristics(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(.5); raise SystemExit(7)"])
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "metrics.json"
                path.write_text("step=1")
                code, records = self.run_monitor("--pid", str(child.pid), "--watch-file", str(path),
                                                 "--stalled-for-ms", "2000", "--dead-if", "all",
                                                 "--watchdog-only", "--timeout-ms", "3000")
                self.assertEqual(code, 0)
                observed = [r for r in records if r.get("event_type") == "process_exit" and r["type"] == "event"]
                self.assertEqual(len(observed), 1)
                self.assertIn(observed[0]["status"], {"failed", "exited"})
        finally:
            child.wait(timeout=5)

    def test_gpu_failure_reports_once_even_watchdog_only(self):
        with patch("watchdog_monitor.gpu_values", side_effect=FileNotFoundError("missing provider")):
            code, records = self.run_monitor("--gpu-util-below", "10", "--watchdog-only",
                                             "--gpu-sample-ms", "20", "--timeout-ms", "150")
        self.assertEqual(code, 1)
        callbacks = [r for r in records if r["type"] == "event"]
        self.assertEqual([r["event_type"] for r in callbacks], ["monitor_error"])

    def test_callbacks_receive_simulated_gpu_alert_and_recovery(self):
        calls = []
        # Hold the simulated low state until its callback is observed. A fixed
        # three-sample sequence can recover before a busy consumer runs.
        with patch("watchdog_monitor.gpu_values", side_effect=lambda *a: {"0": 50 if calls else 1}), \
             patch("watchdog_monitor.enqueue_codex", side_effect=lambda **kw: (calls.append(kw) or True, "accepted")):
            code, records = self.run_monitor("--gpu-util-below", "10", "--gpu-below-for-ms", "15",
                                             "--gpu-sample-ms", "25", "--report-recovery", "--timeout-ms", "1000", "--max-events", "2")
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call["thread"] == "test-thread" for call in calls))
        self.assertEqual([r["event_type"] for r in records if r["type"] == "event"],
                         ["watchdog_stalled", "watchdog_recovered"])

    def test_deletion_does_not_reset_stall_and_atomic_replacement_does(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "metrics.json"
            path.write_text("old")
            progress_times, deleted_at = [], []
            start_watcher, note_progress = FileWatcher.start, HealthState.progress
            def start_when_ready(watcher):
                result = start_watcher(watcher)
                # Replace after the baseline snapshot, before health timing
                # starts. A scheduled worker can lose a 300 ms race on CI.
                temp = root / "temp.json"
                temp.write_text("step=2")
                os.replace(temp, path)
                return result
            def record_progress(state, now):
                note_progress(state, now)
                progress_times.append(now)
                # Delete only after the replacement reached the health state;
                # the following deletion must not reset its inactivity timer.
                path.unlink()
                deleted_at.append(time.monotonic())
            # Test health transitions with an explicit short snapshot
            # interval; native event delivery is covered by FileTests.
            with patch.object(FileWatcher, "start", start_when_ready), \
                 patch.object(HealthState, "progress", record_progress):
                code, records = self.run_monitor("--watch-file", str(path), "--stalled-for-ms", "300",
                                                 "--file-backend", "polling", "--poll-ms", "20",
                                                 "--watchdog-only", "--max-events", "1", "--timeout-ms", "3000")
            finished = time.monotonic()
            self.assertEqual(code, 0)
            self.assertEqual(len(progress_times), 1, "replacement must count as progress; deletion must not")
            self.assertTrue(deleted_at, "the test must delete the replaced file")
            # Older Windows Python versions use a coarse monotonic clock: two
            # ordered operations may have equal timestamps within one tick.
            self.assertLessEqual(progress_times[0], deleted_at[0])
            self.assertGreaterEqual(finished - progress_times[0], .29)
            self.assertEqual([r["event_type"] for r in records if r["type"] == "event"], ["watchdog_stalled"])

    def test_failed_callback_is_nonzero_and_stops(self):
        with patch("watchdog_monitor.gpu_values", return_value={"0": 0}), \
             patch("watchdog_monitor.enqueue_codex", return_value=(False, "rejected")):
            code, records = self.run_monitor("--gpu-util-below", "10", "--gpu-below-for-ms", "1",
                                             "--gpu-sample-ms", "5", "--stop-on-callback-error", "--timeout-ms", "500")
        self.assertEqual(code, 1)
        self.assertEqual(records[-1]["reason"], "callback_error")

    def test_native_single_file_publication_delivers_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.json"
            armed = threading.Event()
            real_start = FileWatcher.start
            def start_when_ready(watcher):
                result = real_start(watcher)
                armed.set()
                return result
            def publish_after_registration():
                if armed.wait(3):
                    path.write_text("step=1", encoding="utf-8")
            worker = threading.Thread(target=publish_after_registration)
            worker.start()
            try:
                with patch.object(FileWatcher, "start", start_when_ready):
                    code, records = self.run_monitor("--watch-file", str(path), "--timeout-ms", "3000",
                                                     "--max-events", "1")
            finally:
                worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(path.read_text(encoding="utf-8"), "step=1")
        self.assertEqual(code, 0)
        changes = [r for r in records if r.get("type") == "event" and r.get("event_type") == "file_change"]
        self.assertEqual(len(changes), 1, changes)
        self.assertEqual(changes[0]["path"], str(path))
        self.assertIn(changes[0]["change"], {"created", "modified"})
        self.assertEqual(records[-1]["reason"], "max_events")
        # Debounce semantics have deterministic burst/backlog regressions.
        # Native backends may replay the pre-registration create or deliver
        # separate writes more than 500 ms apart; neither implies a bug.

    def test_dry_run_never_spawns_codex(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch("monitor_callback.run_owned", side_effect=AssertionError("codex must not run")):
            code, records = self.run_monitor("--watch-file", str(Path(directory) / "heartbeat"),
                                             "--stalled-for-ms", "50", "--watchdog-only",
                                             "--max-events", "1", "--timeout-ms", "1000")
        self.assertEqual(code, 0)
        self.assertEqual(records[-1]["reason"], "max_events")
        self.assertEqual(len([record for record in records if record["type"] == "callback"]), 1)

    def test_codex_argv_preserves_event_as_data(self):
        message = '训练 & echo bad | $(secret) "quoted"'
        with patch("monitor_callback.run_owned", return_value=subprocess.CompletedProcess([], 0, "ok")) as run:
            ok, _ = enqueue_codex(thread="original-thread", message=message, codex_bin="codex-native",
                                  cwd=None, dry_run=False)
            self.assertTrue(ok)
            self.assertEqual(run.call_args.args[0], ["codex-native", "queue", "--thread=original-thread", f"--message={message}", "--resume"])
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_native_codex_resolution_on_this_host(self):
        if os.name == "nt" and os.environ.get("CODEX_MANAGED_PACKAGE_ROOT"):
            self.assertTrue(Path(codex_executable(None)).is_file())

    def test_queue_resume_warning_is_not_reported_as_wakeup_success(self):
        with patch("monitor_callback.run_owned", return_value=subprocess.CompletedProcess([], 0, "warning: failed to resume thread")):
            ok, diagnostic = enqueue_codex(thread="thread", message="event", codex_bin="codex-native", cwd=None, dry_run=False)
            self.assertFalse(ok)
            self.assertIn("failed to resume", diagnostic)


if __name__ == "__main__":
    unittest.main()
