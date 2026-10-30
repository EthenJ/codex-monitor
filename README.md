# codex-monitor

Event-driven sidecars for Codex sessions: observe command output, file and directory changes, training progress, GPU utilization, and process exit, then queue a follow-up message to the same Codex thread. The monitor process does the waiting; Codex is called only when a meaningful event or health transition occurs.

This is the local CLI implementation of the behavior Claude Code ships as its **Monitor tool**. A monitor starts before the workload, receives events from the workload or OS, and calls:

```text
codex queue --thread <thread-id> --message <event-prompt> --resume
```

The repository is the Codex counterpart of Claude Code's **Monitor tool**, and is named the same way: host prefix plus the tool name. It exposes a generic `--callback-command` seam for a host application or an OpenAI Agents API adapter.

Naming note: this tool monitors **your workload** - command output, files, training health, GPU, a PID - and wakes Codex when something happens. It does not inspect or supervise the Codex session itself; the session is the *destination* of the callback, not the thing being observed.

**Current status: tested on Windows.** See [Platform status](#platform-status); Linux/macOS and live-GPU paths are implemented but not validated on real hardware here.

## Features

- Streaming command-output events with regex matching, debouncing, deadlines, and one-shot limits.
- Native Windows directory events through overlapped `ReadDirectoryChangesW`.
- Cross-platform directory events through the optional `watchdog` package, with an explicit snapshot fallback.
- File or directory inactivity watchdogs with startup grace periods.
- NVIDIA GPU low-utilization watchdogs using `nvidia-smi`, dwell time, recovery hysteresis, and `all`/`any` aggregation.
- Existing PID observation without killing or restarting the observed process.
- Edge-triggered `watchdog_stalled` and `watchdog_recovered` events.
- JSONL lifecycle and callback logs; callback payloads arrive on stdin for custom callbacks.
- `--dry-run`, callback timeouts, bounded retries (none by default), and safe process/session diagnostics.

## Requirements

- Python 3.10 or newer.
- Codex CLI 0.166.0 or a compatible version that supports `codex queue --thread ... --resume`.
- A `CODEX_THREAD_ID` environment variable in the registering Codex process, or an explicit `--codex-thread` UUID/name.
- NVIDIA GPU alerts require `nvidia-smi`. GPU provider failure is reported as unknown; it is never treated as 0% utilization.

Optional dependencies:

```powershell
python -m pip install -e ".[platform]"
```

`watchdog` enables native file events on Linux/macOS. `psutil` is used as the PID-wait fallback on platforms without `pidfd_open`. Windows uses native APIs and does not need either package for the default path. The editable install ships no importable package (`packages = []`); it exists to resolve the optional dependencies for the scripts in `codex-monitor/scripts`.

## Install the skill

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

## Test and validation

```powershell
python -m unittest discover -s tests -v
python .\tools\validate_skill.py .\codex-monitor
python .\codex-monitor\scripts\monitor_callback.py --help
python .\codex-monitor\scripts\watchdog_monitor.py --help
```

### Platform status

| Platform | Status |
| --- | --- |
| Windows 11 Pro for Workstations 26H2 (build 26300) | **Tested.** Python 3.14.8, Codex CLI 0.166.0. All 24 tests pass. |
| Linux / macOS | **Not tested locally.** CI job configured; `watchdog` backend and `pidfd_open`/`psutil` paths are unverified on real hosts. |
| Live NVIDIA GPU | **Not tested.** This machine has no GPU and no `nvidia-smi`; GPU alert, recovery, hysteresis, and `all`/`any` behavior were exercised with deterministic mocks. |

What the Windows run covered: native `ReadDirectoryChangesW` create/modify/rename/delete notifications, single-file watching that did not exist at registration, file-stall and recovery transitions, atomic replacement re-arming, callback JSON containing Chinese text, coalescing one save's create+modify into a single callback, `--dry-run` never invoking Codex, simulated low-GPU alerts and recovery edges, PID exit handling, callback failure/`queue --resume` warning handling, the check that event text stays argv data on the `codex queue` path, and the invariant that watchdog expiry, event limits, and cancellation never kill the observed training PID.

Before relying on a live GPU rule, validate it locally with `--dry-run` on the target machine. Before relying on Linux/macOS native file events, let the CI matrix (or a local run with `pip install -e ".[platform]"`) exercise that backend.

## Limitations

- This is not a native Codex tool. It resumes a thread through `codex queue --resume`, so wake-up depends on a reachable local daemon/session. A queued-but-not-resumed message is reported as a callback failure, not as success.
- Delivery is at-most-once with no durable queue. A crash between the event and the callback can drop that event; use a heartbeat file plus the watchdog rather than assuming exactly-once.
- Heuristics are evidence of a *suspected* stall. File inactivity can be legitimate I/O or validation; GPU samples can be masked by co-tenants on a shared card.
- Only NVIDIA GPUs are supported (`nvidia-smi`). Remote/cluster training needs the sidecar deployed on the training host.
- The watchdog observes; it never kills or restarts a run. Any restart policy must be explicit, bounded, and user-requested.

## Layout

```text
codex-monitor/
├── SKILL.md
├── agents/openai.yaml
├── references/
│   ├── session-callbacks.md
│   └── watchdogs.md
└── scripts/
    ├── file_events.py
    ├── monitor_callback.py
    └── watchdog_monitor.py
tests/test_monitor.py
tools/validate_skill.py
```

The design notes in `references/` explain the Claude Code naming, Codex queue/resume behavior, Agents API continuation mapping, watchdog state machine, and platform dependencies.
