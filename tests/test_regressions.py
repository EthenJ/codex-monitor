"""Failure paths and timing regressions from the pre-release review."""
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

import monitor_callback
import watchdog_monitor
from file_events import EventQueue, FileWatcher
from owned_process import run_owned
from watchdog_monitor import HealthState


def shell_command(argv):
    return subprocess.list2cmdline(argv) if os.name == "nt" else shlex.join(argv)


def capture(main, args):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = main(args)
    return result, [json.loads(line) for line in output.getvalue().splitlines()]


class CommandRegressions(unittest.TestCase):
    def run_source(self, source, *extra):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "source.py"
            script.write_text(source, encoding="utf-8")
            return capture(monitor_callback.main, ["--command", shell_command([sys.executable, "-u", str(script)]),
                                                   "--match", ".", "--codex-thread", "test-thread",
                                                   "--dry-run", "--timeout-ms", "2500", *extra])

    def test_callback_failure_without_stop_flag_returns_nonzero(self):
        with patch("monitor_callback.enqueue_codex", return_value=(False, "resume failed")):
            code, records = self.run_source("print('event')\n")
        self.assertEqual(code, 1)
        self.assertEqual(records[-1]["reason"], "completed")
        self.assertFalse(next(record for record in records if record["type"] == "callback")["ok"])

    def test_utf8_and_invalid_bytes_do_not_silently_end_the_reader(self):
        code, records = self.run_source("import sys\nsys.stdout.buffer.write('训练完成'.encode('utf-8') + b'\\xff\\n')\n")
        self.assertEqual(code, 0)
        event = next(record for record in records if record["type"] == "event")
        self.assertIn("训练完成", event["event"])
        self.assertIn("\ufffd", event["event"])

    def test_oversized_output_line_is_an_explicit_monitor_failure(self):
        code, records = self.run_source("print('x' * 20000)\n")
        self.assertEqual(code, 1)
        self.assertEqual(records[-1]["reason"], "monitor_error")
        self.assertTrue(any("exceeds" in record.get("error", "") for record in records))

    def test_custom_command_callback_has_event_type(self):
        with patch("monitor_callback.invoke_callback_command", return_value=(True, "ok")) as callback:
            code, _ = self.run_source("print('event')\n", "--callback-command", "unused")
        self.assertEqual(code, 0)
        self.assertEqual(callback.call_args.kwargs["payload"]["event_type"], "command_output")

    def test_command_lifetime_caps_a_slow_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.py"
            callback = Path(directory) / "callback.py"
            source.write_text("print('event', flush=True)\n", encoding="utf-8")
            callback.write_text("import time; time.sleep(20)\n", encoding="utf-8")
            started = time.monotonic()
            code, records = capture(monitor_callback.main, [
                "--command", shell_command([sys.executable, "-u", str(source)]), "--match", ".",
                "--callback-command", shell_command([sys.executable, str(callback)]), "--timeout-ms", "600"])
            self.assertLess(time.monotonic() - started, 4)
            self.assertEqual(code, 1)
            self.assertFalse(next(record for record in records if record["type"] == "callback")["ok"])

    def test_invalid_template_is_rejected_before_command_start(self):
        with patch("monitor_callback.start_process", side_effect=AssertionError("must validate first")), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                monitor_callback.main(["--command", "unused", "--match", ".", "--codex-thread", "test",
                                       "--message-template", "unclosed {"])

    def test_windows_shell_shim_cannot_receive_untrusted_argv(self):
        if os.name != "nt":
            self.skipTest("Windows shell shim")
        with patch("monitor_callback.run_owned", side_effect=AssertionError("must reject shim")):
            ok, diagnostic = monitor_callback.enqueue_codex(thread="test", message="& echo unsafe",
                codex_bin="codex.cmd", cwd=None, dry_run=False)
        self.assertFalse(ok)
        self.assertIn("native codex.exe", diagnostic)

    def test_long_codex_message_is_bounded(self):
        with patch("monitor_callback.run_owned", return_value=subprocess.CompletedProcess([], 0, "ok")) as run:
            ok, _ = monitor_callback.enqueue_codex(thread="test", message="训练" * 20000,
                codex_bin="codex-native", cwd=None, dry_run=False)
        self.assertTrue(ok)
        message_arg = next(argument for argument in run.call_args.args[0] if argument.startswith("--message="))
        self.assertLess(len(message_arg), 6120)
        self.assertIn("[truncated]", message_arg)


