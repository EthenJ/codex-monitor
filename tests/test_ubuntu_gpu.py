"""GPU selection/timing regressions and real POSIX lifecycle checks."""
import contextlib
import errno
import io
import json
import os
import queue
import select
import signal
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
from owned_process import termination_signals
from watchdog_monitor import HealthState, gpu_values, main, process_worker
from test_regressions import shell_command


GPU0 = "0, GPU-first, 00000000:01:00.0, 5\n"
GPU1 = "1, GPU-second, 00000000:02:00.0, 80\n"


class GpuSelectionTests(unittest.TestCase):
    def sample(self, output, selection="all"):
        with patch("watchdog_monitor.run_owned", return_value=subprocess.CompletedProcess([], 0, output)):
            return gpu_values(selection)

    def test_every_requested_gpu_must_be_present(self):
        for selection in ("0,999", "GPU-first,GPU-missing", "0000:01:00.0,0000:03:00.0"):
            with self.subTest(selection=selection), self.assertRaisesRegex(ValueError, "missing"):
                self.sample(GPU0, selection)

    def test_index_uuid_pci_and_duplicate_aliases(self):
        for selection in ("0,1", "GPU-first,GPU-second", "0000:01:00.0,00000000:02:00.0",
                          " 0 , GPU-second ", "0,GPU-first,0,1"):
            with self.subTest(selection=selection):
                self.assertEqual(self.sample(GPU0 + GPU1, selection), {"0": 5, "1": 80})

    def test_empty_and_mixed_all_selections_fail_before_sampling(self):
        for selection in ("", " ", "0,", ",0", "0,,1", "all,0"):
            with self.subTest(selection=selection), contextlib.redirect_stderr(io.StringIO()), \
                 patch("watchdog_monitor.run", side_effect=AssertionError("must validate first")):
                with self.assertRaises(SystemExit) as error:
                    main(["--gpu-util-below", "10", "--gpu-id", selection, "--codex-thread", "test"])
                self.assertEqual(error.exception.code, 2)

    def test_invalid_rows_cannot_supply_partial_health(self):
        for output in (GPU0 + GPU0, GPU0 + "invalid", ", GPU-first, 0000:01:00.0, 5",
                       "0, , 0000:01:00.0, 5", "x, GPU-first, 0000:01:00.0, 5",
                       GPU0.replace(", 5", ", -1"), GPU0.replace(", 5", ", inf")):
            with self.subTest(output=output), self.assertRaises(ValueError):
                self.sample(output)

    def test_nonzero_provider_status_never_supplies_health(self):
        with patch("watchdog_monitor.run_owned", return_value=subprocess.CompletedProcess([], 1, GPU0)):
            with self.assertRaises(RuntimeError):
                gpu_values()

    def test_invalid_thresholds_fail_before_start(self):
        for option, value in (("--gpu-util-below", "nan"), ("--gpu-util-below", "inf"),
                              ("--gpu-recover-above", "nan"), ("--gpu-recover-above", "9")):
            with self.subTest(option=option, value=value), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    main(["--gpu-util-below", "10", option, value, "--codex-thread", "test"])


class MultiGpuTimingTests(unittest.TestCase):
    def state(self, mode="any"):
        return HealthState(["gpu_low"], "all", 0, 0, gpu_threshold=10,
                           gpu_dwell_ms=1000, gpu_recover=20, gpu_mode=mode)

    def test_alternating_cards_do_not_accumulate_any_dwell(self):
        state = self.state()
        for at, values in ((0, {"0": 1, "1": 80}), (.6, {"0": 80, "1": 1}),
                           (1.1, {"0": 1, "1": 80}), (1.6, {"0": 80, "1": 1})):
            state.gpu_sample(at, values)
            self.assertIsNone(state.tick(at))
        state.gpu_sample(2.7, {"0": 80, "1": 1})
        self.assertEqual(state.tick(2.7)["event_type"], "watchdog_stalled")

    def test_all_dwell_starts_when_last_card_becomes_low(self):
        state = self.state("all")
        state.gpu_sample(0, {"0": 1, "1": 80})
        state.gpu_sample(.6, {"0": 1, "1": 1})
        state.gpu_sample(1.1, {"0": 1, "1": 1})
        self.assertIsNone(state.tick(1.1))
        state.gpu_sample(1.7, {"0": 1, "1": 1})
        self.assertEqual(state.tick(1.7)["event_type"], "watchdog_stalled")

    def test_changed_device_set_restarts_dwell(self):
        state = self.state("all")
        state.gpu_sample(0, {"0": 1, "1": 1})
        state.gpu_sample(1.1, {"0": 1})
        self.assertIsNone(state.tick(1.1))
        state.gpu_sample(2.2, {"0": 1})
        self.assertEqual(state.tick(2.2)["event_type"], "watchdog_stalled")

    def test_empty_sample_is_unknown_and_breaks_dwell(self):
        state = self.state()
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(.8, {})
        self.assertIsNone(state.tick(1.1))
        state.gpu_sample(2, {"0": 1})
        self.assertIsNone(state.tick(2))
        state.gpu_sample(3.1, {"0": 1})
        self.assertIsNotNone(state.tick(3.1))

    def test_evidence_uses_latest_utilization(self):
        state = self.state()
        state.gpu_sample(0, {"0": 1})
        state.gpu_sample(1.1, {"0": 2})
        state.tick(1.1)
        state.gpu_sample(2, {"0": 8})
        self.assertEqual(state.active["gpu_low"]["utilization"], {"0": 8})

    def test_any_hysteresis_requires_every_card_to_recover(self):
        state = self.state()
        state.gpu_sample(0, {"0": 1, "1": 1})
        state.gpu_sample(1.1, {"0": 1, "1": 1})
        state.tick(1.1)
        state.gpu_sample(2, {"0": 20, "1": 15})
        self.assertIsNone(state.tick(2))
        state.gpu_sample(3, {"0": 20, "1": 20})
        self.assertEqual(state.tick(3)["event_type"], "watchdog_recovered")


