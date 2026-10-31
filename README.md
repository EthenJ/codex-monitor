# codex-monitor

[![Tests](https://github.com/EthenJ/codex-monitor/actions/workflows/test.yml/badge.svg)](https://github.com/EthenJ/codex-monitor/actions/workflows/test.yml)

A local Codex plugin for workload events and training watchdogs. Register a monitor through MCP, keep working, and receive a follow-up in the same thread when a meaningful event occurs. Routine training progress stays local. The original standalone skill and helper commands remain available.

The plugin adds structured registration, status and cancellation, detached observation across MCP disconnects, short event batches, and an explicit goal wait. With the user's conditional pause/resume authorization, it pauses an active native goal while external work is pending and resumes the unchanged goal after submitting an event. This avoids automatic goal continuation turns that only check whether training has finished. Native goal waiting is experimental and requires access to the same local Codex daemon.

## Install the plugin

Run from this repository with Python 3.10+:

```text
python -m pip install -e ".[plugin,platform]"
python codex-monitor/scripts/plugin_runtime.py bootstrap
codex plugin marketplace add .
codex plugin add codex-monitor@codex-monitor
```

Restart Codex to load the tools. `.mcp.json` launches `python`; dependencies must be available to that interpreter. If using a virtual environment, launch Codex from the activated environment or configure an absolute interpreter path. Disable a previously installed standalone copy of the skill to avoid duplicate guidance. See [plugin usage and goal waiting](codex-monitor/references/plugin.md) for examples and limitations.

`bootstrap` starts the local launcher outside the MCP host's process group, so strict Windows MCP clients can disconnect without killing observations. Run it once per login/reboot in a terminal using the same Python environment. It does not call the model or install a scheduled task. `python codex-monitor/scripts/plugin_runtime.py stop-broker` stops the launcher; existing observers keep their own deadlines.

Tools: `monitor_start`, `monitor_status`, `monitor_stop`, `monitor_wait`, and `monitor_cancel_wait`. The agent supplies the exact current thread UUID, a stable workload name, absolute working directory, trigger, deadline and next action. Users can request the workflow in plain language:

> Monitor this training run. Keep routine progress quiet, alert on failure or stalled metrics, and evaluate after completion. When only training remains, pause the goal and resume it on completion or an alert.

No Codex source build, hooks, or API key is required. Sensors run in a separate local plugin service. `monitor_wait` returns immediately; it does not keep an MCP tool call open or add a native `waiting` status to Codex. Goal pause/resume is conditional user-authorized automation, never inferred just from a monitoring request. The underlying API has no atomic goal compare-and-set, so concurrent user lifecycle changes remain a documented limitation.

To build a deployment-only directory from `develop`:

```text
python tools/build_plugin.py dist/codex-monitor
```

This includes the plugin manifest, MCP configuration, skill and runtime, with no tests, workflows, validation reports, virtual environments or local state. On the published deployment branch, install directly from that branch's checkout. The plugin changes are developed separately from the existing v0.1 release.

This is the local CLI implementation of the behavior Claude Code ships as its **Monitor tool**. A monitor starts before the workload, receives events from the workload or OS, and calls:

```text
codex queue --thread <thread-id> --message <event-prompt> --resume
```

The repository is the Codex counterpart of Claude Code's **Monitor tool**, and is named the same way: host prefix plus the tool name. It exposes a generic `--callback-command` seam for a host application or an OpenAI Agents API adapter.

Naming note: this tool monitors **your workload** - command output, files, training health, GPU, a PID - and wakes Codex when something happens. It does not inspect or supervise the Codex session itself; the session is the *destination* of the callback, not the thing being observed.

**Tested locally on Windows and Ubuntu, including live NVIDIA GPUs on Ubuntu.** CI covers Windows, Ubuntu, and macOS; see [Platform status](#platform-status) and the commit-specific workflow results for the tested revision.

The new v0.2 plugin and goal bridge have currently been validated on Windows. Ubuntu/GPU results above apply to the earlier standalone runtime; plugin validation on Ubuntu and macOS is pending. See [plugin validation](https://github.com/EthenJ/codex-monitor/blob/develop/docs/plugin-validation.md) on `develop` for the tested scope.

## Features

- Streaming command-output events with regex matching, debouncing, deadlines, and one-shot limits.
- Native Windows directory events through overlapped `ReadDirectoryChangesW`.
- Cross-platform directory events through the optional `watchdog` package, with an explicit snapshot fallback.
- File or directory inactivity watchdogs with startup grace periods.
- NVIDIA GPU low-utilization watchdogs using `nvidia-smi`, dwell time, recovery hysteresis, and `all`/`any` aggregation.
- Existing PID observation without killing or restarting the observed process.
- Edge-triggered `watchdog_stalled` and `watchdog_recovered` events.
- JSONL lifecycle and callback logs; callback payloads arrive on stdin for custom callbacks.
- `--dry-run`, callback timeouts, no automatic retries, and explicit process/session diagnostics.
- MCP registration/status/stop tools and a per-thread detached service with bounded persistent state.
- Quiet training waits, event coalescing and explicit conditional goal pause/resume.

## Requirements

- Python 3.10 or newer.
- Codex CLI 0.166.0 or a compatible version that supports `codex queue --thread ... --resume`.
- A `CODEX_THREAD_ID` environment variable in the registering Codex process, or an explicit `--codex-thread` UUID/name.
- NVIDIA GPU alerts require `nvidia-smi`. GPU provider failure is reported as unknown; it is never treated as 0% utilization.

Optional dependencies:

```powershell
python -m pip install -e ".[platform]"
```

`watchdog` enables native file events on Linux/macOS. `psutil` is used as the PID-wait fallback when `pidfd_open` is unavailable or blocked by the kernel/container. Windows uses native APIs and does not need either package for the default path. The editable install ships no importable package (`packages = []`); it exists to resolve the optional dependencies for the scripts in `codex-monitor/scripts`.

## Install the standalone skill

On Ubuntu, first create a project environment with native file-event support:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[platform]'
python -W error::ResourceWarning -m unittest discover -s tests -v
```

Run the scripts with this environment's Python. For a read-only GPU check that prints callback commands locally:

```bash
python codex-monitor/scripts/watchdog_monitor.py \
  --gpu-id all --gpu-match any --gpu-util-below 10 \
  --gpu-below-for-ms 2000 --gpu-sample-ms 500 \
  --timeout-ms 10000 --codex-thread gpu-check --dry-run
```

Only a threshold transition or sensor failure produces an event. Use the opt-in live tests below to check sampling even while every card is busy.

Copy the `codex-monitor` directory into the Codex skill directory:

```powershell
$skillHome = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $HOME '.codex\skills' }
New-Item -ItemType Directory -Force -Path $skillHome | Out-Null
Copy-Item -Recurse -Force .\codex-monitor (Join-Path $skillHome 'codex-monitor')
```

Then invoke it explicitly with `$codex-monitor`, or let Codex discover it when the request is about event callbacks or training health monitoring.

## Command-output callback

Use `monitor_callback.py` when the observed program itself emits the event:

```powershell
python .\codex-monitor\scripts\monitor_callback.py `
  --command "python -u .\scripts\build.py" `
  --match "BUILD (PASSED|FAILED)" `
  --codex-thread $env:CODEX_THREAD_ID `
  --message-template "Build event: {event}. Inspect the output and continue." `
  --max-events 1 --timeout-ms 1800000
```

Use `--dry-run` to verify the callback command without submitting it. The monitor owns and stops this child command on cancellation, event limit, or deadline.

Command output defaults to UTF-8 with replacement for invalid bytes; pass `--encoding gb18030` (or another Python codec) for a legacy producer. A line longer than 16,000 characters produces an explicit `monitor_error`. The matched-line queue is bounded and applies backpressure. Messages sent to Codex are capped at 6,000 characters with a truncation marker to fit Windows command-line limits.

## Directory events

Use `watchdog_monitor.py` for checkpoints or generated artifacts:

```powershell
python .\codex-monitor\scripts\watchdog_monitor.py `
  --watch-directory .\runs --recursive --pattern "*.ckpt" `
  --codex-thread $env:CODEX_THREAD_ID `
  --message-template "Checkpoint {change}: {path}. Inspect the artifact." `
  --max-events 1 --timeout-ms 1800000
```

The watcher is armed before the `started` event is emitted. On Windows the backend is `ReadDirectoryChangesW`; on other platforms the JSONL `backend` record identifies `watchdog` or `snapshot-fallback`.

Directory symlinks are resolved when the subscription is armed, and callback paths retain the registered alias. A monitored file that is itself a symlink uses snapshot fallback in auto mode; explicit native mode requires its target path or `--file-backend polling`. A native file becoming a symlink fails explicitly. Snapshot enumeration reports inaccessible directories as sensor errors rather than deletions.

Debouncing uses observation times to suppress repeated modifications (including create-then-modify noise) for a path, so draining a callback backlog does not collapse writes that happened seconds apart. Deletes, renames, and recreation remain distinct events. Replacing or renaming the watched root is a fatal sensor error; re-register the watcher for its new location. A create/modify notification does not prove a checkpoint is complete; prefer a producer's completion event or atomic rename into a final filename before loading the artifact.

## Training watchdog

Observe an existing process and classify a run as a suspected stall when the metrics file has not changed for five minutes **and** GPU 0 has stayed below 10% for two minutes:

```powershell
python .\codex-monitor\scripts\watchdog_monitor.py `
  --watch-file .\runs\metrics.json `
  --stalled-for-ms 300000 `
  --gpu-util-below 10 --gpu-below-for-ms 120000 --gpu-id 0 `
  --gpu-recover-above 20 --warmup-ms 60000 --dead-if all `
  --watchdog-only --report-recovery --timeout-ms 86400000 `
  --pid 12345 --codex-thread $env:CODEX_THREAD_ID `
  --message-template "Training {event_type}: {event}. Inspect logs and checkpoint progress."
```

The watchdog does not own or kill the training process. `--dead-if any` alerts on either enabled heuristic; `all` requires all enabled heuristics. PID exit is a separate definitive event. An alert is edge-triggered, so continuous low utilization does not create a polling loop of Codex turns. `--report-recovery` requests a callback when the rule is re-armed.

Use a heartbeat or metrics file that truly represents progress. Low GPU utilization can be normal during validation, data loading, or checkpointing, so choose dwell times from the workload's real cadence. The default action is to notify Codex to investigate; automatic restart requires an explicit bounded recovery policy.

## Custom callbacks

Instead of the local queue/resume adapter, pass `--callback-command`. The command receives one JSON object on stdin:

```powershell
python .\codex-monitor\scripts\watchdog_monitor.py `
  --watch-file .\runs\metrics.json --stalled-for-ms 300000 --watchdog-only `
  --callback-command "python .\scripts\on_monitor_event.py" `
  --timeout-ms 86400000
```

The callback JSON includes `event_type`, `event`, `timestamp`, `source`, `event_index`, `pid`, `message`, and source-specific evidence such as `path`, `change`, `conditions`, `utilization`, or `returncode`. Event data is passed on stdin rather than interpolated into the callback shell command.

Callbacks are synchronous, with a timeout of 30 seconds or the remaining monitor lifetime, whichever is shorter. JSON arrives through a temporary file attached to stdin, avoiding blocking pipe writes on older Windows Python versions when a callback does not read its input. Output is continuously drained into a bounded 64 KiB tail rather than accumulated in memory or a growing log file. Owned commands and callbacks use a Windows Job Object or a POSIX process group; their remaining descendants are stopped when they finish or time out. Hand long-running recovery work to an external supervisor rather than launching it as an untracked callback child. These ownership rules never apply to a training process supplied with `--pid`.

The file/GPU/PID event queue holds at most 1,024 items. An overflow stops observation with `monitor_error` and a nonzero exit code rather than silently dropping events or allowing unbounded memory growth. Keep callback work short. Message templates accept plain `{field}` placeholders and escaped braces (`{{` / `}}`); malformed templates are rejected before observation starts.

## Test and validation

```powershell
python -m unittest discover -s tests -v
python .\tools\validate_skill.py .\codex-monitor
python .\codex-monitor\scripts\monitor_callback.py --help
python .\codex-monitor\scripts\watchdog_monitor.py --help
```

### Platform status

On a host with NVIDIA GPUs, also run the read-only hardware checks:

```bash
CODEX_MONITOR_TEST_GPU=1 .venv/bin/python -W error::ResourceWarning \
  -m unittest discover -s tests -p test_live_gpu.py -v
```

These query actual indices, UUIDs and PCI addresses, reject a partially missing GPU selection, exercise dry-run sampling, and deliver a real low-utilization event to a temporary local callback. The last check skips if every GPU remains at 100% throughout its observation window. They do not start GPU workloads or change driver settings.

| Platform | Status |
| --- | --- |
| Windows 11 Pro for Workstations 26H2 (build 26300) | **Retested after the Ubuntu changes.** Python 3.10.0, 3.12.0, and 3.14.8: 115 discovered, 97 passed, 18 expected skips. Minimal environments, optional dependencies on 3.14, and a Chinese/space-containing source path on 3.12 passed. Codex CLI 0.166.0. |
| Ubuntu 24.04.3 LTS, x86_64 | **Tested locally.** Python 3.10, 3.12, 3.13 and 3.14; native inotify, snapshot fallback, symlink paths, atomic file replacement, PID waiting and SIGTERM cleanup. See the validation report for exact runtimes and results. |
| Windows / Ubuntu / macOS CI | Nine jobs cover Python 3.10, 3.12, and 3.14 on all three platforms, with native file backends and PID waiting; two additional Ubuntu/Windows jobs omit optional dependencies. See [workflow results](https://github.com/EthenJ/codex-monitor/actions/workflows/test.yml) for each revision. |
| Live NVIDIA GPU | **Tested on Ubuntu with two GeForce RTX 4090 D cards.** Real selection, sampling, dry-run and low-utilization callback passed. Recovery, hysteresis, outages and multi-card dwell boundaries also have deterministic tests. |
| Live Codex wake-up | **Not verified end to end.** Tests validate callback payloads, CLI argv, and failure/warning handling; they do not prove that a real idle thread executes a follow-up turn. |

What the Windows run covered: native `ReadDirectoryChangesW` create/modify/rename/delete notifications, root replacement detection, single-file watching that did not exist at registration, file-stall and recovery transitions, atomic replacement re-arming, Chinese output and callback JSON, backlog-aware write debouncing that preserves deletion/recreation, `--dry-run` on an actual triggered event, simulated GPU health and sensor outages, PID exit, failed callbacks, unread callback input, warning diagnostics, bounded queues/messages, subscription timing, callback child cleanup, startup log failure cleanup, and the invariant that watchdog expiry, event limits, and cancellation leave the observed training PID running.

The [validation report](https://github.com/EthenJ/codex-monitor/blob/develop/docs/validation.md) records the audit findings, commands, platform boundaries, cancellation tests, and the distinction between callback transport tests and a live Codex turn.

The [Windows validation results and checklist (中文)](https://github.com/EthenJ/codex-monitor/blob/develop/docs/windows-validation.md) record the latest execution and repeatable commands. All four Windows-specific tests passed: pending-read handle cleanup, actual PID exit status, forced monitor termination with Job cleanup, and real console Ctrl+C for native/polling watchers and owned commands. Windows live GPU checks remain untested because this host has no `nvidia-smi`.

Before relying on a GPU rule, validate the workload's thresholds locally with `--dry-run`. Install the optional platform dependencies to use native Linux/macOS file events; the backend is reported in the JSONL log. POSIX `SIGTERM` and Ctrl+C clean up owned commands, callbacks and GPU queries while preserving an observed training PID.

## Limitations

- This is not a native Codex tool. It resumes a thread through `codex queue --resume`, so wake-up depends on a reachable local daemon/session. A queued-but-not-resumed message is reported as a callback failure, not as success.
- Delivery is best-effort with no durable outbox or end-to-end deduplication. A crash can lose an event; filesystem backends can coalesce or duplicate notifications. A failed/timed-out callback may already have submitted its message, so inspect the destination before manually retrying.
- Heuristics are evidence of a *suspected* stall. File inactivity can be legitimate I/O or validation; GPU samples can be masked by co-tenants on a shared card.
- Only NVIDIA GPUs are supported (`nvidia-smi`). Remote/cluster training needs the sidecar deployed on the training host.
- The watchdog observes; it never kills or restarts a run. Any restart policy must be explicit, bounded, and user-requested.

## Layout

```text
.codex-plugin/plugin.json
.agents/plugins/marketplace.json
.mcp.json
codex-monitor/
├── SKILL.md
├── agents/openai.yaml
├── references/
│   ├── session-callbacks.md
│   ├── plugin.md
│   └── watchdogs.md
└── scripts/
    ├── file_events.py
    ├── goal_bridge.py
    ├── monitor_callback.py
    ├── owned_process.py
    ├── plugin_runtime.py
    ├── plugin_server.py
    └── watchdog_monitor.py
tests/test_plugin.py
tests/test_plugin_mcp.py
tests/test_monitor.py
tests/test_regressions.py
tests/test_second_review.py
tests/test_release_review.py
tests/test_ubuntu_gpu.py
tests/test_live_gpu.py
tests/test_boundary_review.py
tests/test_windows.py
tools/validate_skill.py
tools/build_plugin.py
docs/validation.md
docs/windows-validation.md
docs/plugin-validation.md
```

The design notes in `references/` explain the Claude Code naming, Codex queue/resume behavior, Agents API continuation mapping, watchdog state machine, and platform dependencies.
