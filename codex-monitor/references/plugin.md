# Node plugin: native results and recovery

## Install

Requires Node.js 22.22+ (24 recommended) and a compatible local Codex daemon. Validated with Codex 0.166.0. No Python runtime dependency.

From the development checkout:

```text
npm ci
npm run build
npm run bootstrap
codex plugin marketplace add .
codex plugin add codex-monitor@codex-monitor
```

For a deployment package replace the first two commands with `npm ci --omit=dev`; compiled JavaScript is included. Restart the client. Disable an older standalone skill copy to avoid duplicate guidance. Codex must find the same Node environment and dependencies.

Run bootstrap from an external terminal once per login/reboot. Its hidden launcher runs outside the MCP host's process job and installs no scheduled task/service. Stop it with `node codex-monitor/runtime/cli.js stop-broker`; existing observers retain their deadlines. Windows uses native breakaway flags and fails explicitly when denied; POSIX uses detached sessions.

## Tools and state

| Tool | Purpose |
| --- | --- |
| `monitor_start` | Register an observer; return readiness and deadline |
| `monitor_status` | Monitors, delivery, wait and recovery; select a monitor for full evidence |
| `monitor_stop` | Stop observation, preserving a watched PID |
| `monitor_wait` | Record dependency and optionally pause goal with authorization |
| `monitor_cancel_wait` | Cancel wait and mute its notifications; leave goal unchanged |
| `monitor_ack` | Record handled or dismissed events and their resolution |
| `monitor_recovery` | Configure bounded recovery after transient session errors |

Every tool requires the exact caller thread UUID. Per-thread state lives under `~/.codex/monitor-node` or `CODEX_MONITOR_HOME`, outside watched trees. The private local HTTP endpoint uses a random bearer token. Observers survive MCP disconnects. Services exit after one idle minute once observations, delivery, waits and recovery settle.

