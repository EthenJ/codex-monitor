# Node plugin: native results and recovery

## Install

Requires Node.js 22.22+ (24 recommended), npm, Codex CLI 0.166.0+ and a compatible local Codex daemon. Validated with Codex 0.166.0. No Python runtime dependency.

Run the installation wizard from a complete source checkout or deployment package:

```text
node install.mjs
```

It asks for preferences, builds when needed, verifies a staged bundle and registers it through the official Codex commands. Use `--dry-run` for a preview. For agent-assisted answers, isolated simulation, upgrades and the activation checklist, read [Interactive installation](installation.md). Disable an older standalone skill copy to avoid duplicate guidance. Codex must find the same Node environment and dependencies.

Run bootstrap from an external terminal once per login/reboot. Its hidden launcher runs outside the MCP host's process job and installs no scheduled task/service. Stop it with `node codex-monitor/runtime/cli.js stop-broker`; existing observers retain their deadlines. Windows uses native breakaway flags and fails explicitly when denied; POSIX uses detached sessions.

## Tools and state

All eleven MCP tools return readable plain text, structured data, and an optional MCP Apps view. Routine `monitor_report` and Stop/Interrupt messages are a single line, for example `Monitor · 2 running`. Starting/stopping counts and enabled automatic retry are included only when applicable. Inactive monitors, IDs and event history are omitted from routine text; full details remain in structured data and `monitor_status`. Unverified saved state produces `Monitor · live status unavailable` rather than a stale running count. No tool duplicates its JSON in text or uses Markdown tables: Codex CLI renders these blocks literally, including assistant-audience blocks.

`monitor_display` gets or sets `mode: "compact" | "verbose"` for the exact caller thread. Compact is the default. The setting lives in the thread's state directory, outside the installed plugin, and applies to subsequent tool calls and callbacks without a restart or hook reapproval. It does not change observation, delivery, recovery or goal policy. Invalid updates are rejected; corrupt saved preferences fall back to compact with a warning. Compact reduces calls through the skill workflow, rather than hiding completed calls: Codex owns the `Called` headers and exposes no supported per-call hiding flag in the inspected 0.166.0 interface. MCP `ui.visibility` controls model/app access, not terminal output.

In compact mode, a callback directs the agent to `monitor_event(event_ids)` for a visible trigger card, complete evidence and registered actions. After handling, `monitor_event(event_ids, resolution)` acknowledges those IDs and includes the final status in the same card. If evidence was already inspected and work completed, only the latter call is necessary. Do not acknowledge uninspected work just to combine calls. This replaces the old status/ack/stop/report sequence with one or two event cards. Naturally stopped observers require no extra stop call. Live observers continue until their deadline or explicit cancellation, and unrelated/newer events are preserved. Expired, superseded, suppressed and already acknowledged events retain their state; unknown IDs reject the whole selection before acknowledgements.

Every operation includes a fresh `report` in structured data, so compact mode can reuse that status before yielding if subsequent work has not made it stale. Verbose shows diagnostic detail and retains explicit status/ack/report calls. The CLI event card identifies the workload, trigger, exit status when available, review/acknowledgement state and running count. The optional HTML panel highlights the same selected events. A native wakeup alone remains a `functionCallOutput`; the event card appears when the awakened agent calls the MCP event tool. No extra model turn is submitted solely for UI rendering.

Codex CLI 0.166.0 does not render this HTML panel. Its `Called server.tool(arguments)` header and expand/collapse controls belong to Codex; the plugin controls the readable result beneath them. Confirm the user's actual client before troubleshooting graphics. CLI text output is not evidence of a desktop rendering failure. Keep the terminal workflow useful without a browser, model-driven refresh loops or claims of an embedded GUI.

The native `monitor_event` notification is readable text, not a JSON serialization. It retains exact monitor/event IDs so the agent can inspect `monitor_status`, follow the registered action and acknowledge the right event. Evidence and workload-provided instructions are not printed in the notification. Session recovery uses the same native channel with the retry attempt, policy, failed-turn ID and recovery ID. The host API provides only one output string for these notifications, so their necessary routing references remain visible.

