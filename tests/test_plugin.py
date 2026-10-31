"""Observable plugin behavior: real sensors, detached service, and goal races."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

SCRIPTS = Path(__file__).resolve().parents[1] / "codex-monitor" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from goal_bridge import AppServer, GoalGate, same_goal
from plugin_runtime import Manager, prepare, rpc, ensure_service


class FakeApp:
    def __init__(self):
        self.value = {"threadId": "test", "createdAt": 1, "updatedAt": 1, "objective": "Train and evaluate",
                      "status": "active", "tokenBudget": 10000, "tokensUsed": 123, "timeUsedSeconds": 9}
        self.writes = []

    def goal(self, thread_id):
        return dict(self.value) if self.value else None

    def assert_loaded(self, thread_id):
        pass

    def set_status(self, thread_id, status):
        self.writes.append(status)
        self.value.update(status=status, updatedAt=self.value["updatedAt"] + 1)
        return dict(self.value)

    def close(self):
        pass


class GoalTests(unittest.TestCase):
    def test_pause_resume_preserves_objective_and_budget_accounting(self):
        app = FakeApp()
        gate = GoalGate("test", connect=lambda: app)
        paused = gate.pause("Pause this goal while waiting; resume when training finishes.")
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(gate.resume(paused)["status"], "active")
        self.assertEqual(app.writes, ["paused", "active"])
        self.assertEqual(app.value["tokensUsed"], 123)
        self.assertEqual(app.value["tokenBudget"], 10000)
        self.assertEqual(app.value["objective"], "Train and evaluate")

    def test_pause_requires_explicit_authorization(self):
        app = FakeApp()
        gate = GoalGate("test", connect=lambda: app)
        with self.assertRaises(ValueError):
            gate.pause("")
        self.assertEqual(app.writes, [])

    def test_accounting_after_pausing_turn_is_preserved(self):
        app = FakeApp()
        gate = GoalGate("test", connect=lambda: app)
        paused = gate.pause("Pause and resume on event")
        app.value.update(tokensUsed=456, timeUsedSeconds=20, updatedAt=3)
        resumed = gate.resume(paused)
        self.assertEqual(resumed["tokensUsed"], 456)
        self.assertEqual(resumed["timeUsedSeconds"], 20)

    def test_never_resume_changed_goal(self):
        for change in ({"status": "complete"}, {"status": "budgetLimited"}, {"updatedAt": 999},
                       {"createdAt": 999}, {"objective": "Different task"}, {"tokenBudget": 20000}):
            with self.subTest(change=change):
                app = FakeApp()
                gate = GoalGate("test", connect=lambda: app)
                paused = gate.pause("Pause and resume on event")
                app.value.update(change)
                with self.assertRaises(ValueError):
                    gate.resume(paused)
                self.assertEqual(app.writes, ["paused"])

    def test_budget_exhausted_and_manual_pause_not_overridden(self):
        for change in ({"status": "paused"}, {"tokensUsed": 10000}):
            app = FakeApp()
            app.value.update(change)
            gate = GoalGate("test", connect=lambda: app)
            with self.assertRaises(ValueError):
                gate.pause("Pause and resume on event")
            self.assertFalse(app.writes)

    def test_rpc_protocol_and_error(self):
        script = """import sys,json
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 if r['method']=='thread/goal/get': result={'goal':{'status':'paused'}}
 else: result={}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"""
        client = AppServer([sys.executable, "-u", "-c", script], transport="jsonl", timeout=2)
        try:
            self.assertEqual(client.goal("test")["status"], "paused")
        finally:
            client.close()

    def test_server_request_id_collision_is_not_a_goal_response(self):
        script = """import sys,json
denied=False
for line in sys.stdin:
 r=json.loads(line)
 if 'error' in r:
  denied=r['error']['code']==-32601
  continue
 if 'id' not in r: continue
 if r['method']=='probe':
  print(json.dumps({'id':r['id'],'method':'approval/request','params':{}}),flush=True)
  print(json.dumps({'id':r['id'],'result':{'response':True}}),flush=True)
 else:
  print(json.dumps({'id':r['id'],'result':{'denied':denied}}),flush=True)
