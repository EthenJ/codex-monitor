"""Cancellation races, deadlines and exhaustive small GPU state sequences."""
import itertools
import contextlib
import io
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import monitor_callback
import owned_process
import watchdog_monitor
from file_events import FileWatcher
from test_regressions import capture, shell_command
from watchdog_monitor import HealthState


class ExhaustiveHealthTests(unittest.TestCase):
    def test_two_gpu_dwell_and_hysteresis_sequences(self):
        # Independent oracle: a card qualifies when every value in its last
        # three consecutive samples is low. Test all four-sample sequences
        # with low/band/high readings on each of two cards, for both modes.
        readings = list(itertools.product((5, 10, 20), repeat=2))
        for mode in ("all", "any"):
            for sequence in itertools.product(readings, repeat=4):
                state = HealthState(["gpu_low"], "all", 0, 0, gpu_threshold=10,
                                    gpu_dwell_ms=2000, gpu_recover=20, gpu_mode=mode)
                alert = False
                for at, values in enumerate(sequence):
                    previous = alert
                    if mode == "all":
                        if any(value >= 20 for value in values):
                            alert = False
                        elif at >= 2 and all(value < 10 for pair in sequence[at-2:at+1] for value in pair):
                            alert = True
                    else:
                        if all(value >= 20 for value in values):
                            alert = False
                        elif at >= 2 and any(all(pair[card] < 10 for pair in sequence[at-2:at+1]) for card in (0, 1)):
                            alert = True
                    state.gpu_sample(at, dict(zip(("0", "1"), values)))
                    event = state.tick(at)
                    expected = ("watchdog_stalled" if alert else "watchdog_recovered") if alert != previous else None
                    self.assertEqual(event["event_type"] if event else None, expected, (mode, sequence, at))

    def test_file_gpu_all_any_truth_table(self):
        for mode, file_stalled, gpu_low in itertools.product(("all", "any"), (False, True), (False, True)):
            state = HealthState(["file_stalled", "gpu_low"], mode, 0, 0,
                                stalled_ms=1000, gpu_threshold=10, gpu_dwell_ms=1000)
            state.gpu_sample(0, {"0": 0 if gpu_low else 100})
            state.gpu_sample(1, {"0": 0 if gpu_low else 100})
            if not file_stalled:
                state.progress(1)
            event = state.tick(1)
            self.assertEqual(event is not None, (file_stalled and gpu_low) if mode == "all" else (file_stalled or gpu_low))

    def test_unknown_never_proves_recovery_across_modes(self):
        for dead_if, gpu_match in itertools.product(("all", "any"), repeat=2):
            state = HealthState(["file_stalled", "gpu_low"], dead_if, 0, 0,
                                stalled_ms=1000, gpu_threshold=10, gpu_dwell_ms=1000,
                                gpu_recover=20, gpu_mode=gpu_match)
            state.gpu_sample(0, {"0": 0, "1": 0})
            state.gpu_sample(1, {"0": 0, "1": 0})
            self.assertEqual(state.tick(1)["event_type"], "watchdog_stalled")
            state.gpu_unknown()
            state.progress(1.1)
            self.assertIsNone(state.tick(1.1))
            state.gpu_sample(1.2, {"0": 0, "1": 0})
            self.assertIsNone(state.tick(1.2))
            state.gpu_sample(1.3, {"0": 100, "1": 100})
            self.assertEqual(state.tick(1.3)["event_type"], "watchdog_recovered")

    def test_zero_and_hundred_thresholds_and_equality(self):
        zero = HealthState(["gpu_low"], "all", 0, 0, gpu_threshold=0, gpu_dwell_ms=1000)
        zero.gpu_sample(0, {"0": 0})
        zero.gpu_sample(2, {"0": 0})
        self.assertIsNone(zero.tick(2))
        full = HealthState(["gpu_low"], "all", 0, 0, gpu_threshold=100, gpu_dwell_ms=1000)
        full.gpu_sample(0, {"0": 99})
        full.gpu_sample(1, {"0": 99})
        self.assertEqual(full.tick(1)["event_type"], "watchdog_stalled")
        full.gpu_sample(2, {"0": 100})
        self.assertEqual(full.tick(2)["event_type"], "watchdog_recovered")

    def test_gpu_warmup_never_contributes_to_dwell(self):
        state = HealthState(["gpu_low"], "all", 0, 2000, gpu_threshold=10, gpu_dwell_ms=1000)
        state.gpu_sample(0, {"0": 0})
        state.gpu_sample(1.9, {"0": 0})
        state.gpu_sample(2, {"0": 0})
        self.assertIsNone(state.tick(2.9))
        state.gpu_sample(3, {"0": 0})
        self.assertEqual(state.tick(3)["event_type"], "watchdog_stalled")


