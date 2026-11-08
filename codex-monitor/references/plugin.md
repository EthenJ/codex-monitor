# Node plugin: native results and recovery

## Subagents

Version 0.4.1 automatically resolves Codex subagent ancestry. Every tool still
receives the exact caller's `thread_id`; no parent ID or routing configuration
is required. Only host-provided `parentThreadId` / `source.subAgent.thread_spawn`
metadata establishes ancestry. A fork or shared `sessionId` alone does not.

All branches of a verified task use one root-owned service, its 32 live observer
slots and its SSH connection pool. Registration names deduplicate only within
their creating thread. Each record includes `owner_thread_id`,
`creator_thread_id` and, when available, `creator_nickname`. The root can inspect
and manage all records; a child can inspect and manage its own subtree, but not
its ancestors' or siblings' observers. Display preferences remain per caller.
Root hooks summarize the entire task; child reports show the child's branch.
Capacity always reports the shared task limit.

The service bounds ancestry at 32 levels, concurrent delegated waits at 32 and
verified members at 128 per root task. Inactive members are reclaimed once they
have no active/unknown observers, unresolved events, pending wait preparation or
in-flight registration.
Historical provenance stays on monitor records. A task reaching that limit needs
explicit reconciliation, not registration retries. Existing observer/event
history bounds still apply.

Children use blocking `poll`, with unchanged native goals and the usual one-hour
default. Their default `wake_scope: thread` covers their branch; the root's covers
the task. Independent child waits may coexist with a root wait. Overlapping
child/descendant waits are rejected. A matching child wait has delivery priority,
then the root wait, then a root callback. Callbacks never target a closed child.
SSH incidents are partitioned by creator and evidence lifetime so a child's
acknowledgement cannot consume a sibling's incident. Only the root can configure
shared recovery or use pause-mode waiting; the installation recovery preset
activates once for the task and preserves previous opt-outs.

Events returned to a child carry `delivery_thread_id` and still need explicit
acknowledgement. When the child's turn ends or it closes, unacknowledged returned
events are handed to the root with `handoff.previous_delivery: unconfirmed`.
This is a reconciliation request, not permission to replay work. Events already
acknowledged stay settled. If the host disconnects during child handling, returned
evidence becomes `unknown` for root reconciliation. Service restart also marks
unfinished delivery unknown; neither silently replays uncertain effects, and
restart never silently rearms observers. Failure to persist a delegated handoff
releases its pending call as interrupted and holds callbacks for reconciliation.

Native agent messages, child queue changes, lifecycle changes and new CLI input
from verified ancestors release the child's pending call. The plugin returns
only a wake hint, never message text. The CLI history adapter must be readable
with persistence enabled. Parent pause/interruption takes precedence, including
during wait preparation. Child timeout/closure preserves observers; explicit
`stop(target: wait)` mutes that wait's selected notifications. Stopping a command
observer still kills its owned process tree. Child completion alone does not
authorize cancelling a long-running workload.

Ancestry is cached only from verified host metadata; cleanup uses saved verified
scopes during disconnection. If a new caller's host metadata cannot be read,
ordinary local observation retains the isolated-thread fallback with an explicit
warning: subagent routing and callbacks are **unverified**. A known child's owner
is never silently replaced with that fallback. Existing pre-0.4.1 child services
with active/unknown monitors, recovery, waits or unresolved events require
reconciliation with the previous plugin before routing can activate; live sensors
are not migrated or restarted. Upgrade only after finishing that cleanup.

These scopes prevent accidental cross-branch operations, not a security boundary
against local code or an agent spoofing another `thread_id`. Codex permissions,
tool approvals and sandbox rules still apply. In particular, a host may deny
mutating MCP tools in a read-only session; the plugin does not bypass that policy.

## Install

Requires Node.js 22.22+ (24 recommended), npm, Codex CLI 0.166.0+ and a compatible local Codex daemon. Validated with Codex 0.166.0. No Python runtime dependency.

Run the installation wizard from a complete source checkout or deployment package:

```text
node install.mjs
```

It asks for preferences, builds when needed, verifies a staged bundle and registers it through the official Codex commands. Use `--dry-run` for a preview. For agent-assisted answers, isolated simulation, upgrades and the activation checklist, read [Interactive installation](installation.md). Disable an older standalone skill copy to avoid duplicate guidance. Codex must find the same Node environment and dependencies.

Run bootstrap from an external terminal once per login/reboot. Its hidden launcher runs outside the MCP host's process job and installs no scheduled task/service. Stop it with `node codex-monitor/runtime/cli.js stop-broker`; existing observers retain their deadlines. Windows uses native breakaway flags and fails explicitly when denied; POSIX uses detached sessions.

