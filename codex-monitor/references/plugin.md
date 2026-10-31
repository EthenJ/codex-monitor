# Plugin tools and goal waiting

The plugin exposes five MCP tools. `monitor_start` arms a bounded observer and returns its ID, readiness and deadline. `monitor_status` returns a compact snapshot of live monitors and recent history; pass `monitor_id` for that monitor's full evidence and instructions. `monitor_stop` requests cleanup. `monitor_wait` records a pending dependency without keeping a tool call open. `monitor_cancel_wait` cancels conditional continuation and mutes its monitors' notifications.

## Install

Use Python 3.10+ available as `python` in Codex's environment:

```text
python -m pip install -e ".[plugin,platform]"
python codex-monitor/scripts/plugin_runtime.py bootstrap
codex plugin marketplace add .
codex plugin add codex-monitor@codex-monitor
```

Restart the client to load the MCP tools. The manifest uses `${PLUGIN_ROOT}` so cached installation paths work. Dependencies must be installed in the same Python interpreter used by `.mcp.json`; with a virtual environment, launch Codex from that environment or configure the MCP command to its absolute Python path. The plugin does not run pip automatically. Avoid enabling both a standalone copy of this skill and the plugin's copy in the same client.

The plugin uses the Codex compatibility manifest for CLI 0.166.0. Hook trust is not needed: goal waiting is an explicit tool operation, and the skill requests one final status check. No hooks silently pause or prevent a turn from ending.

`bootstrap` starts one hidden local launcher from an external terminal, outside an MCP client's process group. Run it once after login/reboot with the same interpreter and `CODEX_MONITOR_HOME` used by the plugin. Strict Windows hosts can forbid child processes from escaping their kill-on-close job; in that case automatic startup fails with this setup instruction before claiming a monitor is armed. The launcher persists until `python codex-monitor/scripts/plugin_runtime.py stop-broker`, logout or reboot. It performs no model calls and installs no OS service or scheduled task. Ordinary per-thread services exit after their work settles; stopping the launcher does not terminate existing observers.

## Quiet training

Obtain the current thread UUID from the registering conversation's `CODEX_THREAD_ID`. Never use the latest session, a guessed name, or an MCP server's inherited environment as caller identity.

Example `monitor_start` arguments (replace the thread UUID, PID and absolute paths):

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "name": "training-run-42",
  "kind": "watchdog",
  "options": {
    "cwd": "C:/work/project",
    "watch_file": "C:/work/project/runs/metrics.json",
    "pid": 12345,
    "stalled_for_ms": 300000,
    "warmup_ms": 60000,
    "watchdog_only": true,
    "timeout_ms": 86400000
  },
  "instructions": "Inspect the exit status, metrics and checkpoint. Evaluate only after confirming completion.",
  "notify_on": ["process_exit", "watchdog_stalled", "monitor_error", "monitor_expired"]
}
```

Option keys match the helpers' flags using underscores. File paths resolve against `options.cwd`. GPU thresholds (`gpu_util_below`, `gpu_below_for_ms`, `gpu_recover_above`, `gpu_id`) and `dead_if: all` can combine inactivity with low GPU utilization. Runtime sampling and native OS notifications stay local. To arm before launch, register the file watchdog first, launch the workload, then register a separate PID observer; select both IDs for waiting. A watchdog never kills the observed PID.

Use `kind: command` for an owned short build/test command, with `command`, `match` and an explicit `timeout_ms` of at most 30 minutes. It reports exit even if no output matched. Stopping this monitor stops its owned command. Plugin watchdogs can run for up to seven days.

## Goal wait contract

The native goal remains the user's completion contract. The plugin stores a separate wait record:

```text
active goal -> monitors armed -> independent work finished
            -> native goal paused + plugin waiting
            -> selected event -> follow-up submitted -> same goal active
```

The original `/goal` view, editing controls and native progress/status display remain in use. While waiting, the native goal displays its real `paused` state; the plugin status explains the external dependency. The plugin does not add custom footer fields or impersonate a native `waiting` state. Resumption restores `active` on that same goal after the event is submitted.

The user must explicitly authorize the conditional pause and resume, for example:

> When only training remains, pause this goal. Resume it when training completes or a monitoring alert arrives.

Then call `monitor_wait` with the armed IDs, `resume_instructions`, and that applicable instruction in `goal_authorization`. Authorization is a model-enforced user-intent boundary: a nonempty string is recorded, not proof that the user gave permission. The agent must not synthesize this consent. Without authorization the tool can record a normal event wait, but it does not pause an active native goal.

The bridge connects to the **existing** local daemon with `codex app-server proxy` and a WebSocket handshake. It never starts/restarts a Codex daemon, edits the state database, or launches a replacement Codex session. Goal writes use the user-authorized lifecycle API and omit objective/budget fields to preserve accounting. Hosts that do not expose this daemon or permit goal mutation cannot support this mode.

On the first selected event, it checks the paused goal identity and state, submits a follow-up to the exact original thread using `codex queue --resume`, and restores the goal only after confirmed submission. The check rejects replacement, changed objective/budget/status, exhausted budget, and unexpected revision changes. Final accounting from the pausing turn may increase usage without invalidating the wait. The API has no atomic compare-and-set operation: a user mutation racing between the final check and the lifecycle write cannot be excluded. Treat native goal waiting as experimental; later observed user changes always take precedence.

Queue acceptance is not proof that a turn ran. Warnings, timeouts and uncertain mutations are recorded without automatic retries. A cancelled wait leaves the goal paused and mutes further notifications from its selected monitors; stop and re-register them to opt in again. Cancelling cannot recall a callback already submitted or in flight. A crash records the wait as interrupted and does not rearm observations or resume the goal.

## Lifetime and state

MCP tool calls are clients of a per-thread detached Python service. Its private loopback endpoint uses a random bearer token in the user's local state directory. It persists bounded monitor snapshots, latest evidence and callback outcomes under `~/.codex/monitor/<thread-id>` (or `CODEX_MONITOR_HOME`). Keep this directory outside watched trees; directory watches that contain their own state are rejected. This is local user code execution, subject to the host's process and filesystem restrictions.

Services exit after a minute without clients or live observers once delivery and waits have settled. Finite monitor lifetimes remain mandatory. A lost service is reported as unknown on the next request; it never automatically recreates a workload. Status checks cannot establish training health from silence alone.

The sender merges events arriving in a 250 ms window, sends bounded evidence excerpts and directs the agent to the full status record. There is no durable outbox, blind retry, exactly-once delivery or guarantee of preempting an active tool. Use a narrow completion signal or one-shot file monitor to avoid repeated callbacks; ordinary file modifications are intentionally available for workflows that request them.

Official interfaces:

- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [App Server goal lifecycle](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal)
- [Goal lifecycle and continuation](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