class CliBoundaryTests(unittest.TestCase):
    def test_invalid_timing_and_combinations_start_no_workers(self):
        cases = [["--timeout-ms", "0"], ["--poll-ms", "0"], ["--gpu-sample-ms", "0"],
                 ["--gpu-below-for-ms", "0"], ["--pid", "0"], ["--max-events", "-1"],
                 ["--debounce-ms", "-1"], ["--warmup-ms", "-1"],
                 ["--warmup-ms", "1000", "--timeout-ms", "1000"],
                 ["--stalled-for-ms", "10"], ["--gpu-recover-above", "9"],
                 ["--message-template", "{event.__class__}"]]
        for args in cases:
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), \
                 patch("watchdog_monitor.run", side_effect=AssertionError("must reject before observation")):
                with self.assertRaises(SystemExit) as error:
                    watchdog_monitor.main(["--gpu-util-below", "10", "--codex-thread", "test", *args])
                self.assertEqual(error.exception.code, 2)

    def test_invalid_command_options_do_not_spawn_work(self):
        for args in (["--timeout-ms", "0"], ["--max-events", "-1"], ["--debounce-ms", "-1"],
                     ["--match", "["], ["--encoding", "nonexistent-codec"], ["--message-template", "{event!r}"]):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), \
                 patch("monitor_callback.start_process", side_effect=AssertionError("must validate first")):
                with self.assertRaises(SystemExit) as error:
                    monitor_callback.main(["--command", "unused", "--match", ".", "--codex-thread", "test", *args])
                self.assertEqual(error.exception.code, 2)