## Tools and state

All eight MCP tools return readable plain text, structured data, and an optional MCP Apps view. Routine `status` and Stop/Interrupt messages are a single line, for example `Monitor · 2 running`. Starting/stopping counts and enabled automatic retry are included only when applicable. Inactive monitors, IDs and event history are omitted from routine text; full details remain in structured data and `status`. Unverified saved state produces `Monitor · live status unavailable` rather than a stale running count. No tool duplicates its JSON in text or uses Markdown tables: Codex CLI renders these blocks literally, including assistant-audience blocks.

Use `status(details: "active")` for a readable active-only list with each monitor's name, state, type and ID. Compact mode defaults to `details: "summary"`; verbose defaults to active details, with an explicit override available. The CLI's native transcript retains full result text; it controls preview and expansion. A Stop/Interrupt hook has no separate clickable detail field in the inspected CLI 0.166.0 interface. Switching to an MCP hook does not create an ordinary tool card, and plugin metadata cannot replace the CLI's raw invocation JSON with a custom summary.

Keep call arguments short: `poll` accepts omitted `resume_instructions`. A current live wait retains its instructions after goal ownership/readiness verification; a new wait defaults to inspecting the triggering event and continuing the existing task within authorization. Ended/restarted waits do not supply old instructions. Explicit instructions remain supported for changing the next action. Avoid repeating task history; use existing handoff references for lengthy context. This reduces raw invocation length without dropping required observation settings or granting goal authority.

## Observer capacity

Each root task and its subagents share 32 observer slots, with early warning at 24. Live reports and start results include `capacity: {used, limit, warning_at, remaining, state}`. Actual sensor reservations count, including starting/stopping and muted observers; historical records and recovery do not. A per-monitor snapshot still reports task-wide capacity. Unreachable/saved and legacy snapshots without reservation data report `capacity: null`, rather than claiming verified availability.

Pressure feedback appears in existing operation results and compact reports; it creates no callback or model turn. At full capacity, `MONITOR_CAPACITY_EXCEEDED` survives the local service and MCP layers with actionable guidance. Equivalent live registrations can still be reused. Do not blindly retry creation. Inspect active sources and reconcile obsolete observers first; deleting inactive history does not free slots.

Consolidate only compatible sources with the same workload and handling policy. One watchdog can combine a workload's PID, progress and GPU rules; narrow directory patterns may cover equivalent completion artifacts. A shared directory's aggregate activity cannot replace independent per-training inactivity detection. Preserve deadlines, notification rules, pending evidence and goal-wait guards, and verify replacement coverage before retiring observers. Never stop a required owned command just to free capacity: that terminates its command tree. If all observers are independent, retain coverage and explain the capacity constraint.

## Event display

`display` gets or sets `mode: "compact" | "verbose"` for the exact caller thread. Compact is the default. The setting lives in the thread's state directory, outside the installed plugin, and applies to subsequent tool calls and callbacks without a restart or hook reapproval. It does not change observation, delivery, recovery or goal policy. Invalid updates are rejected; corrupt saved preferences fall back to compact with a warning. Compact reduces calls through the skill workflow, rather than hiding completed calls: Codex owns the `Called` headers and exposes no supported per-call hiding flag in the inspected 0.166.0 interface. MCP `ui.visibility` controls model/app access, not terminal output.

In both display modes, a callback directs the agent to `event(event_ids)` for a visible trigger card, complete evidence and registered actions. After handling, `event(event_ids, resolution)` acknowledges those IDs and includes the final status in the same card. If evidence was already inspected and work completed, only the latter call is necessary. Do not acknowledge uninspected work just to combine calls. Naturally stopped observers require no extra stop call. Live observers continue until their deadline or explicit cancellation, and unrelated/newer events are preserved. Expired, superseded, suppressed and already acknowledged events retain their state; unknown IDs reject the whole selection before acknowledgements.

Operations include a fresh structured status snapshot in the `report` field; `status` returns that snapshot directly. Trusted Stop/Interrupt hooks provide routine end-of-turn summaries; neither display mode requires an extra status call or repeated monitor counts in the final answer. Explicit status calls remain available on request and for diagnostics. The CLI event card identifies the workload, trigger, exit status when available, review/acknowledgement state and running count. The optional HTML panel highlights the same selected events. A native wakeup alone remains a `functionCallOutput`; the event card appears when the awakened agent calls the MCP event tool. No extra model turn is submitted solely for UI rendering.

