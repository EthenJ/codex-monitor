"""Lifetime control for commands owned by the monitor, never observed PIDs."""
from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import threading
import time
from collections import deque
from contextlib import ExitStack


class ProcessCancelled(RuntimeError):
    pass


class WindowsJob:
    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("ProcessTime", ctypes.c_longlong), ("JobTime", ctypes.c_longlong),
                        ("Flags", wintypes.DWORD), ("MinWorkingSet", ctypes.c_size_t),
                        ("MaxWorkingSet", ctypes.c_size_t), ("ActiveProcesses", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("Priority", wintypes.DWORD),
                        ("Scheduling", wintypes.DWORD)]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("Basic", BasicLimits), ("IO", ctypes.c_ulonglong * 6),
                        ("ProcessMemory", ctypes.c_size_t), ("JobMemory", ctypes.c_size_t),
                        ("PeakProcessMemory", ctypes.c_size_t), ("PeakJobMemory", ctypes.c_size_t)]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                     ctypes.c_void_p, wintypes.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.Basic.Flags = 0x2000
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, process):
        import ctypes

        if not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.resume(process.pid)

    def resume(self, pid):
        import ctypes
        from ctypes import wintypes

        class ThreadEntry(ctypes.Structure):
            _fields_ = [("Size", wintypes.DWORD), ("Usage", wintypes.DWORD),
                        ("ThreadId", wintypes.DWORD), ("ProcessId", wintypes.DWORD),
                        ("BasePriority", wintypes.LONG), ("DeltaPriority", wintypes.LONG),
                        ("Flags", wintypes.DWORD)]

        self.api.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        self.api.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        self.api.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
        self.api.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
        self.api.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.api.OpenThread.restype = wintypes.HANDLE
        self.api.ResumeThread.argtypes = [wintypes.HANDLE]
        self.api.ResumeThread.restype = wintypes.DWORD
        snapshot = self.api.CreateToolhelp32Snapshot(4, 0)
        if snapshot == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = ThreadEntry()
            entry.Size = ctypes.sizeof(entry)
            found = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while found:
                if entry.ProcessId == pid:
                    thread = self.api.OpenThread(2, False, entry.ThreadId)
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if self.api.ResumeThread(thread) == 0xFFFFFFFF:
                            raise ctypes.WinError(ctypes.get_last_error())
                        return
                    finally:
                        self.api.CloseHandle(thread)
                found = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            raise RuntimeError("cannot find the owned process's suspended thread")
        finally:
            self.api.CloseHandle(snapshot)

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def start_owned(command, *, shell=False, cwd=None, **kwargs):
    job = WindowsJob() if os.name == "nt" else None
    process = None
    try:
        if job:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW | 0x4
        else:
            kwargs["start_new_session"] = True
        process = subprocess.Popen(command, shell=shell, cwd=cwd or None, **kwargs)
        if job:
            job.assign(process)
        process.monitor_job = job
        return process
    except BaseException:
        if job:
            job.close()
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        raise


def stop_owned(process):
    if getattr(process, "monitor_stopped", False):
        return
    job = getattr(process, "monitor_job", None)
    if job:
        job.close()
    elif os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Darwin can return EPERM for a group containing only zombies.
            # Reap our exited leader and retry; genuine permission failures
            # still propagate, including failures while the leader is alive.
            if process.poll() is None:
                raise
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    elif process.poll() is None:
        process.kill()
    process.wait(timeout=3)
    process.monitor_stopped = True


def run_owned(command, *, shell=False, cwd=None, input=None, timeout=30, stop_event=None):
    deadline = time.monotonic() + timeout
    if stop_event is not None and stop_event.is_set():
        raise ProcessCancelled("owned process cancelled")
    with ExitStack() as resources:
        input_source = subprocess.DEVNULL
        if input is not None:
            input_source = resources.enter_context(tempfile.TemporaryFile())
            input_source.write(input.encode("utf-8"))
            input_source.seek(0)
        process = start_owned(command, shell=shell, cwd=cwd,
                              stdin=input_source,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        chunks = deque(maxlen=16)
        read_errors = []
        def drain_output():
            try:
                while True:
                    chunk = process.stdout.read(4096)
                    if not chunk:
                        return
                    chunks.append(chunk)
            except OSError as exc:
                read_errors.append(exc)
        reader = threading.Thread(target=drain_output, daemon=True, name="callback-output")
        try:
            reader.start()
            while True:
                if stop_event is not None and stop_event.is_set():
                    raise ProcessCancelled("owned process cancelled")
                remaining = max(0, deadline - time.monotonic())
                try:
                    returncode = process.wait(timeout=min(0.1, remaining) if stop_event is not None else remaining)
                    break
                except subprocess.TimeoutExpired:
                    if stop_event is None or time.monotonic() >= deadline:
                        raise
        finally:
            stop_owned(process)
            if reader.ident is not None:
                reader.join(timeout=1)
            if not reader.is_alive():
                process.stdout.close()
        if reader.is_alive():
            raise RuntimeError("callback output pipe remained open after owned process cleanup")
        if read_errors:
            raise read_errors[0]
        diagnostic = b"".join(chunks).decode("utf-8", errors="replace")
        return subprocess.CompletedProcess(command, returncode, diagnostic)