`monitor_report` opens a live status panel on compatible hosts; other operation cards offer a button to start live updates. The timeline records monitor creation/arming/stopping, event delivery and acknowledgement, goal waits and recovery changes. History is capped at 128 transitions, with an explicit omitted count. Routine health samples are not lifecycle transitions.

The panel uses `monitor_report(after_revision, wait_ms)` with a bounded event wait (up to 25 seconds), then re-arms in the UI. This is long polling at the transport layer, not model-side polling or a model wakeup. There is at most one outstanding request per view and 32 per thread. Hidden/closed views stop re-arming; disconnects stop live mode until explicitly retried. Reports never launch an observer, enable recovery or submit a turn. Legacy services and hosts without MCP Apps retain snapshot/text results. Background changes cannot create arbitrary native chat items: they update the panel history, and the normal callback turn's tool calls render event cards. Stop/Interrupt hook messages remain host-controlled informational output.

To enable automatic stop reports, review and trust the installed plugin's exact Stop and Interrupt definitions using Codex `/hooks`. Finish all builds, dependency installation and file synchronization before reviewing hooks: Codex 0.166.0 also fingerprints the entire installed plugin directory. Changing runtime files, dependencies or documentation afterward invalidates approval, even if `hooks/hooks.json` is unchanged. Keep the installed bundle unchanged after approval. When the user has authorized this setup, the agent may complete that supported UI flow without asking again. The plugin never grants itself trust or bypasses Codex's trust enforcement. Hosts may require MCP Apps support to be enabled before displaying the HTML view.

For `plugin contents changed; hook approval required`, finish the update, inspect the installed reporting commands, then review the exact Stop and Interrupt hooks again in `/hooks`. Verify a fresh hook scan and actual execution; a loaded thread's cached `hooks/list` metadata can still say `trusted` after bundle contents change. Existing sessions may require a supported runtime configuration reload or reopening to load the new approval. Reloading only MCP servers does not refresh hook trust.

| Tool | Purpose |
| --- | --- |
| `monitor_start` | Register an observer; return readiness and deadline |
| `monitor_event` | Show selected triggers and evidence; optionally acknowledge handled events and return final status |
| `monitor_display` | Get/set per-thread compact or verbose presentation without restarting |
| `monitor_validate` | Read-only preflight, normalized settings and structured checks |
| `monitor_report` | Compact structured status without creating a service |
| `monitor_status` | Monitors, delivery, wait and recovery; select a monitor for full evidence |
| `monitor_stop` | Stop observation, preserving a watched PID |
| `monitor_wait` | Record dependency and optionally pause goal with authorization |
| `monitor_cancel_wait` | Cancel wait and mute its notifications; leave goal unchanged |
| `monitor_ack` | Record handled or dismissed events and their resolution |
| `monitor_recovery` | Configure bounded recovery after transient session errors |

Every tool requires the exact caller thread UUID. Per-thread state lives under `~/.codex/monitor-node` or `CODEX_MONITOR_HOME`, outside watched trees. The private local HTTP endpoint uses a random bearer token. Observers survive MCP disconnects. Services exit after one idle minute once observations, delivery, waits and recovery settle.

## Typed configuration and preflight

The existing `monitor_start` shape remains compatible, but `options` now advertises command/watchdog schemas in MCP `tools/list`: types, ranges, enums, descriptions and rejection of misspelled fields. `kind` is optional and inferred. A command without `match` observes exit only:

```json
{"thread_id":"<current UUID>","name":"tests","options":{"cwd":"C:/project","command":"npm test"},"instructions":"Inspect the test result and continue."}
```

For a file use `options: {"cwd":"C:/project","watch_file":"runs/metrics.json"}`; add `stalled_for_ms` for inactivity. The 30-minute default is finite; longer training needs an explicit lifetime. No shell command is executed by validation:

```json
{
  "thread_id":"<current UUID>",
  "request":{"operation":"start","config":{"name":"training","options":{"cwd":"C:/project","watch_file":"runs/metrics.json","stalled_for_ms":300000,"timeout_ms":86400000},"instructions":"Inspect suspected stalls."}}
}
```

Pass this to `monitor_validate`. Use `operation: "recovery"` with a recovery config to check authorization, timing and the current goal without enabling it. Result fields are `valid`, `normalized`, `checks`, `errors` (code/path/message), `warnings` and `checked_at`. Input schema/type errors use the standard MCP error response; semantic/environment failures return `isError: true` with structured evidence. Recovery previews omit authorization text; supply the original authorization when enabling.

Validation checks source combinations, ranges, regex/encoding, filesystem access, state-directory aliases, existing PIDs and an optional bounded `nvidia-smi` query. Host verification defaults on and only reads the exact loaded thread/goal; it does not resume or start a turn. `check_host: false` explicitly skips it. Missing watched files are supported when their parent exists. Commands are never executed to test them, so command existence/success is unverified. A custom `nvidia_smi` executable is run for a metrics query only when explicitly supplied. Observers are not armed by validation and a successful snapshot does not guarantee later readiness.

Start automatically repeats schema and local prerequisite checks before recording/arming a monitor. No monitor/event is created on a preflight failure. The service validates too, so bypassing MCP does not bypass these checks. Host verification is separate from registration: an observer can run even when callback delivery is unavailable.

## Automatic status reports

`monitor_report(thread_id)` returns a genuine MCP tool result with `type: monitor_report`, timestamps, summary counts, monitor deadlines, pending events, wait and recovery policy, and stop actions. It never creates a service, observer or model turn. If the service is unreachable, saved state is explicitly `verified: false`; historical `armed`/`enabled` fields are not proof of live supervision. Output omits raw evidence, commands and authorization text, and bounds histories with omitted counts.

The plugin includes synchronous `Stop` and `Interrupt` command hooks. They use the hook event's exact `session_id`, perform a bounded read, and return the hook protocol's JSON envelope with one human-readable `systemMessage`, such as `Monitor · 2 running`. They do not serialize the full report into that message. They never return a continuation/block decision or submit a callback, so reports cannot create an agent wake loop or override manual interruption. They do not cancel workloads or recovery; interruption handling remains the supervisor's responsibility.