class StartupCleanupTests(unittest.TestCase):
    def test_command_reader_construction_failure_stops_source(self):
        processes = []
        real_start = monitor_callback.start_process
        def start(*args):
            proc = real_start(*args)
            processes.append(proc)
            return proc
        with patch("monitor_callback.start_process", side_effect=start), \
             patch("monitor_callback.threading.Thread", side_effect=RuntimeError("reader initialization failed")):
            with self.assertRaisesRegex(RuntimeError, "reader initialization failed"):
                monitor_callback.main(["--command", shell_command([sys.executable, "-c", "import time; time.sleep(20)"]),
                                       "--match", ".", "--codex-thread", "test", "--dry-run"])
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)

    def test_callback_reader_construction_failure_stops_process_and_closes_pipe(self):
        processes = []
        real_start = owned_process.start_owned
        def start(*args, **kwargs):
            proc = real_start(*args, **kwargs)
            processes.append(proc)
            return proc
        with patch("owned_process.start_owned", side_effect=start), \
             patch("owned_process.threading.Thread", side_effect=RuntimeError("reader initialization failed")):
            with self.assertRaisesRegex(RuntimeError, "reader initialization failed"):
                owned_process.run_owned([sys.executable, "-c", "import time; time.sleep(20)"])
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)

    def test_interrupted_file_subscription_closes_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            watcher = FileWatcher(Path(directory), False, queue.Queue(), backend="polling", poll_ms=20)
            try:
                with patch.object(watcher.ready, "wait", side_effect=KeyboardInterrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        watcher.start()
                self.assertTrue(watcher.stop.is_set())
                self.assertFalse(watcher.thread.is_alive())
            finally:
                watcher.close()

    def test_cancelled_watcher_start_is_still_closed_by_watchdog(self):
        watcher = Mock()
        watcher.start.side_effect = KeyboardInterrupt
        with tempfile.TemporaryDirectory() as directory, patch("watchdog_monitor.FileWatcher", return_value=watcher):
            code, records = capture(watchdog_monitor.main, ["--watch-directory", directory,
                                                           "--codex-thread", "test", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(records[-1]["reason"], "cancelled")
        watcher.close.assert_called_once()

    def test_worker_start_failure_keeps_original_diagnostic(self):
        worker = Mock(ident=None)
        worker.start.side_effect = RuntimeError("thread resources exhausted")
        with patch("watchdog_monitor.threading.Thread", return_value=worker):
            code, records = capture(watchdog_monitor.main, ["--gpu-util-below", "10", "--codex-thread", "test", "--dry-run"])
        self.assertEqual(code, 1)
        self.assertEqual(records[-1]["reason"], "monitor_error")
        self.assertIn("thread resources exhausted", next(r for r in records if r["type"] == "event")["error"])
        worker.join.assert_not_called()

    def test_watcher_cleanup_failure_does_not_skip_worker_cleanup(self):
        watcher = Mock(backend="test")
        watcher.close.side_effect = OSError("observer stop failed")
        worker = Mock(ident=123)
        worker.is_alive.return_value = False
        with tempfile.TemporaryDirectory() as directory, patch("watchdog_monitor.FileWatcher", return_value=watcher), \
             patch("watchdog_monitor.threading.Thread", return_value=worker):
            code, records = capture(watchdog_monitor.main, ["--watch-directory", directory, "--gpu-util-below", "10",
                                                           "--codex-thread", "test", "--dry-run", "--timeout-ms", "1"])
        self.assertEqual(code, 1)
        worker.join.assert_called_once()
        self.assertIn("observer stop failed", records[-1]["cleanup_errors"][0])

    def test_file_close_joins_thread_even_when_observer_stop_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            watcher = FileWatcher(Path(directory), False, queue.Queue())
            watcher.observer = Mock(ident=123)
            watcher.observer.stop.side_effect = OSError("stop failed")
            watcher.thread = Mock(ident=456)
            with self.assertRaisesRegex(OSError, "stop failed"):
                watcher.close()
            watcher.observer.join.assert_called_once()
            watcher.thread.join.assert_called_once()

    def test_observer_created_after_cancel_is_still_cleaned_up(self):
        with tempfile.TemporaryDirectory() as directory:
            watcher = FileWatcher(Path(directory), False, queue.Queue())
            entered = threading.Event()
            observer = Mock(ident=None)
            def late_observer():
                entered.set()
                watcher.stop.wait(2)
                watcher.observer = observer
            with patch.object(watcher, "_watchdog", side_effect=late_observer), \
                 patch.object(watcher, "_windows", side_effect=late_observer):
                try:
                    watcher.thread.start()
                    self.assertTrue(entered.wait(2))
                finally:
                    watcher.close()
            self.assertFalse(watcher.thread.is_alive())
            self.assertTrue(observer.stop.called)

    @unittest.skipIf(os.name == "nt", "POSIX process groups")
    def test_interrupted_owned_start_cleans_group_after_leader_exit(self):
        class InterruptedProcess:
            pid = 1234
            @property
            def monitor_job(self):
                return None
            @monitor_job.setter
            def monitor_job(self, value):
                raise KeyboardInterrupt
        process = InterruptedProcess()
        with patch("owned_process.subprocess.Popen", return_value=process), patch("owned_process.stop_owned") as stop:
            with self.assertRaises(KeyboardInterrupt):
                owned_process.start_owned(["unused"])
        stop.assert_called_once_with(process)


class DeadlineTests(unittest.TestCase):
    def test_command_wait_is_bounded_by_remaining_lifetime(self):
        process = Mock(pid=1234, returncode=0)
        events = Mock()
        events.get.side_effect = queue.Empty
        worker = Mock(ident=None)
        with patch("monitor_callback.start_process", return_value=process), \
             patch("monitor_callback.terminate_process"), patch("monitor_callback.threading.Thread", return_value=worker), \
             patch("monitor_callback.queue.Queue", return_value=events), \
             patch("monitor_callback.time.monotonic", side_effect=[0, 0, .002]):
            code, records = capture(monitor_callback.main, ["--command", "unused", "--match", ".",
                                                           "--codex-thread", "test", "--dry-run", "--timeout-ms", "1"])
        self.assertEqual(code, 0)
        self.assertLessEqual(events.get.call_args.kwargs["timeout"], .001)
        self.assertEqual(records[-1]["reason"], "deadline")

    def test_late_output_does_not_trigger_a_callback(self):
        process = Mock(pid=1234, returncode=0)
        events = Mock()
        events.get.return_value = ("line", "late event")
        worker = Mock(ident=None)
        with patch("monitor_callback.start_process", return_value=process), \
             patch("monitor_callback.terminate_process"), patch("monitor_callback.threading.Thread", return_value=worker), \
             patch("monitor_callback.queue.Queue", return_value=events), \
             patch("monitor_callback.time.monotonic", side_effect=[0, 0, .002]), \
             patch("monitor_callback.enqueue_codex") as callback:
            code, records = capture(monitor_callback.main, ["--command", "unused", "--match", ".",
                                                           "--codex-thread", "test", "--dry-run", "--timeout-ms", "1"])
        self.assertEqual(code, 0)
        self.assertEqual(records[-1]["matched"], 0)
        callback.assert_not_called()


class CallbackInputTests(unittest.TestCase):
    def test_nul_output_is_a_callback_failure_with_final_diagnostic(self):
        source = "import sys; sys.stdout.write('event\\x00text\\n')"
        code, records = capture(monitor_callback.main, ["--command", shell_command([sys.executable, "-c", source]),
                                                       "--match", ".", "--codex-thread", "test", "--codex-bin", sys.executable,
                                                       "--timeout-ms", "3000"])
        self.assertEqual(code, 1)
        callback = next(r for r in records if r["type"] == "callback")
        self.assertFalse(callback["ok"])
        self.assertIn("null", callback["output"].lower())
        self.assertEqual(records[-1]["type"], "stopped")

    def test_invalid_callback_command_is_reported_as_failure(self):
        ok, diagnostic = monitor_callback.invoke_callback_command(
            command="bad\x00command", payload={"event": "test"}, cwd=None, dry_run=False)
        self.assertFalse(ok)
        self.assertIn("null", diagnostic.lower())


class SnapshotFailureTests(unittest.TestCase):
    def test_unreadable_child_is_an_error_instead_of_a_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            child = root / "checkpoints"
            child.mkdir()
            (child / "epoch.ckpt").write_text("data")
            watcher = FileWatcher(root, False, queue.Queue(), backend="polling", recursive=True)
            watcher.root_identity = (root.stat().st_dev, root.stat().st_ino)
            self.assertIn(str(child / "epoch.ckpt"), watcher._snapshot())
            scandir = os.scandir
            def scan(path):
                if Path(path) == child:
                    raise PermissionError("checkpoint directory became inaccessible")
                return scandir(path)
            with patch("file_events.os.scandir", side_effect=scan):
                with self.assertRaisesRegex(PermissionError, "inaccessible"):
                    watcher._snapshot()

    def test_snapshot_scan_honors_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            watcher = FileWatcher(root, False, queue.Queue(), backend="polling", recursive=True)
            watcher.root_identity = (root.stat().st_dev, root.stat().st_ino)
            watcher.stop.set()
            with patch("file_events.os.scandir", side_effect=AssertionError("must not enumerate after cancellation")):
                self.assertEqual(watcher._snapshot(), {})


@unittest.skipUnless(os.name == "posix", "POSIX symlinks")
class FileSymlinkTests(unittest.TestCase):
    def wait_for(self, events, path, changes):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            item = events.get(timeout=max(.01, deadline - time.monotonic()))
            self.assertNotEqual(item["kind"], "sensor_error", item)
            if item["path"] == str(path) and item["change"] in changes:
                return item
        self.fail(f"missing change on {path}")

    def test_auto_follows_leaf_symlink_writes_retargets_and_recreation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first, second, link = root / "first", root / "second", root / "link"
            first.write_text("a")
            second.write_text("bigger")
            link.symlink_to(first)
            events = queue.Queue()
            watcher = FileWatcher(link, True, events, backend="auto", poll_ms=10).start()
            try:
                self.assertEqual(watcher.backend, "snapshot-fallback")
                first.write_text("updated target")
                self.wait_for(events, link, {"modified"})
                link.unlink()
                link.symlink_to(second)
                self.wait_for(events, link, {"modified", "created"})
                second.unlink()
                self.wait_for(events, link, {"deleted"})
                second.write_text("restored")
                self.wait_for(events, link, {"created"})
            finally:
                watcher.close()

    def test_native_rejects_leaf_symlink_with_actionable_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            link = root / "link"
            link.symlink_to(root / "future-target")
            watcher = FileWatcher(link, True, queue.Queue(), backend="native")
            with self.assertRaisesRegex(RuntimeError, "file symlink.*polling"):
                watcher.start()
            self.assertFalse(watcher.thread.is_alive())

    def test_native_detects_file_becoming_a_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "metrics"
            watcher = FileWatcher(path, True, queue.Queue())
            watcher.root_identity = (root.stat().st_dev, root.stat().st_ino)
            watcher.backend = "watchdog"
            path.symlink_to(root / "elsewhere")
            with self.assertRaisesRegex(RuntimeError, "became a symlink"):
                watcher._check_root()

    def test_root_alias_is_resolved_when_subscription_is_armed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first, second, alias = root / "first", root / "second", root / "alias"
            first.mkdir()
            second.mkdir()
            alias.symlink_to(first, target_is_directory=True)
            events = queue.Queue()
            watcher = FileWatcher(alias, False, events, backend="auto", poll_ms=10)
            alias.unlink()
            alias.symlink_to(second, target_is_directory=True)
            watcher.start()
            try:
                self.assertEqual(watcher.resolved_root, second)
                (second / "checkpoint").write_text("progress")
                self.wait_for(events, alias / "checkpoint", {"created"})
            finally:
                watcher.close()


if __name__ == "__main__":
    unittest.main()
