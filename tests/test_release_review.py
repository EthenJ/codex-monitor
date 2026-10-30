"""CLI parsing, cancellation and backend failure checks before publication."""
import contextlib
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import monitor_callback
import watchdog_monitor
from file_events import FileWatcher
from owned_process import run_owned


class CliBoundaryTests(unittest.TestCase):
    def test_option_like_message_is_passed_as_a_value(self):
        with patch("monitor_callback.run_owned", return_value=subprocess.CompletedProcess([], 0, "queued")) as run:
            ok, _ = monitor_callback.enqueue_codex(thread="--unusual-name", message="--help",
                codex_bin="codex-native", cwd=None, dry_run=False)
        self.assertTrue(ok)
        self.assertIn("--message=--help", run.call_args.args[0])
        self.assertIn("--thread=--unusual-name", run.call_args.args[0])


class CancellationTests(unittest.TestCase):
    def test_large_callback_output_is_drained_and_bounded(self):
        result = run_owned([sys.executable, "-c",
                            "import sys; sys.stdout.write('x' * 12000000 + 'DONE'); sys.stdout.flush()"], timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertLessEqual(len(result.stdout), 65536)
        self.assertTrue(result.stdout.endswith("DONE"))
        self.assertFalse(any(thread.name == "callback-output" for thread in threading.enumerate()))

    def test_hanging_gpu_query_does_not_delay_watchdog_expiry(self):
        entered = threading.Event()
        def hanging_query(gpu_id, binary, stop):
            entered.set()
            run_owned([sys.executable, "-c", "import time; time.sleep(20)"], timeout=10, stop_event=stop)
            return {"0": 1}
        started = time.monotonic()
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch("watchdog_monitor.gpu_values", side_effect=hanging_query):
            code = watchdog_monitor.main(["--gpu-util-below", "10", "--codex-thread", "test",
                                          "--dry-run", "--timeout-ms", "200"])
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(entered.is_set())
        self.assertEqual(code, 0)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(records[-1]["reason"], "deadline")


class BackendFailureTests(unittest.TestCase):
    def test_missing_optional_dependency_falls_back_only_in_auto_mode(self):
        import file_events
        platform = types.SimpleNamespace(name="posix", path=os.path)
        with tempfile.TemporaryDirectory() as directory, patch.object(file_events, "os", platform), \
             patch.object(FileWatcher, "_watchdog", side_effect=ImportError("not installed")):
            path = Path(directory).resolve() / "heartbeat"
            events = queue.Queue()
            watcher = FileWatcher(path, True, events, backend="auto", poll_ms=20).start()
            try:
                self.assertEqual(watcher.backend, "snapshot-fallback")
                path.write_text("progress", encoding="utf-8")
                self.assertEqual(events.get(timeout=2)["change"], "created")
            finally:
                watcher.close()
            with self.assertRaisesRegex(RuntimeError, "native file events need"):
                FileWatcher(path, True, events, backend="native").start()

    def test_failed_observer_start_preserves_original_error_and_cleans_up(self):
        instances = []
        class Observer:
            ident = None
            def __init__(self):
                self.stopped = False
                instances.append(self)
            def schedule(self, *args, **kwargs):
                pass
            def start(self):
                raise OSError("subscription limit reached")
            def stop(self):
                self.stopped = True
            def join(self, timeout=None):
                raise RuntimeError("cannot join thread before it is started")
        events_module = types.ModuleType("watchdog.events")
        events_module.FileSystemEventHandler = object
        observers_module = types.ModuleType("watchdog.observers")
        observers_module.Observer = Observer
        modules = {"watchdog": types.ModuleType("watchdog"), "watchdog.events": events_module,
                   "watchdog.observers": observers_module}
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules):
            watcher = FileWatcher(Path(directory).resolve(), False, None)
            with self.assertRaisesRegex(OSError, "subscription limit reached"):
                try:
                    watcher._watchdog()
                finally:
                    watcher.close()
        self.assertTrue(instances[0].stopped)

    def test_unexpected_gpu_worker_failure_is_reported(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch("watchdog_monitor.gpu_values", side_effect=KeyError("provider bug")):
            code = watchdog_monitor.main(["--gpu-util-below", "10", "--codex-thread", "test",
                                          "--dry-run", "--timeout-ms", "1000"])
        self.assertEqual(code, 1)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(records[-1]["reason"], "sensor_error")
        self.assertTrue(any(record.get("sensor") == "gpu" and record.get("event_type") == "monitor_error"
                            for record in records))


if __name__ == "__main__":
    unittest.main()