Codex CLI 0.166.0 does not render this HTML panel. Its `Called server.tool(arguments)` header and expand/collapse controls belong to Codex; the plugin controls the readable result beneath them. Confirm the user's actual client before troubleshooting graphics. CLI text output is not evidence of a desktop rendering failure. Keep the terminal workflow useful without a browser, model-driven refresh loops or claims of an embedded GUI.

The native `monitor.event` notification is readable text, not a JSON serialization. It retains exact monitor/event IDs so the agent can call `event`, follow the registered action and resolve the right event. Evidence and workload-provided instructions are not printed in the notification. Session recovery uses the same native channel with the retry attempt, policy, failed-turn ID and recovery ID. The host API provides only one output string for these notifications, so their necessary routing references remain visible.

`status` opens a live status panel on compatible hosts; other operation cards offer a button to start live updates. The timeline records monitor creation/arming/stopping, event delivery and acknowledgement, goal waits and recovery changes. History is capped at 128 transitions, with an explicit omitted count. Routine health samples are not lifecycle transitions.

The panel uses `status(after_revision, wait_ms)` with a bounded event wait (up to 25 seconds), then re-arms in the UI. This is long polling at the transport layer, not model-side polling or a model wakeup. There is at most one outstanding request per view and 32 per thread. Hidden/closed views stop re-arming; disconnects stop live mode until explicitly retried. Reports never launch an observer, enable recovery or submit a turn. Legacy services and hosts without MCP Apps retain snapshot/text results. Background changes cannot create arbitrary native chat items: they update the panel history, and the normal callback turn's tool calls render event cards. Stop/Interrupt hook messages remain host-controlled informational output.

To enable automatic stop reports, review and trust the installed plugin's exact Stop and Interrupt definitions using Codex `/hooks`. Finish all builds, dependency installation and file synchronization before reviewing hooks: Codex 0.166.0 also fingerprints the entire installed plugin directory. Changing runtime files, dependencies or documentation afterward invalidates approval, even if `hooks/hooks.json` is unchanged. Keep the installed bundle unchanged after approval. When the user has authorized this setup, the agent may complete that supported UI flow without asking again. The plugin never grants itself trust or bypasses Codex's trust enforcement. Hosts may require MCP Apps support to be enabled before displaying the HTML view.

For `plugin contents changed; hook approval required`, finish the update, inspect the installed reporting commands, then review the exact Stop and Interrupt hooks again in `/hooks`. Verify a fresh hook scan and actual execution; a loaded thread's cached `hooks/list` metadata can still say `trusted` after bundle contents change. Existing sessions may require a supported runtime configuration reload or reopening to load the new approval. Reloading only MCP servers does not refresh hook trust.

| Tool | Purpose |
| --- | --- |
| `start` | Register an observer; return readiness and deadline |
| `event` | Show selected triggers and evidence; optionally acknowledge handled events and return final status |
| `display` | Get/set per-thread compact or verbose presentation without restarting |
| `validate` | Read-only preflight, normalized settings and structured checks |
| `status` | Read-only summary, active list or full evidence; never starts a service |
| `stop` | Stop a selected observer, or use `target: "wait"` to stop only waiting |
| `poll` | Block until an event, CLI input or timeout; explicit pause mode retains authorized native pause/resume |
| `recovery` | Configure bounded recovery after eligible session errors |

Every tool requires the exact caller thread UUID. Per-thread state lives under `~/.codex/monitor-node` or `CODEX_MONITOR_HOME`, outside watched trees. The private local HTTP endpoint uses a random bearer token. Observers survive MCP disconnects. Services exit after one idle minute once observations, delivery, waits and recovery settle.

These short tool IDs use the `monitor` MCP namespace, for example `monitor.start`,
`monitor.poll` and `monitor.event`. v0.3.0 replaces the old `monitor_`-prefixed
IDs; reload the upgraded plugin so the current conversation sees the new list.
The native callback is also `monitor.event`, but it is a routing notice;
invoke the MCP event tool for full evidence and structured timing.

The public API also merges the former reporting and acknowledgement operations:
`status` supports summaries, active lists, full evidence and UI revision waits;
`event` handles both inspection and resolution. Cancel waiting with
`stop(target: "wait")`, or stop an observer with `stop(monitor_id: ...)`.
Stopping one observer releases any wait that depends on it for reassessment,
without muting the other observers or changing the goal. An explicitly stopped
wait still mutes its selected notifications. After handling the stop, establish
another wait for remaining work when appropriate.
Exactly one stop target is required. Stopping waiting releases the pending call
and mutes its selected notifications while preserving observers, processes and
the native goal; a pause-mode goal remains paused. There are no separate public
`report`, `ack` or `cancel_wait` tools.

