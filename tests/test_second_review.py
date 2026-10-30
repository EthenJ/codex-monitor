"""Concurrency, path-identity and old-runtime compatibility checks."""
import contextlib
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import monitor_callback
import watchdog_monitor
from file_events import FileWatcher
from owned_process import run_owned


class ProcessBoundaryTests(unittest.TestCase):
    def test_large_unread_callback_input_still_times_out(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            run_owned([sys.executable, "-c", "import time; time.sleep(2)"],
                      input="x" * 1000000, timeout=0.15)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_start_log_failure_still_cleans_up_owned_source(self):
        owned = []
        real_start = monitor_callback.start_process
        def start(*args):
            process = real_start(*args)
            owned.append(process)
            return process
        def fail_log(record):
            if record["type"] == "started":
                raise BrokenPipeError("log pipe closed")
        from test_regressions import shell_command
        try:
            with patch("monitor_callback.start_process", side_effect=start), \
                 patch("monitor_callback.emit", side_effect=fail_log):
                with self.assertRaises(BrokenPipeError):
                    monitor_callback.main(["--command", shell_command([sys.executable, "-c", "import time; time.sleep(10)"]),
                                           "--match", ".", "--codex-thread", "test", "--dry-run"])
            self.assertIsNotNone(owned[0].poll(), "log failure left the source running")
        finally:
            for process in owned:
                monitor_callback.terminate_process(process)


class WatchRootTests(unittest.TestCase):
    def test_replacing_watch_root_is_not_silent(self):
        for backend in ("native", "polling") if os.name == "nt" else ("polling",):
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as directory:
                parent = Path(directory).resolve()
                root, moved = parent / "watched", parent / "moved"
                root.mkdir()
                events = queue.Queue()
                watcher = FileWatcher(root, False, events, backend=backend, poll_ms=20).start()
                try:
                    self.assertEqual(root.parent, moved.parent)
                    root.rename(moved)
                    root.mkdir()
                    deadline = time.monotonic() + 2
                    errors = []
                    while time.monotonic() < deadline:
                        try:
                            item = events.get(timeout=0.1)
                        except queue.Empty:
                            continue
                        if item.get("kind") == "sensor_error":
                            errors.append(item)
                            break
                    self.assertTrue(errors, "watcher silently kept observing a replaced directory")
                finally:
                    watcher.close()


class BacklogTests(unittest.TestCase):
    def test_debounce_uses_observation_time_not_callback_delivery_time(self):
        class FakeWatcher:
            backend = "test"
            def __init__(self, path, is_file, events, **kwargs):
                self.events = events
            def start(self):
                now = time.monotonic()
                for observed in (now - 5, now - 3):
                    self.events.put({"kind": "file_change", "change": "modified", "path": "metrics",
                                     "at": observed})
                return self
            def close(self):
                pass
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(output), \
             patch("watchdog_monitor.FileWatcher", FakeWatcher):
            result = watchdog_monitor.main(["--watch-directory", directory, "--codex-thread", "test",
                                            "--dry-run", "--debounce-ms", "500", "--timeout-ms", "150"])
        self.assertEqual(result, 0)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        callbacks = [record for record in records if record["type"] == "callback"]
        self.assertEqual(len(callbacks), 2, "distinct writes were merged while draining a backlog")


if __name__ == "__main__":
    unittest.main()
