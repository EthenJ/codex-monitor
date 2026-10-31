"""Bounded JSON-RPC connection to the existing Codex daemon; never starts Codex.

Goal lifecycle writes require a recorded, explicit user pause/resume instruction.
No direct database edits, replacement goals, budget resets, or forced interrupts.
"""
from __future__ import annotations

import json
import queue
import subprocess
import threading
from collections import deque

from monitor_callback import codex_executable
from owned_process import start_owned, stop_owned


class RpcError(RuntimeError):
    pass


class AppServer:
    def __init__(self, command=None, timeout=8, transport="websocket", env=None):
        self.timeout = timeout
        self.lock = threading.Lock()
        self.pending = {}
        self.sequence = 0
        self.notifications = deque(maxlen=256)
        self.websocket = None
        self.connected = threading.Event()
        if transport == "websocket":
            from wsproto import WSConnection, ConnectionType
            from wsproto.events import Request
            self.websocket = WSConnection(ConnectionType.CLIENT)
        self.proc = start_owned(command or [codex_executable(None), "app-server", "proxy"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=env)
        if self.websocket:
            self.proc.stdin.write(self.websocket.send(Request(host="localhost", target="/")))
            self.proc.stdin.flush()
        else:
            self.connected.set()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            if not self.connected.wait(timeout):
                raise RpcError("Codex daemon WebSocket handshake did not complete")
            self.call("initialize", {"clientInfo": {"name": "codex_monitor", "version": "0.2.0"}})
            self.send({"method": "initialized"})
        except BaseException:
            self.close()
            raise

    def send(self, message):
        with self.lock:
            text = json.dumps(message)
            if self.websocket:
                from wsproto.events import TextMessage
                payload = self.websocket.send(TextMessage(data=text))
            else:
                payload = (text + "\n").encode()
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()

    def _messages(self):
        if self.websocket is None:
            yield from self.proc.stdout
            return
        from wsproto.events import AcceptConnection, TextMessage, Ping, CloseConnection
        fragments = ""
        while True:
            chunk = self.proc.stdout.read1(65536)
            if not chunk:
                return
            with self.lock:
                self.websocket.receive_data(chunk)
                events = list(self.websocket.events())
            for event in events:
                if isinstance(event, AcceptConnection):
                    self.connected.set()
                elif isinstance(event, TextMessage):
                    fragments += event.data
                    if len(fragments) > 16 * 1024 * 1024:
                        raise ValueError("App-server response is too large")
                    if event.message_finished:
                        yield fragments
                        fragments = ""
                elif isinstance(event, Ping):
                    with self.lock:
                        self.proc.stdin.write(self.websocket.send(event.response()))
                        self.proc.stdin.flush()
                elif isinstance(event, CloseConnection):
                    return

    def _read(self):
        try:
            for line in self._messages():
                item = json.loads(line)
                if "method" in item and "id" in item:
                    # Server request IDs are independent of our pending response IDs.
                    # This observation client cannot approve another client's actions.
                    self.send({"id": item["id"], "error": {
                        "code": -32601, "message": "Monitor client does not handle approval requests"}})
                    continue
                with self.lock:
                    response = self.pending.get(item.get("id"))
                    if response is not None:
                        response.put(item)
                    elif "id" not in item:
                        self.notifications.append(item)
        except Exception:
            pass
        finally:
            with self.lock:
                for target in self.pending.values():
                    target.put({"error": {"message": "Codex daemon connection closed"}})

    def call(self, method, params):
        response = queue.Queue()
        with self.lock:
            self.sequence += 1
            request_id = self.sequence
            self.pending[request_id] = response
        try:
            self.send({"id": request_id, "method": method, "params": params})
            item = response.get(timeout=self.timeout)
            if "error" in item:
                raise RpcError(str(item["error"]))
            return item.get("result", {})
        except queue.Empty as exc:
            raise RpcError(f"{method} timed out; outcome is unknown, do not retry blindly") from exc
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def goal(self, thread_id):
        return self.call("thread/goal/get", {"threadId": thread_id}).get("goal")

    def assert_loaded(self, thread_id):
        loaded = self.call("thread/loaded/list", {}).get("data", [])
        if thread_id not in loaded:
            raise RpcError("Target thread is not loaded in this daemon; native goal waiting requires the same host")

    def set_status(self, thread_id, status):
        # Called only to execute the user's recorded conditional pause/resume instruction.
        # Omitting objective and budget preserves their identity and usage accounting.
        return self.call("thread/goal/set", {
            "threadId": thread_id, "status": status, "origin": "user"}).get("goal")

    def close(self):
        stop_owned(self.proc)
        self.reader.join(timeout=2)
        self.proc.stdin.close()
        if not self.reader.is_alive():
            self.proc.stdout.close()


def same_goal(expected, actual):
    """Fail closed on goal edits, recreation, budget changes or manual state changes."""
    if not expected or not actual:
        return False
    keys = ("threadId", "createdAt", "objective", "tokenBudget", "status")
    if not all(expected.get(key) == actual.get(key) for key in keys):
        return False
    budget = actual.get("tokenBudget")
    if budget is not None and actual.get("tokensUsed", 0) >= budget:
        return False
    # The current turn can finish accounting after the pause. That accounting is
    # preserved, never restored from the pause snapshot or treated as a goal edit.
    accounting = ("tokensUsed", "timeUsedSeconds")
    increases = any(actual.get(k, 0) > expected.get(k, 0) for k in accounting)
    monotonic = all(actual.get(k, 0) >= expected.get(k, 0) for k in accounting)
    return monotonic and (expected.get("updatedAt") == actual.get("updatedAt") or increases)


class GoalGate:
    def __init__(self, thread_id, connect=AppServer):
        self.thread_id = thread_id
        self.connect = connect
        self.client = None

    def pause(self, authorization):
        if not isinstance(authorization, str) or not authorization.strip():
            raise ValueError("Explicit user authorization to pause and resume this goal is required")
        self.client = self.connect()
        try:
            self.client.assert_loaded(self.thread_id)
            goal = self.client.goal(self.thread_id)
            if not goal or goal.get("status") != "active":
                raise ValueError("Only an active goal can enter monitor waiting")
            if goal.get("tokenBudget") is not None and goal["tokensUsed"] >= goal["tokenBudget"]:
                raise ValueError("Goal budget is exhausted")
            paused = self.client.set_status(self.thread_id, "paused")
            if not paused or paused.get("status") != "paused":
                raise RpcError("Host did not confirm the goal pause")
            return paused
        except BaseException:
            self.close()
            raise

    def unchanged(self, paused):
        if self.client is None:
            return False
        self.client.assert_loaded(self.thread_id)
        return same_goal(paused, self.client.goal(self.thread_id))

    def resume(self, paused):
        if not self.unchanged(paused):
            raise ValueError("Goal changed since waiting; automatic resume was cancelled")
        goal = self.client.set_status(self.thread_id, "active")
        if not goal or goal.get("status") != "active":
            raise RpcError("Host did not confirm goal resume")
        return goal

    def close(self):
        if self.client:
            self.client.close()
            self.client = None
