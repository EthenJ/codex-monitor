"""Run on real Windows: overlapped I/O handles, PID status and Job teardown."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from file_events import FileWatcher
from test_regressions import shell_command
from watchdog_monitor import process_worker


@unittest.skipUnless(os.name == "nt", "requires real Windows APIs")
class WindowsNativeTests(unittest.TestCase):
    def test_pending_directory_read_releases_handles(self):
        import ctypes as c
        from ctypes import wintypes as w

        api = c.WinDLL("kernel32", use_last_error=True)
        api.GetCurrentProcess.restype = w.HANDLE
        api.GetProcessHandleCount.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
        api.GetProcessHandleCount.restype = w.BOOL
        def handles():
            count = w.DWORD()
            if not api.GetProcessHandleCount(api.GetCurrentProcess(), c.byref(count)):
                raise c.WinError(c.get_last_error())
            return count.value

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            # Warm up Python thread bookkeeping before measuring kernel handles.
            FileWatcher(root, False, queue.Queue(), backend="native").start().close()
            before = handles()
            for _ in range(20):
                watcher = FileWatcher(root, False, queue.Queue(), backend="native").start()
                try:
                    self.assertEqual(watcher.backend, "ReadDirectoryChangesW")
                finally:
                    watcher.close()
                self.assertFalse(watcher.thread.is_alive(), "pending directory read did not cancel")
            self.assertLessEqual(handles(), before + 2, "native directory handles accumulated")

    def test_observed_pid_returns_actual_windows_exit_code(self):
        child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.readline(); sys.exit(7)"],
                                 stdin=subprocess.PIPE)
        events, stop, ready = queue.Queue(), threading.Event(), threading.Event()
        worker = threading.Thread(target=process_worker, args=(child.pid, events, stop, ready), daemon=True)
        try:
            worker.start()
            self.assertTrue(ready.wait(5), "process handle was not armed")
            self.assertTrue(events.empty(), "binding an existing PID failed")
            self.assertIsNone(child.poll())
            child.stdin.write(b"exit\n")
            child.stdin.flush()
            event = events.get(timeout=5)
            self.assertEqual(event, {"kind": "process_exit", "returncode": 7})
        finally:
            stop.set()
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)
            worker.join(timeout=5)
        self.assertFalse(worker.is_alive())

    def test_forced_monitor_exit_cleans_callback_tree_and_preserves_observed_pid(self):
        observed = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.readline()"],
                                    stdin=subprocess.PIPE)
        monitor = None
        try:
            with tempfile.TemporaryDirectory(prefix="codex monitor ") as directory:
                root = Path(directory)
                callback, ready = root / "callback.py", root / "ready.json"
                parent_leak, child_leak = root / "parent-leaked", root / "child-leaked"
                child_source = f"import pathlib,time; time.sleep(1.5); pathlib.Path({str(child_leak)!r}).touch()"
                callback.write_text(
                    "import json,os,pathlib,subprocess,sys,time\n"
                    f"child=subprocess.Popen([sys.executable,'-c',{child_source!r}])\n"
                    f"pathlib.Path({str(ready)!r}).write_text(json.dumps({{'parent':os.getpid(),'child':child.pid}}))\n"
                    f"time.sleep(1.5)\npathlib.Path({str(parent_leak)!r}).touch()\n", encoding="utf-8")
                monitor = subprocess.Popen([
                    sys.executable, str(SCRIPTS / "watchdog_monitor.py"), "--pid", str(observed.pid),
                    "--watch-file", str(root / "heartbeat"), "--stalled-for-ms", "30", "--watchdog-only",
                    "--timeout-ms", "15000", "--callback-command", shell_command([sys.executable, str(callback)])],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                deadline = time.monotonic() + 8
                while not ready.exists() and time.monotonic() < deadline and monitor.poll() is None:
                    time.sleep(.01)
                self.assertTrue(ready.exists(), "callback never started")
                # TerminateProcess bypasses Python finally blocks. Only closing
                # the monitor's last Job handle can clean this callback tree.
                monitor.kill()
                out, err = monitor.communicate(timeout=5)
                self.assertNotEqual(monitor.returncode, 0)
                records = [json.loads(line) for line in out.splitlines()]
                self.assertTrue(any(record["type"] == "event" for record in records), err)
                time.sleep(1.8)
                self.assertFalse(parent_leak.exists(), "callback escaped its Job")
                self.assertFalse(child_leak.exists(), "callback descendant escaped its Job")
                self.assertIsNone(observed.poll(), "observed workload was wrongly owned")
        finally:
            if monitor is not None:
                if monitor.poll() is None:
                    monitor.kill()
                monitor.communicate(timeout=5)
            if observed.poll() is None:
                observed.kill()
            observed.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