class ProcessRegressions(unittest.TestCase):
    def test_timeout_stops_callback_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "leaked"
            child = "import pathlib,time; time.sleep(1.5); pathlib.Path(" + repr(str(marker)) + ").touch()"
            parent = Path(directory) / "parent.py"
            parent.write_text("import subprocess,sys,time\nsubprocess.Popen([sys.executable, '-c', " + repr(child)
                              + "])\ntime.sleep(20)\n", encoding="utf-8")
            with self.assertRaises(subprocess.TimeoutExpired):
                run_owned(shell_command([sys.executable, str(parent)]), shell=True, timeout=0.5)
            time.sleep(1.6)
            self.assertFalse(marker.exists(), "a callback child survived timeout")

    def test_normal_callback_exit_stops_lingering_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "leaked"
            child = "import pathlib,time; time.sleep(1.5); pathlib.Path(" + repr(str(marker)) + ").touch()"
            source = "import subprocess,sys; subprocess.Popen([sys.executable, '-c', " + repr(child) + "])"
            result = run_owned([sys.executable, "-c", source], timeout=3)
            self.assertEqual(result.returncode, 0)
            time.sleep(1.6)
            self.assertFalse(marker.exists(), "a callback child survived its parent")


class WatchdogRegressions(unittest.TestCase):
    def test_event_limit_and_cancellation_leave_observed_pid_running(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])
        try:
            with tempfile.TemporaryDirectory() as directory:
                args = ["--pid", str(child.pid), "--watch-file", str(Path(directory) / "heartbeat"),
                        "--stalled-for-ms", "50", "--watchdog-only", "--codex-thread", "test",
                        "--dry-run", "--max-events", "1", "--timeout-ms", "2000"]
                code, records = capture(watchdog_monitor.main, args)
                self.assertEqual(code, 0)
                self.assertEqual(records[-1]["reason"], "max_events")
                self.assertIsNone(child.poll())
                with patch("watchdog_monitor.EventQueue.get", side_effect=KeyboardInterrupt):
                    code, records = capture(watchdog_monitor.main, args)
                self.assertEqual(code, 0)
                self.assertEqual(records[-1]["reason"], "cancelled")
                self.assertIsNone(child.poll())
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_watchdog_deadline_caps_a_slow_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            callback = Path(directory) / "callback.py"
            callback.write_text("import time; time.sleep(20)\n", encoding="utf-8")
            started = time.monotonic()
            code, records = capture(watchdog_monitor.main, [
                "--watch-file", str(Path(directory) / "heartbeat"), "--stalled-for-ms", "50",
                "--watchdog-only", "--callback-command", shell_command([sys.executable, str(callback)]),
                "--timeout-ms", "600"])
            self.assertEqual(code, 1)
            self.assertLess(time.monotonic() - started, 4)
            self.assertFalse(next(record for record in records if record["type"] == "callback")["ok"])

    def test_unknown_gpu_cannot_turn_file_recovery_into_a_healthy_edge(self):
        state = HealthState(["file_stalled", "gpu_low"], "any", 0, 0,
                            stalled_ms=1000, gpu_threshold=10, gpu_dwell_ms=1000, gpu_recover=20)
        state.gpu_unknown()
        self.assertEqual(state.tick(1)["event_type"], "watchdog_stalled")
        state.progress(1.1)
        self.assertIsNone(state.tick(1.1))
        state.gpu_sample(1.2, {"0": 50})
        self.assertEqual(state.tick(1.2)["event_type"], "watchdog_recovered")

    def test_unknown_gpu_followed_by_low_sample_is_not_a_recovery(self):
        state = HealthState(["gpu_low"], "all", 0, 0, gpu_threshold=10,
                            gpu_dwell_ms=1000, gpu_recover=20)
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(1, {"0": 1})
        self.assertEqual(state.tick(1)["event_type"], "watchdog_stalled")
        state.gpu_unknown()
        state.gpu_sample(2, {"0": 1})
        self.assertIsNone(state.tick(2))

    def test_queue_overflow_is_bounded_and_visible(self):
        events = EventQueue(maxsize=2)
        for number in range(100):
            events.put({"number": number})
        self.assertEqual(events.qsize(), 2)
        self.assertTrue(events.overflowed.is_set())

    def test_snapshot_root_removal_is_a_sensor_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "watched"
            root.mkdir()
            events = queue.Queue()
            watcher = FileWatcher(root, False, events, backend="polling", poll_ms=20).start()
            try:
                root.rmdir()
                error = events.get(timeout=2)
                self.assertEqual(error["kind"], "sensor_error")
                self.assertTrue(error["fatal"])
            finally:
                watcher.close()

    def run_events(self, items, callback=None, stalled_ms=None, start_delay=0, timeout_ms=350, max_events=0):
        class FakeWatcher:
            backend = "test"
            def __init__(self, path, is_file, events, **kwargs):
                self.events = events
            def start(self):
                time.sleep(start_delay)
                for item in items:
                    self.events.put(dict(kind="file_change", path="heartbeat", **item))
                return self
            def close(self):
                pass

        with tempfile.TemporaryDirectory() as directory, \
             patch("watchdog_monitor.FileWatcher", FakeWatcher), \
             patch("watchdog_monitor.enqueue_codex", side_effect=callback or (lambda **kwargs: (True, "ok"))):
            args = ["--watch-directory", directory, "--codex-thread", "test", "--timeout-ms", str(timeout_ms),
                    "--max-events", str(max_events), "--debounce-ms", "1000"]
            if stalled_ms:
                args.extend(["--stalled-for-ms", str(stalled_ms)])
            return capture(watchdog_monitor.main, args)

    def test_debounce_keeps_delete_and_recreate_events(self):
        code, records = self.run_events([{"change": change} for change in
                                        ["created", "modified", "deleted", "created", "modified"]])
        self.assertEqual(code, 0)
        changes = [record["change"] for record in records if record["type"] == "event"]
        self.assertEqual(changes, ["created", "deleted", "created"])

    def test_overflow_stops_watchdog_with_an_explicit_error(self):
        code, records = self.run_events([{"change": "created"}] * 1100)
        self.assertEqual(code, 1)
        self.assertEqual(records[-1]["reason"], "monitor_error")
        self.assertIn("queue overflow", next(record for record in records if record["type"] == "event")["error"])

    def test_directory_metadata_change_does_not_prove_training_progress(self):
        with patch("watchdog_monitor.HealthState.progress", side_effect=AssertionError("directory metadata is not progress")):
            code, records = self.run_events([{"change": "modified", "is_directory": True}], stalled_ms=50)
        self.assertEqual(code, 0)
        self.assertTrue(any(record.get("event_type") == "watchdog_stalled" for record in records))

    def test_inactivity_clock_starts_after_subscription_is_armed(self):
        code, records = self.run_events([], stalled_ms=100, start_delay=0.2)
        self.assertEqual(code, 0)
        started = next(record for record in records if record["type"] == "started")
        alert = next(record for record in records if record["type"] == "event")
        from datetime import datetime
        elapsed = datetime.fromisoformat(alert["timestamp"]) - datetime.fromisoformat(started["timestamp"])
        self.assertGreaterEqual(elapsed.total_seconds(), 0.09)

    def test_slow_callback_does_not_evaluate_stale_progress_before_queued_events(self):
        def slow_callback(**kwargs):
            time.sleep(0.1)
            return True, "ok"
        code, records = self.run_events([{"change": "created"}, {"change": "deleted"}, {"change": "modified"}],
                                       callback=slow_callback, stalled_ms=50, timeout_ms=3000, max_events=3)
        self.assertEqual(code, 0)
        self.assertEqual(records[-1]["reason"], "max_events")
        callbacks = [record for record in records if record["type"] == "event"]
        self.assertEqual([record["event_type"] for record in callbacks[:3]], ["file_change"] * 3)


if __name__ == "__main__":
    unittest.main()