## Typed configuration and preflight

The existing `start` shape remains compatible, but `options` now advertises command/watchdog schemas in MCP `tools/list`: types, ranges, enums, descriptions and rejection of misspelled fields. `kind` is optional and inferred. A command without `match` observes exit only:

```json
{"thread_id":"<current UUID>","name":"tests","options":{"cwd":"C:/project","command":"npm test"},"instructions":"Inspect the test result and continue."}
```

For a file use `options: {"cwd":"C:/project","watch_file":"runs/metrics.json"}`; add `stalled_for_ms` for inactivity. The 30-minute default is finite; longer training needs an explicit lifetime. Validation does not execute workload commands; SSH preflight runs bounded observation queries:

```json
{
  "thread_id":"<current UUID>",
  "request":{"operation":"start","config":{"name":"training","options":{"cwd":"C:/project","watch_file":"runs/metrics.json","stalled_for_ms":300000,"timeout_ms":86400000},"instructions":"Inspect suspected stalls."}}
}
```

Pass this to `validate`. Use `operation: "recovery"` with a recovery config to check authorization, timing and the current goal without enabling it. Result fields are `valid`, `normalized`, `checks`, `errors` (code/path/message), `warnings` and `checked_at`. Input schema/type errors use the standard MCP error response; semantic/environment failures return `isError: true` with structured evidence. Recovery previews omit authorization text; supply the original authorization when enabling.

Validation checks source combinations, ranges, regex/encoding, filesystem access, state-directory aliases, existing PIDs and an optional bounded `nvidia-smi` query. Host verification defaults on and only reads the exact loaded thread/goal; it does not resume or start a turn. `check_host: false` explicitly skips it. Missing watched files are supported when their parent exists. Commands are never executed to test them, so command existence/success is unverified. A custom `nvidia_smi` executable is run for a metrics query only when explicitly supplied. Observers are not armed by validation and a successful snapshot does not guarantee later readiness.

Start automatically repeats schema and local prerequisite checks before recording/arming a monitor. Failures of those checks create no monitor/event. SSH sources check remote readiness on the shared connection during registration; a remote failure retains a failed record and its diagnostic event. The service validates too, so bypassing MCP does not bypass these checks. Host verification is separate from registration: an observer can run even when callback delivery is unavailable.

## Automatic status reports

`status(thread_id)` returns a genuine MCP tool result with `type: monitor_report`, timestamps, summary counts, monitor deadlines, pending events, wait and recovery policy, and stop actions. It never creates a service, observer, recovery policy or model turn. If the service is unreachable, saved state is explicitly `verified: false`; historical `armed`/`enabled` fields are not proof of live supervision. The default summary omits raw evidence, commands and authorization text. `details: "active"` adds a readable active list; `details: "full"` includes bounded configuration and evidence in structured data. `monitor_id` selects one observer and implies full details, including up to eight of its historical events. Counts and capacity remain thread-wide. UI `after_revision`/`wait_ms` cannot be combined with a selected observer or full details; `wait_ms` requires `after_revision`.

The plugin includes synchronous `Stop` and `Interrupt` command hooks. They use the hook event's exact `session_id`, perform a bounded read, and return the hook protocol's JSON envelope with one human-readable `systemMessage`, such as `Monitor · 2 running`. They do not serialize the full report into that message. They never return a continuation/block decision or submit a callback, so reports cannot create an agent wake loop or override manual interruption. They do not cancel workloads or recovery; interruption handling remains the supervisor's responsibility.

