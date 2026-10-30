"""Native file events with an explicitly reported snapshot fallback."""
from __future__ import annotations

import fnmatch
import os
import queue
import struct
import threading
from pathlib import Path
from typing import Any


class FileWatcher:
    def __init__(self, path: Path, is_file: bool, events: queue.Queue, *, recursive=False,
                 pattern=None, backend="auto", poll_ms=1000):
        self.path, self.is_file, self.events = path, is_file, events
        self.root = path.parent if is_file else path
        self.recursive, self.pattern = recursive, pattern
        self.backend, self.poll_ms = backend, poll_ms
        self.stop = threading.Event()
        self.ready = threading.Event()
        self.error: Exception | None = None
        self.observer = None
        self.thread = threading.Thread(target=self._run, daemon=True, name="file-events")

    def start(self):
        self.thread.start()
        if not self.ready.wait(10):
            self.close()
            raise RuntimeError("file watcher did not become ready")
        if self.error:
            self.close()
            raise RuntimeError(str(self.error))
        return self

    def close(self):
        self.stop.set()
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=3)
        self.thread.join(timeout=3)

    def _emit(self, change, path):
        path = Path(os.path.abspath(path))
        if self.is_file and path != self.path:
            return
        relative = path.relative_to(self.root).as_posix()
        if self.pattern and not (fnmatch.fnmatch(relative, self.pattern)
                                 or fnmatch.fnmatch(path.name, self.pattern)):
            return
        if path == self.root:
            return
        self.events.put({"kind": "file_change", "change": change, "path": str(path),
                         "relative_path": relative, "backend": self.backend})

    def _run(self):
        try:
            if self.backend != "polling" and os.name == "nt":
                self.backend = "ReadDirectoryChangesW"
                self._windows()
            elif self.backend != "polling":
                try:
                    self._watchdog()
                except ImportError:
                    if self.backend == "native":
                        raise RuntimeError("native file events need: python -m pip install watchdog")
                    self.backend = "snapshot-fallback"
                    self._snapshots()
            else:
                self.backend = "snapshot-fallback"
                self._snapshots()
        except Exception as exc:
            self.error = exc
            if self.ready.is_set() and not self.stop.is_set():
                self.events.put({"kind": "sensor_error", "sensor": "file", "fatal": True,
                                 "error": str(exc)})
        finally:
            self.ready.set()

    def _watchdog(self):
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer
        watcher = self

        class Handler(FileSystemEventHandler):
            def on_any_event(self, event):
                if event.event_type not in {"created", "modified", "deleted", "moved"}:
                    return
                watcher._emit("renamed_old" if event.event_type == "moved" else event.event_type,
                              event.src_path)
                if event.event_type == "moved":
                    watcher._emit("renamed_new", event.dest_path)

        self.observer = Observer()
        self.observer.schedule(Handler(), str(self.root), recursive=self.recursive)
        self.observer.start()
        self.backend = "watchdog"
        self.ready.set()
        self.stop.wait()

    def _snapshot(self):
        paths = [self.path] if self.is_file else (self.path.rglob("*") if self.recursive else self.path.glob("*"))
        result = {}
        for path in paths:
            try:
                stat = path.stat()
                result[str(path)] = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
            except FileNotFoundError:
                continue
        return result

    def _snapshots(self):
        before = self._snapshot()
        self.ready.set()
        while not self.stop.wait(self.poll_ms / 1000):
            after = self._snapshot()
            for key in before.keys() | after.keys():
                if key not in before:
                    self._emit("created", key)
                elif key not in after:
                    self._emit("deleted", key)
                elif before[key] != after[key]:
                    self._emit("modified", key)
            before = after

    def _windows(self):
        import ctypes as c
        from ctypes import wintypes as w

        class Overlapped(c.Structure):
            _fields_ = [("Internal", c.c_size_t), ("InternalHigh", c.c_size_t),
                        ("Offset", w.DWORD), ("OffsetHigh", w.DWORD), ("hEvent", w.HANDLE)]

        k = c.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateFileW": ([w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
            "CreateEventW": ([c.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR], w.HANDLE),
            "ReadDirectoryChangesW": ([w.HANDLE, c.c_void_p, w.DWORD, w.BOOL, w.DWORD,
                                       c.POINTER(w.DWORD), c.POINTER(Overlapped), c.c_void_p], w.BOOL),
            "WaitForSingleObject": ([w.HANDLE, w.DWORD], w.DWORD),
            "GetOverlappedResult": ([w.HANDLE, c.POINTER(Overlapped), c.POINTER(w.DWORD), w.BOOL], w.BOOL),
            "CancelIoEx": ([w.HANDLE, c.POINTER(Overlapped)], w.BOOL),
            "ResetEvent": ([w.HANDLE], w.BOOL), "CloseHandle": ([w.HANDLE], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            getattr(k, name).argtypes, getattr(k, name).restype = args, result
        handle = k.CreateFileW(str(self.root), 1, 7, None, 3, 0x42000000, None)
        if handle == w.HANDLE(-1).value:
            raise c.WinError(c.get_last_error())
        event = k.CreateEventW(None, True, False, None)
        if not event:
            k.CloseHandle(handle)
            raise c.WinError(c.get_last_error())
        buffer = c.create_string_buffer(65536)
        overlapped = Overlapped()
        overlapped.hEvent = event
        pending = False
        try:
            while not self.stop.is_set():
                k.ResetEvent(event)
                if not k.ReadDirectoryChangesW(handle, buffer, len(buffer), self.recursive,
                                               0x1B, None, c.byref(overlapped), None):
                    raise c.WinError(c.get_last_error())
                pending = True
                self.ready.set()  # subscription armed before caller starts the workload
                while k.WaitForSingleObject(event, 100) == 258:
                    if self.stop.is_set():
                        return
                count = w.DWORD()
                if not k.GetOverlappedResult(handle, c.byref(overlapped), c.byref(count), False):
                    raise c.WinError(c.get_last_error())
                pending = False
                if not count.value:
                    raise RuntimeError("directory event buffer overflow; observation is incomplete")
                offset = 0
                while offset < count.value:
                    next_offset, action, size = struct.unpack_from("<III", buffer, offset)
                    name = buffer.raw[offset + 12:offset + 12 + size].decode("utf-16-le")
                    self._emit({1: "created", 2: "deleted", 3: "modified",
                                4: "renamed_old", 5: "renamed_new"}[action], self.root / name)
                    if not next_offset:
                        break
                    offset += next_offset
        finally:
            if pending:
                k.CancelIoEx(handle, c.byref(overlapped))
                count = w.DWORD()
                k.GetOverlappedResult(handle, c.byref(overlapped), c.byref(count), True)
            k.CloseHandle(event)
            k.CloseHandle(handle)