class GpuOutageTests(unittest.TestCase):
    def test_alert_outage_low_and_recovery_do_not_duplicate_alert(self):
        delivered = []
        low_samples = 0

        def sample(*args):
            nonlocal low_samples
            if delivered == ["watchdog_stalled"]:
                raise OSError("temporary provider outage")
            if "monitor_error" in delivered:
                low_samples += 1
                return {"0": 1 if low_samples <= 5 else 50}
            return {"0": 1}

        def callback(**kwargs):
            delivered.append(kwargs["payload"]["event_type"])
            return True, "ok"

        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch("watchdog_monitor.gpu_values", side_effect=sample), \
             patch("watchdog_monitor.invoke_callback_command", side_effect=callback):
            code = main(["--gpu-util-below", "10", "--gpu-recover-above", "20", "--gpu-below-for-ms", "30",
                         "--gpu-sample-ms", "20", "--report-recovery", "--max-events", "3",
                         "--callback-command", "unused", "--timeout-ms", "5000"])
        self.assertEqual(code, 0)
        self.assertEqual(delivered, ["watchdog_stalled", "monitor_error", "watchdog_recovered"])
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(sum(record["type"] == "sensor_recovered" for record in records), 1)
        self.assertEqual(records[-1]["unavailable_sensors"], [])


@unittest.skipUnless(os.name == "posix", "Linux pidfd fallback adapter")
class PidfdFallbackTests(unittest.TestCase):
    def test_unavailable_syscall_uses_psutil_without_touching_process(self):
        try:
            import psutil  # noqa: F401
        except ImportError:
            self.skipTest("optional psutil not installed")
        for error in (errno.ENOSYS, errno.EINVAL, errno.EPERM, errno.EACCES):
            with self.subTest(errno=error), patch("watchdog_monitor.os.pidfd_open", create=True,
                                                 side_effect=OSError(error, "unavailable")):
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(.15)"])
                try:
                    events, stop, ready = queue.Queue(), threading.Event(), threading.Event()
                    worker = threading.Thread(target=process_worker, args=(child.pid, events, stop, ready))
                    worker.start()
                    self.assertTrue(ready.wait(2))
                    worker.join(timeout=3)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(events.get(timeout=1)["kind"], "process_exit")
                finally:
                    stop.set()
                    if child.poll() is None:
                        child.terminate()
                    child.wait(timeout=3)
                    worker.join(timeout=2)

    def test_missing_pid_remains_a_sensor_error(self):
        events, ready = queue.Queue(), threading.Event()
        with patch("watchdog_monitor.os.pidfd_open", create=True,
                   side_effect=ProcessLookupError(errno.ESRCH, "no process")):
            process_worker(999999, events, threading.Event(), ready)
        self.assertTrue(ready.is_set())
        event = events.get_nowait()
        self.assertEqual(event["kind"], "sensor_error")
        self.assertTrue(event["fatal"])