Review and trust these hooks in Codex `/hooks` after installing/upgrading. Trust is required by Codex for the current hook definition, not granted automatically by this plugin. The host renders hook status messages; they are not synthetic MCP calls. `monitor_report` is the direct tool-call display path. `codex exec --json` can omit hook messages even when hooks execute, and host shutdown cannot guarantee a final report. See [official hook behavior and trust](https://learn.chatgpt.com/docs/hooks).

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

`cwd` must be a directory; an existing `watch_file` must be a regular file. File identity, size and timestamps are reconciled against the initial scan and previous observations, so unchanged startup/backend echoes do not create events or reset inactivity. Every observed file-version change resets inactivity even if its notification is debounced. Deletion and directory churn do not establish progress. This uses filesystem metadata rather than content hashing.

Polling samples metadata rather than recording every write. Same-size writes with unchanged modification time, directory changes whose metadata is unchanged, and transient changes between samples may be missed. Immediate writes can share a timestamp on Windows. Prefer the default native backend for local files; for polling, use progress signals that reliably change observable metadata (for example, append to a log). Preflight reports this limitation as a warning, not an invalid configuration.

GPU options: `gpu_id` (indices, UUIDs, PCI IDs, or `all`), `gpu_match` (`all`/`any`), `gpu_util_below`, `gpu_recover_above`, `gpu_below_for_ms`, `gpu_sample_ms`, `nvidia_smi`. Invalid/missing samples are unknown, never zero; they reset dwell evidence. In `any` mode the same card must remain low. `dead_if` combines file/GPU rules. Recovery events require `report_recovery: true` and `watchdog_recovered` in `notify_on`.

PID identity uses a Windows handle, Linux `/proc` start time, or macOS process start-time checks. POSIX checks are local, not model turns. A watchdog never signals the observed PID. macOS unrelated-process exit codes are unavailable and start-time resolution limits PID-reuse detection.

Commands use `kind: command`, `command`, `match` (JavaScript regex), optional `encoding`, `debounce_ms`, `max_events`, `timeout_ms` (maximum 30 minutes). They run through the platform shell. Lines are bounded to 16,000 characters. A Node guardian owns the tree; Windows kill-on-close jobs cover forced guardian termination. POSIX graceful cancellation cleans groups; SIGKILL cannot execute userspace cleanup. Watchdogs can run seven days; expiry notifies once and ends observation.

Command debounce suppresses only consecutive identical matching lines within its interval; different matches still produce sensor events. Pending notifications may subsequently be superseded by newer evidence or command exit; inspect event history when reconciling results.

## Native delivery and acknowledgement

The existing daemon's WebSocket proxy receives `turn/start` with `input: []` and `toolOutput`. Events retain `functionCallOutput` identity rather than becoming user chat messages. Standard MCP notifications alone do not imply a new turn. No undocumented MCP wake feature or chat fallback is used.

The service joins only an already-loaded thread for lifecycle notifications, without replacing it or changing its settings. Short event payloads carry IDs and evidence; full records are available through status. Model instructions and source evidence remain distinct.

Before sending, duplicates are coalesced, newer matching events supersede pending ones, acknowledged events are skipped, and expired events are discarded. A 250 ms batching window groups at most eight events. Registration/history are bounded. Reusing a name after an old monitor finishes supersedes that monitor's pending events.

Lifecycle: `pending -> sending -> submitted -> acknowledged`; alternatives include `superseded`, `expired`, `suppressed`, `failed`, and `unknown`. Turn completion does not prove every event was handled. Only `monitor_ack` records the agent's resolution. Acknowledgement/expiry cannot recall an already queued result. Uncertain submissions are not automatically retried; exactly-once execution is not guaranteed.

## Native goal waiting

Example authorization: “When only training remains, pause this goal; resume it on completion or a monitoring alert.” Supply the actual instruction in `goal_authorization`. Existing authorization persists; a nonempty string records intent but cannot prove consent.

Original goal viewing/editing/status remain in Codex. The plugin preserves objective, budget and usage, pauses the goal during external waiting, sends a native result, then resumes the same unchanged goal. Without authorization the wait does not suppress native continuation. Release is ANY selected monitor.

The wait result distinguishes `goal_control: paused` (pause confirmed), `unchanged` (notification-only waiting), `resumed` (resume confirmed), and `unverified` (control outcome must be inspected). These record the wait operation's control result, not a perpetual verification of the native goal. Equivalent monitor sets, instructions and authorization reuse the same active wait. Expired historical events do not block a new wait.

Native goal pause does not interrupt the current turn or stop running tools. After a confirmed pause the agent must finish its status report and yield; stopping the current turn is a separate host action. While a goal is manually paused, ordinary callbacks remain pending with `deferred_reason: Goal is paused`. Native goal updates release them after resume, subject to expiry. Only selected events from an authorized wait may wake its paused goal; unrelated events remain held. No model polling or recurring dispatch timer is used to wait for resume.

Later user edits, cancellation, exhausted budget, lost connection or ambiguous mutation stop restoration. Final accounting from the pausing turn may increase. The API lacks atomic compare-and-set; a user action racing the final verification remains a limitation.

Cancelled or disconnected waits mute their selected monitors, preventing later events from falling through into ordinary callbacks. Independent monitors retain their own delivery policy. Disconnect is deliberately not a transparent goal resume: inspect current state and explicitly rearm when appropriate. A submitted callback cannot be recalled, and pause/submit/resume are separate host operations rather than an atomic transaction.

If a pending wake is acknowledged or expires, the wait becomes `interrupted` and leaves the goal unchanged. If every selected observer ends without a deliverable event, it becomes `failed`. Muted observers cannot create another wait; inspect their state and explicitly register a new observer when needed. These cases require reconciliation rather than an automatic goal resume.

## Session recovery

Recovery requires separate user authorization:

```json
{
  "thread_id": "00000000-0000-0000-0000-000000000001",
  "enabled": true,
  "authorization": "Retry transient network errors, but never resume after I interrupt or pause.",
  "retry_mode": "transient",
  "retry_interval_ms": 300000,
  "max_elapsed_ms": 10800000,
  "lifetime_ms": 86400000,
  "check_interval_ms": 30000,
  "retry_rate_limits": false
}
```

Every attempt waits the same **300 seconds** after the eligible failure is observed. There is no exponential backoff and no catch-up burst after downtime. The first eligible failure starts a **three-hour incident window**; retries and daemon outages do not reset it. No new submission starts at or after its deadline. An already running turn is not terminated. A completed turn resets the incident while the supervisor remains enabled.

`retry_interval_ms` accepts 1,000–3,600,000 ms and `max_elapsed_ms` accepts 1,000–86,400,000 ms. Optional `max_attempts` accepts 1–86,400 and defaults to `ceil(max_elapsed_ms / retry_interval_ms)` (36 with defaults). This is a cap, not a promised attempt count: at most 35 attempts fit strictly before three hours when failures are immediate; host execution and checks can reduce that number. A smaller explicit cap stops earlier. `lifetime_ms` bounds the supervisor separately (24 hours by default, including healthy observation), and can also end recovery earlier.

For compatibility, `base_delay_ms` is accepted as a deprecated alias for the fixed interval. It must agree with `retry_interval_ms` if both are present. Legacy `max_delay_ms` is validated to be at least that interval, but no longer produces exponential backoff. Existing explicit settings still apply; reconfigure to adopt new defaults. Invalid configuration leaves an existing supervisor intact.

Timers and `check_interval_ms` read the local daemon, not the model. Codex retries first. The default `retry_mode: "transient"` accepts recognized terminal connection/stream/server failures; unknown and HTTP 401/403 errors remain ineligible, and rate-limit retries require `retry_rate_limits: true`. Codex 0.166.0 labels some truncated HTTP bodies `other`; narrowly matched observed transport signatures are eligible.

When the user's authorization covers all failed turns, set `retry_mode: "all_failed"`. It accepts unlisted/new errors, absent error details, authentication failures and rate limits, irrespective of `retry_rate_limits`. It does not treat error text in normal tool output, a completed turn or a silent running turn as failure. Explicit host error codes `sessionBudgetExceeded`, `usageLimitExceeded` and `misalignmentPolicyViolation` remain ineligible in both modes. A broader retry may still fail until its underlying cause is fixed.

The transient mode also recognizes the exact terminal message `stream disconnected before completion: Our servers are currently busy. Please try again in a moment.` when Codex classifies it as `other`. Arbitrary `other` errors require `all_failed`. Recovery must already be enabled; delivery and observation alone do not enable it.

Before retry, re-read latest turn, runtime status and goal. Interrupted turns, paused/ended goals, exhausted budget and new active work prevent recovery. Manual interruption disables the supervisor until re-enabled. Plugin waits suspend recovery. Silent long tools are not interrupted. Recovery continues the task after reconciling completed effects; it does not replay commands or restart training.

Daemon loss causes local reconnect checks until the supervisor or active incident deadline. No model action happens before verification. Error eligibility and deadlines are rechecked after asynchronous host reads and before submission. Ambiguous submission disables retries as `unknown`. Restart disables recovery and marks existing observation/wait interrupted; reconfigure explicitly. Host APIs have no atomic compare-and-start, so concurrent user actions remain a race boundary.

After an accepted retry, a stale latest-turn snapshot does not cause another submission for the same failed turn. `awaiting_host` means the supervisor is waiting locally for the submitted turn to appear. Only a distinct eligible failure can consume another retry attempt.

Official references: [native tool-result turns](https://learn.chatgpt.com/docs/app-server#start-a-turn), [plugin packaging](https://developers.openai.com/plugins/build/plugins), [MCP Events hosts](https://developers.openai.com/plugins/build/mcp-events).