## Training example

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "name": "training-42",
  "kind": "watchdog",
  "options": {
    "cwd": "C:/work/project",
    "watch_file": "runs/metrics.json",
    "pid": 12345,
    "stalled_for_ms": 300000,
    "gpu_util_below": 10,
    "gpu_below_for_ms": 120000,
    "gpu_recover_above": 20,
    "gpu_id": "0",
    "dead_if": "all",
    "warmup_ms": 60000,
    "watchdog_only": true,
    "timeout_ms": 86400000
  },
  "instructions": "Inspect exit status and metrics. Evaluate after confirmed completion.",
  "notify_on": ["process_exit", "watchdog_stalled", "monitor_error", "monitor_expired"],
  "event_ttl_ms": 3600000
}
```

File options: `watch_file` or `watch_directory`, `recursive`, `pattern`, `file_backend` (`auto`, `native`, `polling`), `poll_ms`, `stalled_for_ms`. Paths resolve against absolute `cwd`. Chokidar uses native events by default; polling is explicit. Parent subscriptions handle atomic replacement and initially missing files. Root replacement or permission errors are failures. File symlinks require the target path; recursive traversal does not follow directory symlinks.

GPU options: `gpu_id` (indices, UUIDs, PCI IDs, or `all`), `gpu_match` (`all`/`any`), `gpu_util_below`, `gpu_recover_above`, `gpu_below_for_ms`, `gpu_sample_ms`, `nvidia_smi`. Invalid/missing samples are unknown, never zero; they reset dwell evidence. In `any` mode the same card must remain low. `dead_if` combines file/GPU rules. Recovery events require `report_recovery: true` and `watchdog_recovered` in `notify_on`.

PID identity uses a Windows handle, Linux `/proc` start time, or macOS process start-time checks. POSIX checks are local, not model turns. A watchdog never signals the observed PID. macOS unrelated-process exit codes are unavailable and start-time resolution limits PID-reuse detection.

Commands use `kind: command`, `command`, `match` (JavaScript regex), optional `encoding`, `debounce_ms`, `max_events`, `timeout_ms` (maximum 30 minutes). They run through the platform shell. Lines are bounded to 16,000 characters. A Node guardian owns the tree; Windows kill-on-close jobs cover forced guardian termination. POSIX graceful cancellation cleans groups; SIGKILL cannot execute userspace cleanup. Watchdogs can run seven days; expiry notifies once and ends observation.

## Native delivery and acknowledgement

The existing daemon's WebSocket proxy receives `turn/start` with `input: []` and `toolOutput`. Events retain `functionCallOutput` identity rather than becoming user chat messages. Standard MCP notifications alone do not imply a new turn. No undocumented MCP wake feature or chat fallback is used.

The service joins only an already-loaded thread for lifecycle notifications, without replacing it or changing its settings. Short event payloads carry IDs and evidence; full records are available through status. Model instructions and source evidence remain distinct.

Before sending, duplicates are coalesced, newer matching events supersede pending ones, acknowledged events are skipped, and expired events are discarded. A 250 ms batching window groups at most eight events. Registration/history are bounded. Reusing a name after an old monitor finishes supersedes that monitor's pending events.

Lifecycle: `pending -> sending -> submitted -> acknowledged`; alternatives include `superseded`, `expired`, `suppressed`, `failed`, and `unknown`. Turn completion does not prove every event was handled. Only `monitor_ack` records the agent's resolution. Acknowledgement/expiry cannot recall an already queued result. Uncertain submissions are not automatically retried; exactly-once execution is not guaranteed.

## Native goal waiting

Example authorization: “When only training remains, pause this goal; resume it on completion or a monitoring alert.” Supply the actual instruction in `goal_authorization`. Existing authorization persists; a nonempty string records intent but cannot prove consent.

Original goal viewing/editing/status remain in Codex. The plugin preserves objective, budget and usage, pauses the goal during external waiting, sends a native result, then resumes the same unchanged goal. Without authorization the wait does not suppress native continuation. Release is ANY selected monitor.

Later user edits, cancellation, exhausted budget, lost connection or ambiguous mutation stop restoration. Final accounting from the pausing turn may increase. The API lacks atomic compare-and-set; a user action racing the final verification remains a limitation.

## Session recovery

Recovery requires separate user authorization:

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "enabled": true,
  "authorization": "Retry transient network errors, but never resume after I interrupt or pause.",
  "max_attempts": 5,
  "base_delay_ms": 15000,
  "max_delay_ms": 300000,
  "max_elapsed_ms": 1800000,
  "lifetime_ms": 86400000,
  "check_interval_ms": 30000,
  "retry_rate_limits": false
}
```

These defaults allow five attempts with 15/30/60/120/240-second delays. Timers read the local daemon, not the model. Codex retries first. Only verified terminal failed turns with transient connection/stream/server failures qualify. HTTP 401/403, budgets, usage limits, policy blocks and unknown errors do not. Rate-limit retries require opt-in. Codex 0.166.0 labels some truncated HTTP bodies `other`; only its narrowly matched observed transport signature is eligible.

Before retry, re-read latest turn, runtime status and goal. Interrupted turns, paused/ended goals, exhausted budget and new active work prevent recovery. Manual interruption disables the supervisor until re-enabled. Plugin waits suspend recovery. Silent long tools are not interrupted. Recovery continues the task after reconciling completed effects; it does not replay commands or restart training.

Daemon loss causes local reconnect checks until the finite supervisor deadline. No model action happens before verification. Ambiguous submission disables retries as `unknown`. Restart disables recovery and marks existing observation/wait interrupted; reconfigure explicitly. Host APIs have no atomic compare-and-start, so concurrent user actions remain a race boundary.

Official references: [native tool-result turns](https://learn.chatgpt.com/docs/app-server#start-a-turn), [plugin packaging](https://developers.openai.com/plugins/build/plugins), [MCP Events hosts](https://developers.openai.com/plugins/build/mcp-events).
