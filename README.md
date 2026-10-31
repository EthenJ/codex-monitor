# codex-monitor

Event callbacks and training watchdogs for Codex. Observe command output, file changes, inactivity, NVIDIA GPU utilization or an existing PID, then queue a follow-up to the same Codex thread. A local sidecar waits for the condition; Codex runs only when a callback is submitted.

## Requirements

- Python 3.10 or newer.
- Codex CLI with `codex queue --thread ... --message ... --resume` (validated with 0.166.0), or your own `--callback-command` transport.
- GPU monitoring requires the NVIDIA driver's `nvidia-smi`.

Windows uses native APIs for file and PID monitoring. Linux/macOS can install the optional dependencies from this checkout:

```sh
python -m pip install ".[platform]"
```

This installs `watchdog` and `psutil`; it does not install the skill into Codex. Without `watchdog`, auto mode reports snapshot fallback. `--file-backend native` requires a native event backend.

## Install

Copy the included `codex-monitor` folder into your Codex skills directory.

PowerShell, from the repository root:

```powershell
$skillRoot = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $HOME '.codex/skills' }
$skillTarget = Join-Path $skillRoot 'codex-monitor'
New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
Copy-Item -Path .\codex-monitor\* -Destination $skillTarget -Recurse -Force
```

Linux/macOS:

```sh
skill_target="${CODEX_HOME:-$HOME/.codex}/skills/codex-monitor"
mkdir -p "$skill_target"
cp -R ./codex-monitor/. "$skill_target/"
```

Invoke `$codex-monitor` in Codex with the event, callback instructions and lifetime. For example: “Watch `runs/metrics.json`; if it stops changing for five minutes, wake this session to investigate. Stop monitoring after 24 hours.”

## Direct usage

Command output, PowerShell:

```powershell
python .\codex-monitor\scripts\monitor_callback.py `
  --command "python -u observe_events.py" --match "BUILD (PASSED|FAILED)" `
  --codex-thread $env:CODEX_THREAD_ID --max-events 1 `
  --message-template "Build event: {event}. Inspect the result and continue."
```

Training inactivity, PowerShell:

```powershell
python .\codex-monitor\scripts\watchdog_monitor.py `
  --watch-file .\runs\metrics.json --stalled-for-ms 300000 --watchdog-only `
  --codex-thread $env:CODEX_THREAD_ID --timeout-ms 86400000 `
  --message-template "Training {event_type}: {event}. Inspect recent progress."
```

The watched file's parent must exist. Pass an explicit thread UUID/name if `CODEX_THREAD_ID` is absent. Add `--dry-run` to observe and print callbacks without submitting them. Both helpers expose `--help`. Command sources use `cmd.exe` on Windows and `/bin/sh` on POSIX; invoke PowerShell explicitly when needed.

For background operation, use your host's persistent background-process facility and retain logs outside the watched directory. Record the sidecar PID and deadline so it can be stopped.

See [skill instructions](codex-monitor/SKILL.md), [watchdog configuration](codex-monitor/references/watchdogs.md), and [callback transport](codex-monitor/references/session-callbacks.md) for file filters, GPU thresholds, recovery, process ownership and custom callbacks.

## Validation and limits

The runtime has been tested on Windows 11 and Ubuntu; Windows validation covered Python 3.10, 3.12 and 3.14, native file events, PID observation, Job cleanup and real console cancellation. Live NVIDIA sampling and callbacks were tested on Ubuntu with two RTX 4090 D GPUs. The [development branch](https://github.com/EthenJ/codex-monitor/tree/develop) retains tests and detailed validation records.

- A real idle Codex session executing a callback turn has not been verified end to end. Wake-up requires a reachable Codex daemon/session; queue acceptance alone does not prove execution.
- File inactivity and low GPU utilization indicate a suspected stall. The watchdog never kills or restarts an observed PID. The command helper and callbacks own and clean up their child processes.
- Delivery is best-effort, without a durable outbox or exactly-once guarantee. Native file events may be coalesced or lost; file changes do not prove a checkpoint is complete.

MIT licensed; see [LICENSE](LICENSE).