"""
        client = AppServer([sys.executable, "-u", "-c", script], transport="jsonl", timeout=2)
        try:
            self.assertEqual(client.call("probe", {}), {"response": True})
            self.assertTrue(client.call("verify", {})["denied"])
        finally:
            client.close()


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / "work"
        self.work.mkdir()
        self.delivered = queue.Queue()
        self.app = FakeApp()
        self.manager = Manager(self.root / "state", str(uuid.uuid4()),
            delivery=self.deliver, gate_factory=lambda thread: GoalGate(thread, connect=lambda: self.app))

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def deliver(self, message):
        self.delivered.put(message)
        return True, "accepted"

    def watch(self, **kwargs):
        options = {"cwd": str(self.work), "watch_file": str(self.work / "metrics.json"), "timeout_ms": 10000}
        options.update(kwargs)
        return self.manager.start("training", "watchdog", options, "Inspect the result")

    def settled(self):
        # Test-side bounded synchronization, not an agent/model polling loop.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with self.manager.lock:
                if self.manager.events.empty() and not self.manager.sending.is_set():
                    return
            threading.Event().wait(0.01)
        self.fail("delivery did not settle")

    def test_ready_idempotent_and_cross_config_rejected(self):
        first = self.watch()
        self.assertEqual(first["state"], "armed")
        self.assertEqual(self.watch()["id"], first["id"])
        with self.assertRaises(ValueError):
            self.watch(timeout_ms=20000)

    def test_file_event_delivers_once_with_batching(self):
        record = self.watch(max_events=1)
        (self.work / "metrics.json").write_text("done")
        message = self.delivered.get(timeout=4)
        self.assertIn("training", message)
        self.assertIn("file_change", message)
        self.manager.jobs[record["id"]][0].join(timeout=3)
        self.assertFalse(self.manager.jobs[record["id"]][0].is_alive())
        self.assertEqual(self.manager.snapshot()["monitors"][record["id"]]["state"], "stopped")

    def test_training_progress_stays_local_until_stall(self):
        record = self.watch(stalled_for_ms=300, watchdog_only=True, max_events=1)
        (self.work / "metrics.json").write_text("step1")
        self.assertTrue(self.delivered.empty())
        message = self.delivered.get(timeout=4)
        self.assertIn("watchdog_stalled", message)
        self.assertNotIn('"event_type": "file_change"', message)

    def test_wait_returns_immediately_and_pauses_until_event(self):
        record = self.watch(max_events=1)
        result = self.manager.wait([record["id"]], "Evaluate the checkpoint", "Pause goal while waiting and resume on event")
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(self.app.value["status"], "paused")
        self.assertTrue(self.delivered.empty())
        (self.work / "metrics.json").write_text("done")
        self.assertIn("Evaluate the checkpoint", self.delivered.get(timeout=4))
        self.settled()
        self.assertEqual(self.app.value["status"], "active")
        self.assertEqual(self.manager.snapshot()["wait"]["state"], "delivered")

    def test_event_before_wait_does_not_pause_goal(self):
        record = self.watch(max_events=1)
        (self.work / "metrics.json").write_text("done")
        self.delivered.get(timeout=4)
        self.settled()
        result = self.manager.wait([record["id"]], "Evaluate", "Pause and resume on event")
        self.assertEqual(result["state"], "ready")
        self.assertFalse(self.app.writes)

    def test_user_goal_change_suppresses_wake_and_resume(self):
        record = self.watch(max_events=1)
        self.manager.wait([record["id"]], "Evaluate", "Pause and resume on event")
        self.app.value["objective"] = "Changed by user"
        (self.work / "metrics.json").write_text("done")
        self.manager.jobs[record["id"]][0].join(timeout=3)
        self.settled()
        self.assertTrue(self.delivered.empty())
        self.assertEqual(self.manager.snapshot()["wait"]["state"], "cancelled")
        self.assertEqual(self.app.writes, ["paused"])

    def test_cancel_wait_leaves_goal_paused_and_mutes_events(self):
        record = self.watch(max_events=1)
        self.manager.wait([record["id"]], "Evaluate", "Pause and resume on event")
        self.manager.cancel_wait()
        (self.work / "metrics.json").write_text("done")
        self.manager.jobs[record["id"]][0].join(timeout=3)
        self.assertTrue(self.delivered.empty())
        self.assertEqual(self.app.value["status"], "paused")

    def test_cancel_old_wait_after_monitor_history_pruned(self):
        record = self.watch(max_events=1)
        self.manager.wait([record["id"]], "Evaluate")
        (self.work / "metrics.json").write_text("done")
        self.delivered.get(timeout=4)
        self.manager.jobs[record["id"]][0].join(timeout=3)
        self.settled()
        with self.manager.lock:
            del self.manager.records[record["id"]]
        self.assertEqual(self.manager.cancel_wait()["state"], "cancelled")

    def test_delivery_failure_leaves_goal_paused(self):
        self.manager.delivery = lambda message: (False, "resume warning")
        record = self.watch(max_events=1)
        self.manager.wait([record["id"]], "Evaluate", "Pause and resume on event")
        (self.work / "metrics.json").write_text("done")
        self.manager.jobs[record["id"]][0].join(timeout=3)
        self.settled()
        self.assertEqual(self.app.value["status"], "paused")
        self.assertEqual(self.manager.snapshot()["wait"]["state"], "failed")

    def test_status_not_blocked_by_slow_callback(self):
        entered, release = threading.Event(), threading.Event()
        def slow(message):
            entered.set()
            release.wait(timeout=5)
            return True, "accepted"
        self.manager.delivery = slow
        record = self.watch(max_events=1)
        (self.work / "metrics.json").write_text("done")
        self.assertTrue(entered.wait(timeout=3))
        try:
            before = time.monotonic()
            self.assertIn(record["id"], self.manager.snapshot()["monitors"])
            self.assertLess(time.monotonic() - before, 0.5)
        finally:
            release.set()

    def test_deadline_wakes_once(self):
        record = self.watch(timeout_ms=150)
        self.assertIn("monitor_expired", self.delivered.get(timeout=4))
        self.manager.jobs[record["id"]][0].join(timeout=2)
        self.assertTrue(self.delivered.empty())

    def test_stop_is_observation_only(self):
        record = self.watch()
        self.manager.stop(record["id"])
        self.manager.jobs[record["id"]][0].join(timeout=3)
        state = self.manager.snapshot()["monitors"][record["id"]]
        self.assertEqual(state["outcome"]["reason"], "cancelled")
        self.assertTrue(self.delivered.empty())

    def test_compact_status_and_full_evidence(self):
        record = self.watch()
        summary = self.manager.snapshot(compact=True)
        self.assertNotIn("options", summary["monitors"][record["id"]])
        full = self.manager.snapshot(monitor_id=record["id"], compact=True)
        self.assertEqual(full["monitors"][record["id"]]["instructions"], "Inspect the result")

    def test_cancel_during_delivery_never_restores_goal(self):
        entered, release = threading.Event(), threading.Event()
        def slow(message):
            entered.set()
            release.wait(timeout=5)
            return True, "accepted"
        self.manager.delivery = slow
        record = self.watch(max_events=1)
        self.manager.wait([record["id"]], "Evaluate", "Pause and resume on event")
        (self.work / "metrics.json").write_text("done")
        self.assertTrue(entered.wait(timeout=3))
        try:
            self.manager.cancel_wait()
        finally:
            release.set()
        self.settled()
        self.assertEqual(self.app.writes, ["paused"])
        self.assertEqual(self.manager.snapshot()["wait"]["state"], "cancelled")

    def test_registry_inside_watched_tree_rejected(self):
        with self.assertRaises(ValueError):
            self.manager.start("recursive", "watchdog", {"cwd": str(self.root),
                "watch_directory": str(self.root), "recursive": True}, "Inspect")

    def test_command_reports_exit_without_matching_output(self):
        record = self.manager.start("build", "command", {"cwd": str(self.work),
            "command": f'"{sys.executable}" -c "print(123)"', "match": "NEVER", "timeout_ms": 3000}, "Inspect exit")
        self.assertIn("command_exit", self.delivered.get(timeout=4))
        self.manager.jobs[record["id"]][0].join(timeout=2)
        self.assertEqual(self.manager.snapshot()["monitors"][record["id"]]["exit_code"], 0)

    def test_restart_does_not_rearm_or_resume(self):
        record = self.watch()
        self.manager.wait([record["id"]], "Evaluate", "Pause and resume on event")
        # Copy a crash snapshot before the original service cleans up.
        other = self.root / "recovered"
        other.mkdir()
        (other / "state.json").write_text(json.dumps(self.manager.snapshot()))
        recovered = Manager(other, self.manager.thread_id, delivery=self.deliver)
        try:
            state = recovered.snapshot()
            self.assertEqual(state["monitors"][record["id"]]["state"], "unknown")
            self.assertEqual(state["wait"]["state"], "interrupted")
            self.assertFalse(recovered.jobs)
        finally:
            recovered.close()

    def test_unsafe_and_invalid_options_rejected_before_start(self):
        for options in ({"cwd": "."}, {"cwd": str(self.work), "callback_command": "bad"},
                        {"cwd": str(self.work), "watch_file": str(self.work / "m"), "timeout_ms": -1}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.manager.start("bad", "watchdog", options, "Inspect")
        self.assertFalse(self.manager.jobs)


if __name__ == "__main__":
    unittest.main()