Review and trust these hooks in Codex `/hooks` after installing/upgrading. Trust is required by Codex for the current hook definition, not granted automatically by this plugin. The host renders hook status messages; they are not synthetic MCP calls. `status` is the direct tool-call display path. `codex exec --json` can omit hook messages even when hooks execute, and host shutdown cannot guarantee a final report. See [official hook behavior and trust](https://learn.chatgpt.com/docs/hooks).

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

The service joins only an already-loaded thread for lifecycle notifications, without replacing it or changing its settings. Short event payloads carry IDs and trigger summaries; full evidence and registered actions are available through `event` or `status`. Model instructions and source evidence remain distinct.

Before sending, duplicates are coalesced, newer matching events supersede pending ones, acknowledged events are skipped, and expired events are discarded. A 250 ms batching window groups at most eight events. Registration/history are bounded. Reusing a name after an old monitor finishes supersedes that monitor's pending events.

Callback lifecycle: `pending -> sending -> submitted -> acknowledged`. Blocking delivery uses `pending -> returned -> acknowledged`; additional callbacks stay local while returned evidence awaits reconciliation. Alternatives include `superseded`, `expired`, `suppressed`, `failed`, and `unknown`. Turn completion does not prove every event was handled. Explicit acknowledgement through `event` with a resolution records the agent's resolution. Acknowledgement/expiry cannot recall an already queued result. Uncertain submissions are not automatically retried; exactly-once execution is not guaranteed.

Before writing a callback, the plugin rechecks event expiry, cancellation,
recipient eligibility and observed goal/wait changes after its final host read.
A cancelled member does not prevent unaffected events in the same batch from
being delivered. History pressure reclaims only settled events; failed deliveries
remain available for inspection. These checks cannot recall a write already sent
or make host reads and writes atomic.

Event results carry structured `timing` for the agent: `wait_elapsed_ms`,
`wait_basis` (`poll`, `monitor`, or `unknown`), `wait_started_at`,
`monitor_registered_at` and `monitor_elapsed_ms`. Poll-associated events also
identify `wait_id` and `wait_mode`. Durations are frozen when the supervisor
observes the event, excluding callback queues and later inspection; source
timestamps cannot override them. Missing historical timing remains unknown.
They are available through `event`, `status`, structured reports
and blocking results. Callback routing text, regular cards, hooks and the HTML
panel do not add timing output. Agents use the data internally unless asked.

## CLI blocking waits

The default `poll` mode is `blocking`. Omit `timeout_ms` for a one-hour
wait; when supplied, the valid value takes precedence. Schema and service fill
the default only when omitted. Maximum wait is 24 hours. `input_poll_ms` controls local
sampling (50–5,000 ms, default 250 ms) without model calls. Require finite live
error/expiry fallbacks and reconcile unresolved thread events before waiting.

The tool stays pending in the current active turn while the native goal stays
active or absent. An externally paused/ended goal is never resumed. An eligible
event, finite timeout or new CLI input releases the call. Events and registered
actions return in the same MCP result, without injecting another callback turn.
Inspect and acknowledge handled IDs. `returned` records the prepared handoff,
not confirmed receipt or acknowledgement. Timeout returns once; reassess work
rather than repeatedly making short wait calls. Goal elapsed time may continue.

CLI 0.166.0 queues steering input before emitting a user-message event. Polling
`thread/read` or persisted turns cannot detect it while a normal MCP call stays
pending. The adapter instead incrementally reads newly appended records in
`<CODEX_HOME>/history.jsonl`, matching only the caller UUID. Existing prompts and
other threads never wake the call. Message text is not replayed or treated as
authorization; Codex consumes its own queued input when the tool returns.
History must be enabled and readable; `history.persistence = "none"` refuses
blocking even when an old history file remains. This adapter is specific to CLI behavior,
not a stable input-queue protocol or a promise of desktop support.

Missing history refuses registration. Replacement, truncation or loss of read
access releases as `input_unavailable` instead of silently waiting indefinitely.
MCP/host disconnect releases the call and holds callbacks while preserving live
observers and evidence. Reconnect, reconcile unresolved events, then attach a new
wait. Explicit cancellation or manual interruption still suppresses notifications.
An actual service restart marks observers unknown and never reruns workloads.

The packaged MCP timeout is 86,420 seconds, covering the 24-hour maximum and
cleanup; host/user overrides may be shorter. Local HTTP cancellation releases
the wait. Only the input-tail sampler runs repeatedly, not the model.

## Native goal waiting

This compatibility workflow requires explicit `mode: "pause"`; it is no longer
the default CLI wait.

Example authorization: “When only training remains, pause this goal; resume it on completion or a monitoring alert.” Supply the actual instruction in `goal_authorization`. Existing authorization persists; a nonempty string records intent but cannot prove consent.

Original goal viewing/editing/status remain in Codex. The plugin preserves objective, budget and usage, pauses the goal during external waiting, sends a native result, then resumes the same unchanged goal. An active goal without `goal_authorization` returns the MCP error `goal_pause_required` / `GOAL_PAUSE_AUTHORIZATION_REQUIRED`, rather than registering a notification-only wait. Reuse the applicable existing user instruction. Notification-only waiting remains available when no goal is active.

Before pausing, `poll` checks **all unhandled events in this exact conversation**, not just the supplied IDs. Submitted, unknown and failed deliveries also require reconciliation. `state: ready` returns event IDs when available; handle them before trying to wait again. It also returns ready when no verified live source exists. Live sources must have finite deadlines and notify on both `monitor_error` and `monitor_expired`; missing fallbacks return the MCP error `guard_required` / `MONITOR_GUARD_REQUIRED` without pausing. Training additionally needs meaningful PID/progress/GPU monitoring; expiry/error delivery is a minimum bounded fallback, not proof of training health. Readiness is checked again after asynchronous goal reads to catch newly arrived events.

Default `wake_scope: "thread"` releases on **ANY monitor in the same conversation**, including newly registered sources. `monitor_ids` is optional, and passing it alone does not narrow the wake scope. For an explicitly narrower policy, set `wake_scope: "selected"` and supply a nonempty ID list. Only the exact caller thread is included. Routine training progress must stay quiet across all sources (`watchdog_only: true`); a file change or output match that is subscribed for notification releases an ANY-event wait.

```json
{
  "thread_id": "<exact caller CODEX_THREAD_ID>",
  "mode": "pause",
  "resume_instructions": "Inspect the triggering event, reconcile its effects and continue the goal.",
  "goal_authorization": "<existing user instruction to pause while waiting and resume on any monitor event>"
}
```

The tool blocks until the pause RPC, matching native goal notification and unchanged paused-goal read are confirmed. Verify `state: waiting` and `goal_control: paused` before yielding. It records `pause_barrier: draining` while the calling turn is active. Native goal pause does not interrupt that turn or its tools: end the turn promptly once the pause is confirmed. Waiting synchronously inside that turn for its own completion would deadlock.

Early monitor events remain pending until native lifecycle notifications and a host read establish idle (`pause_barrier: ready`) with the same goal still paused. Only then may the service submit the wake and restore the goal. There is no model polling or recurring dispatch timer during this barrier. A quiet wait does not submit a new turn. Live reports distinguish `goal paused; finishing current turn` from `goal waiting for event`. A plain running count never establishes goal pause.

The wait result distinguishes `goal_control: paused`, `unchanged`, `resumed` and `unverified`. These record the operation's control result, not perpetual verification of the native goal. Equivalent scope, requested IDs, instructions and authorization reuse the active wait but still check unresolved events. Expired historical events do not block a new wait. `guard_ids` records verified fallback sources at registration; a monitor may naturally stop after producing an event.

Pause ownership is tracked separately from the wait record. `pause_owner: plugin` comes from a confirmed plugin pause and a matching native goal; ordinary usage accounting preserves it. Follow-up messages do not revoke it. A subsequent `poll` can update the live wait in place, or explicitly rearm a cancelled/replaced dependency, reusing the unchanged plugin pause without first activating it. The applicable conditional authorization is retained privately while ownership is verified. Cancelling a wait still mutes its notifications and never resumes the goal; rearming is a separate explicit operation.

A new explicit goal action (including an identical same-second manual pause), user interruption, disconnect or service restart revokes ownership. `pause_owner: external` means an observed goal action outside this plugin, which may be the user or another client; `unknown` means ownership could not be established. The native paused status alone is never adopted. `state: goal_paused`, `goal_control: unchanged` is a normal readable refusal to take over an external/unverified pause, not a failed pause attempt. Resume the goal explicitly before requesting automatic waiting in that case. Ended/absent/exhausted goals return `goal_unavailable` / `GOAL_UNAVAILABLE`. Reports expose only ownership metadata, not the retained goal snapshot or authorization. Ownership is not restored from saved state after restart.

Manual goal pause holds ordinary callbacks locally until native resume; expiry still applies. A later manual pause, goal edit, user interruption, disconnect or ambiguous native state cancels conditional restoration. Cancelled/disconnected waits mute their wake sources, so later events cannot fall through into ordinary callbacks. Sources outside an explicitly selected scope retain their independent policy. Inspect and explicitly rearm when appropriate. A submitted callback cannot be recalled, and pause/submit/resume are separate host operations rather than an atomic transaction.

If a pending wake is acknowledged or expires, the wait becomes `interrupted` and leaves the goal unchanged. If every wait observer ends without a deliverable event, it becomes `failed`. Muted observers cannot create another wait. These outcomes require reconciliation rather than automatic goal resume.

## SSH monitoring

Add `transport: {"type":"ssh","host":"gpu-box"}` to a start configuration
to observe an existing Linux workload. Omit transport for local behavior. SSH
uses the local OpenSSH executable and the selected alias/configuration, including
jump hosts, identity selection and known-host trust. It does not install remote
packages, modify training code, open a remote listener or start a daemon.
The client must support `ForkAfterAuthentication`, `StdinNull` and `SessionType`:
the plugin fixes these to `no`, `no` and `default` so a conflicting host profile
cannot detach the owned process or disable its command/input channel. Existing
authentication, target selection and jump-host configuration remain applicable.

```json
{
  "thread_id": "<exact-current-thread-id>",
  "name": "remote-training",
  "transport": { "type": "ssh", "host": "gpu-box" },
  "options": {
    "cwd": "/srv/training", "pid": 12345,
    "watch_file": "runs/metrics.jsonl", "stalled_for_ms": 300000,
    "gpu_util_below": 10, "gpu_below_for_ms": 120000,
    "watchdog_only": true, "timeout_ms": 86400000
  },
  "instructions": "Inspect connectivity and training evidence; do not restart training automatically."
}
```

The remote host needs Linux, `sh`, GNU-compatible `timeout` (including `-k`) and
`base64 -w 0`. File/PID sources need `stat`/`cat`; directory sources use compatible
`find -printf`; GPU rules use `nvidia-smi`. Node/Python and a writable home are
not required. Unsupported capabilities fail explicitly; no fallback installs
software. Public `validate` opens a temporary read-only probe, while `start`
checks readiness on the shared persistent connection.
Registration has its own finite deadline, separate from observer lifetime and
reconnect budget. Cancellation or a disconnected caller during registration
removes that new observer; a queued cancelled request cannot attach one later.

Transport fields: `host`, optional `user`, `port`, absolute local `identity_file`
and `config_file`; `connect_timeout_ms` defaults to 10000, `query_timeout_ms`
to 5000, and `heartbeat_ms` to 15000. `reconnect` defaults to
`{"enabled":true,"max_elapsed_ms":1800000}`. Reconnect delays are approximately
5, 15, 30 and then 60 seconds with jitter. Reconnection is bounded by the incident
budget and monitor lifetimes. It is independent of Codex turn recovery. Conflicting
policies on the same shared target are rejected; inspect/reconcile before changing
them. Unknown host keys or interactive authentication must be resolved through
the user's normal SSH workflow; the plugin does not weaken verification.

One thread shares one connection per target/profile. File/PID sampling defaults
to 10 seconds, directories to 30 seconds and GPUs to 15 seconds; `poll_ms` and
`gpu_sample_ms` can override these, with a one-second minimum. Sampling is local
background scheduling with no model invocations. Directory snapshots have a
4096-entry bound, finite query time and a bounded response size. Narrow
the root when a limit is reached. Native file events are not supported by this
adapter. Snapshot changes and GPU dwell are sampled observations, not complete
event histories or proof of uninterrupted low utilization.
`debounce_ms` suppresses repeated created/modified notifications for each path;
every observed file-version change still resets inactivity. Deletions are delivered
without debounce and clear that path's suppression, so recreation remains visible.

`kind: "connection"` with `options: {"timeout_ms": ...}` watches the connection
without a workload `cwd`, PID or file. It uses the same shell round-trip checks;
it is not a separate transport-only implementation. Remote `kind: "command"`
is rejected: the plugin does not take ownership of an independently launched job.

`connection_lost`, `connection_unresponsive` and `connection_restored` are default
remote notifications. Loss or response timeout is generated locally. A shared
incident has `affected_monitor_ids`; event inspection and blocking results include
each monitor's registered instructions. Stops/mutes suppress only affected
subscriptions. Connection events do not consume workload `max_events`. Incidents
are grouped only among subscriptions with the same event lifetime, so
one monitor's short `event_ttl_ms` cannot expire another's evidence early. A restored
connection must remain stable for 60 seconds before a recovery notification,
coalescing flaps into the original incident. Individual sensors can fail even
when the SSH connection is healthy.
Event results mark recipients as `actionable` and omit instructions for cancelled,
muted or already handled recipients. Shared evidence may still concern remaining
recipients; only their current actionable instructions apply.

An active poll can wake on a relevant connection incident. Subsequent waits
require reconciliation plus live bounded reconnect/error/expiry guards. For
custom `notify_on`, include both loss/unresponsive events and `monitor_error`/
`monitor_expired`. Native goals and CLI input wake retain their existing rules.

After a gap the adapter checks process identity (boot ID, PID and start time),
file-root identity and fresh GPU data. Disconnection is unknown health, not a
process exit or training stall. File/GPU continuity resets across missing
observations; unseen events are not replayed. A disappeared/reused PID does not
provide a trustworthy exit code or exact exit time. Stopping a remote monitor
closes only its observation; stopping the last one closes the owned SSH session.
Its slot remains occupied as `stopping` until local SSH cleanup completes;
repeated stop requests await that same cleanup. Source intervals are evaluated
using the fastest enabled source, so a slow GPU interval cannot hide interrupted
file/PID observation. GPU-only monitors do not perform metadata-only sample ticks.
Gap checks also run after remote reads: a long pause while a query is outstanding
cannot establish file/GPU dwell on its return. GPU sampling intervals start from
completed observations, avoiding immediate catch-up queries after a slow response.
Queries have remote deadlines as well as local bounds, but kernel-stuck remote
processes cannot be promised immediate termination by closing the local client.
Oversized sample responses are drained within the request deadline and fail only
that source; a malformed or incomplete protocol can still fail the shared
connection. GPU provider commands run in the remote workload `cwd`, and their
short-lived cache is scoped to that directory as well as provider/device selection.

## Session recovery

Recovery defaults to enabled on the first monitor/wait operation in a new thread,
unless setup selected `recovery: false`. Its preset is `all_failed`, fixed
300-second delay, a three-hour incident limit and a separate 24-hour supervisor
lifetime. It is initialized once, not after every monitor call. Explicit disable,
manual interruption, exhausted policies, restart and uncertain submissions are
never silently re-enabled. Merely installing or displaying the plugin does not
start a per-thread supervisor. A host verification failure is reported as
`default_unavailable` rather than claiming recovery is running.

Use `recovery(enabled: false)` for a per-thread opt-out. To explicitly
enable or customize a policy, include the applicable authorization, for example:

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

Timers and `check_interval_ms` read the local daemon, not the model. Codex retries first. The installation preset uses `all_failed`. An explicit `recovery` configuration that omits `retry_mode` uses the API default `transient`, which accepts recognized terminal connection/stream/server failures; unknown and HTTP 401/403 errors remain ineligible, and rate-limit retries require `retry_rate_limits: true`. Codex 0.166.0 labels some truncated HTTP bodies `other`; narrowly matched observed transport signatures are eligible.

When the user's authorization covers all failed turns, set `retry_mode: "all_failed"`. It accepts unlisted/new errors, absent error details, authentication failures and rate limits, irrespective of `retry_rate_limits`. It does not treat error text in normal tool output, a completed turn or a silent running turn as failure. Explicit host error codes `sessionBudgetExceeded`, `usageLimitExceeded` and `misalignmentPolicyViolation` remain ineligible in both modes. A broader retry may still fail until its underlying cause is fixed.

The transient mode also recognizes the exact terminal message `stream disconnected before completion: Our servers are currently busy. Please try again in a moment.` when Codex classifies it as `other`. Arbitrary `other` errors require `all_failed`. First monitor/wait use enables the installation preset once unless opted out; later delivery and observation never re-enable a stopped policy.

Before retry, re-read latest turn, runtime status and goal. Interrupted turns, paused/ended goals, exhausted budget and new active work prevent recovery. Manual interruption disables the supervisor until re-enabled. Plugin waits suspend recovery. Silent long tools are not interrupted. Recovery continues the task after reconciling completed effects; it does not replay commands or restart training.

After the final host read, retry submission rechecks opt-outs, interruptions,
observed host activity and its elapsed deadline. An aborted preparation does not
consume an attempt. Active work and monitor waits clear overdue retry timestamps,
so background checks retain their normal cadence; a later eligible failure starts
the configured delay again.

A monitor wait established during those host reads also suspends recovery;
its plugin-owned goal pause does not disable the supervisor. During daemon
outages, local reconnect checks retain `check_interval_ms` even when a model
retry is overdue; the original retry deadline and incident budget are preserved.

Daemon loss causes local reconnect checks until the supervisor or active incident deadline. No model action happens before verification. Error eligibility and deadlines are rechecked after asynchronous host reads and before submission. Ambiguous submission disables retries as `unknown`. Restart disables recovery and marks existing observation/wait interrupted; reconfigure explicitly. Host APIs have no atomic compare-and-start, so concurrent user actions remain a race boundary.

After an accepted retry, a stale latest-turn snapshot does not cause another submission for the same failed turn. `awaiting_host` means the supervisor is waiting locally for the submitted turn to appear. Only a distinct eligible failure can consume another retry attempt.

Official references: [native tool-result turns](https://learn.chatgpt.com/docs/app-server#start-a-turn), [plugin packaging](https://developers.openai.com/plugins/build/plugins), [MCP Events hosts](https://developers.openai.com/plugins/build/mcp-events).