@unittest.skipUnless(os.name == "posix", "POSIX signals and native file events")
class PosixLifecycleTests(unittest.TestCase):
    def read_until(self, process, kind):
        records = []
        deadline = time.monotonic() + 5
        # Unbuffered binary streams avoid a TextIOWrapper hiding ready lines.
        while time.monotonic() < deadline:
            if not select.select([process.stdout], [], [], .1)[0]:
                continue
            line = process.stdout.readline()
            if not line:
                break
            record = json.loads(line)
            records.append(record)
            if record["type"] == kind:
                return records
        self.fail(f"missing {kind}: {records}")

    def start_monitor(self, script, *args):
        process = subprocess.Popen([sys.executable, str(SCRIPTS / script), *args],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        return process

    def stop_monitor(self, process):
        process.send_signal(signal.SIGTERM)
        out, err = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, err.decode() + out.decode())
        records = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(records[-1]["reason"], "cancelled")

    def test_sigterm_keeps_observed_pid_alive(self):
        process = self.start_monitor("watchdog_monitor.py", "--pid", str(os.getpid()),
                                     "--codex-thread", "test", "--dry-run", "--timeout-ms", "20000")
        self.read_until(process, "started")
        self.stop_monitor(process)

    def test_sigterm_stops_owned_command_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "leaked"
            source = f"import time,pathlib; print('ready',flush=True); time.sleep(1); pathlib.Path({str(marker)!r}).touch(); time.sleep(20)"
            process = self.start_monitor("monitor_callback.py", "--command",
                                         shell_command([sys.executable, "-c", source]), "--match", "ready",
                                         "--codex-thread", "test", "--dry-run", "--timeout-ms", "20000")
            self.read_until(process, "callback")
            self.stop_monitor(process)
            time.sleep(1.1)
            self.assertFalse(marker.exists(), "owned command survived SIGTERM")

    def test_sigterm_stops_running_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            ready, leaked = Path(directory) / "ready", Path(directory) / "leaked"
            source = f"import time,pathlib; pathlib.Path({str(ready)!r}).touch(); time.sleep(1); pathlib.Path({str(leaked)!r}).touch(); time.sleep(20)"
            process = self.start_monitor("watchdog_monitor.py", "--watch-file", str(Path(directory) / "heartbeat"),
                                         "--stalled-for-ms", "30", "--watchdog-only", "--timeout-ms", "20000",
                                         "--callback-command", shell_command([sys.executable, "-c", source]))
            self.read_until(process, "event")
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            self.stop_monitor(process)
            time.sleep(1.1)
            self.assertFalse(leaked.exists(), "callback survived SIGTERM")

    def test_signal_handler_is_restored(self):
        previous = signal.getsignal(signal.SIGTERM)
        with termination_signals():
            self.assertNotEqual(signal.getsignal(signal.SIGTERM), previous)
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)

    def test_sigterm_cancels_hanging_gpu_query(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ready, leaked, provider = root / "ready", root / "leaked", root / "nvidia-smi"
            provider.write_text(f"#!{sys.executable}\nimport pathlib,time\npathlib.Path({str(ready)!r}).touch()\n"
                                f"time.sleep(1)\npathlib.Path({str(leaked)!r}).touch()\ntime.sleep(20)\n", encoding="utf-8")
            provider.chmod(0o700)
            process = self.start_monitor("watchdog_monitor.py", "--gpu-util-below", "10", "--nvidia-smi", str(provider),
                                         "--pid", str(os.getpid()), "--codex-thread", "test", "--dry-run", "--timeout-ms", "20000")
            self.read_until(process, "started")
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            self.stop_monitor(process)
            time.sleep(1.1)
            self.assertFalse(leaked.exists(), "GPU query survived SIGTERM")

    def test_native_future_file_and_atomic_replacement_through_symlink(self):
        try:
            import watchdog  # noqa: F401
        except ImportError:
            self.skipTest("optional watchdog not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            canonical, alias = root / "canonical", root / "alias"
            canonical.mkdir()
            alias.symlink_to(canonical, target_is_directory=True)
            target = alias / "训练.json"
            events = queue.Queue()
            watcher = FileWatcher(target, True, events, backend="native").start()
            try:
                for step in range(3):
                    temporary = canonical / "temporary"
                    temporary.write_text(str(step), encoding="utf-8")
                    temporary.replace(canonical / target.name)
                    deadline = time.monotonic() + 4
                    while time.monotonic() < deadline:
                        event = events.get(timeout=max(.01, deadline - time.monotonic()))
                        self.assertNotEqual(event["kind"], "sensor_error", event)
                        if event["change"] in {"renamed_new", "created", "modified"}:
                            self.assertEqual(event["path"], str(target))
                            break
                    else:
                        self.fail("native file watcher missed atomic publication")
            finally:
                watcher.close()

    def test_native_root_replacement_is_fatal(self):
        try:
            import watchdog  # noqa: F401
        except ImportError:
            self.skipTest("optional watchdog not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "watched"
            root.mkdir()
            events = queue.Queue()
            watcher = FileWatcher(root, False, events, backend="native").start()
            try:
                self.assertEqual(watcher.backend, "watchdog")
                root.rename(root.with_name("moved"))
                root.mkdir()
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    event = events.get(timeout=max(.01, deadline - time.monotonic()))
                    if event["kind"] == "sensor_error":
                        self.assertTrue(event["fatal"])
                        break
                else:
                    self.fail("native backend missed root replacement")
            finally:
                watcher.close()


if __name__ == "__main__":
    unittest.main()
