# codex-monitor

A Node.js Codex plugin for workload events, native goal waiting and bounded session recovery. It watches commands, files, process exit, training inactivity and NVIDIA GPU utilization, then delivers native tool results to the same conversation. Routine progress stays local while the agent continues useful work.

Version **0.2.2** adds typed MCP configuration, preflight validation and structured status reports at turn end. Fixed-interval recovery and optional coverage of unlisted failures from 0.2.1 are preserved.

Original goal inspection, editing, budgets and status remain in Codex. No Codex source build or model API key is required.

## Install

Requires Node.js 22.22+ (24 recommended) and a compatible local Codex daemon. Validated with Codex 0.166.0.

From the deployment checkout or extracted release package:

```text
npm ci --omit=dev
npm run bootstrap
codex plugin marketplace add .
codex plugin add codex-monitor@codex-monitor
```

Restart Codex to load the nine tools. Disable older standalone copies of the skill to avoid duplicate guidance. Review the status-report hooks in `/hooks` to enable automatic stop/interrupt reports. Bootstrap starts a hidden launcher outside the MCP client's process job; run it once per login/reboot from an external terminal. It installs no OS service or scheduled task.

When using the source checkout on `develop`, run `npm ci` and `npm run build` before bootstrap and installation instead. The Node plugin has no Python runtime dependency. Native bindings use Koffi's published prebuilt binaries where available.

When upgrading from v0.1, stop its old observers and disable/remove the standalone skill before enabling the plugin, so both versions do not send callbacks. Install the complete package, not just its inner skill directory. For an installed preview, stop its monitors/waits/recovery and broker, remove the old plugin with `codex plugin remove codex-monitor@codex-monitor`, then install this version and restart Codex. Old monitor state is not automatically migrated or rearmed; register the required observers again. Existing training processes observed by watchdogs remain independent.

## Typical request

> Monitor training progress and process exit. Alert if metrics stop changing and GPU utilization stays low. Prepare evaluation while training runs. When only training remains, pause the goal and resume it on completion or an alert. Retry transient conversation network failures with a finite budget, but never resume after I manually interrupt or pause.

## How it works

1. `monitor_start` registers an observer and confirms readiness.
2. A separate per-thread Node service watches the workload without calling the model for healthy progress.
3. Events are saved, filtered for duplicates/expiry and submitted through `turn/start.toolOutput` to the existing daemon.
4. Codex reads evidence and uses `monitor_ack` to acknowledge handled event IDs. Pending results already handled independently are suppressed.
5. With authorization, the native goal pauses while waiting and resumes after event submission and state verification.

Tools: `monitor_start`, `monitor_validate`, `monitor_report`, `monitor_status`, `monitor_stop`, `monitor_wait`, `monitor_cancel_wait`, `monitor_ack`, `monitor_recovery`.

MCP clients discover parameter types, ranges and enums through `tools/list`. `monitor_start` infers command/watchdog mode and applies finite defaults. Commands without `match` report exit only. Start automatically checks configuration and local prerequisites. Use `monitor_validate` to preview normalized settings and verify the exact loaded host thread without starting a workload or recovery. See [minimal examples and validation](codex-monitor/references/plugin.md#typed-configuration-and-preflight).

`monitor_report` returns a compact structured tool result. Bundled `Stop` and `Interrupt` hooks automatically emit the same report through the host's hook status message, without waking the model. Review and trust the installed hooks in `/hooks`; installation alone does not trust hooks. Client rendering varies, and `codex exec --json` may omit hook messages. No new turn is submitted merely to show status.

Commands are owned and cleaned up on cancellation. Watchdogs never terminate existing training PIDs. File/GPU rules support startup grace, dwell times, aggregation and recovery hysteresis. Native file notifications and local GPU/PID sampling do not wake the model. Read [usage and lifecycle contracts](codex-monitor/references/plugin.md).

## Recovery

Recovery is opt-in. Each eligible failure waits a **fixed 300 seconds** before the next attempt, with a **three-hour limit per incident**. Configure `retry_interval_ms` and `max_elapsed_ms` to change these defaults. The optional `max_attempts` cap defaults to the elapsed limit divided by the interval, rounded up (36); it no longer stops after five attempts. The separate supervisor lifetime defaults to 24 hours. Disable with `monitor_recovery(enabled: false)`.

Codex's built-in retries finish first. The default `retry_mode: "transient"` accepts recognized connection, stream and server failures. When the user requests retries for any failed turn, choose `retry_mode: "all_failed"`: unknown, missing, authentication and rate-limit errors also qualify. Both modes require a verified terminal `failed` status. Manual interruption disables recovery. Paused/ended goals, explicit host budget/usage/policy stops, active user work and ambiguous submissions remain protected. Silence alone is not failure. Recovery reconciles completed effects before continuing; it does not automatically replay commands or restart training. See [configuration and timing details](codex-monitor/references/plugin.md#session-recovery).

## Development and validation

Source, tests and build tooling live on the `develop` branch. Run these commands there:

```text
npm test
npm run package -- dist/codex-monitor-v0.2.2
```

Deployment packages include compiled JavaScript, production dependency manifests, plugin metadata and skill instructions. Tests, workflows, TypeScript source, development dependencies, reports, caches and local state are excluded. Deployment pull requests target `main`; development stays on `develop`. The v0.1 tag remains available for the standalone release.

Enable isolated native App Server tests with `CODEX_MONITOR_TEST_NATIVE=1`. They use temporary Codex homes and a local synthetic model endpoint, never user credentials or paid models. Network fixtures inject HTTP failures, broken streams and manual interruption.

Enable read-only NVIDIA hardware tests with `CODEX_MONITOR_TEST_GPU=1` on a host with working `nvidia-smi`. These check GPU selectors and finite quiet monitoring without changing workloads; deterministic tests cover threshold and recovery transitions.

For a real read-only transition probe and repeatable GPU-provider fault tests, see [GPU validation](https://github.com/EthenJ/codex-monitor/blob/develop/docs/gpu-validation.md). Run `bash tools/validate-docker.sh` to build both container fixtures and save their test logs.

```text
docker build -f tests/container/Dockerfile -t codex-monitor-network-test .
docker run --rm --network none codex-monitor-network-test
```

Image building downloads dependencies; test execution uses only container loopback. Exact coverage is recorded in [Node validation](https://github.com/EthenJ/codex-monitor/blob/develop/docs/node-validation.md). Prior Python platform/GPU results do not establish Node platform coverage.

For Ubuntu installation, full container checks and manual workload/goal/GPU cases, follow the [Ubuntu validation guide](https://github.com/EthenJ/codex-monitor/blob/develop/docs/ubuntu-validation.md).

For native Windows regression commands and the pending platform/GPU checks, use the [Node Windows checklist](https://github.com/EthenJ/codex-monitor/blob/develop/docs/node-windows-validation.md).

## Boundaries

- Native events remain tool outputs; presentation and scheduling are controlled by Codex. Immediate tool preemption is not promised.
- Submission, turn completion and acknowledgement are separate states. Queued events cannot be recalled. Uncertain submissions are not blindly retried; exactly-once execution is not guaranteed.
- Goal waiting/recovery require the same loaded local daemon. There is no atomic compare-and-set/start; concurrent user actions between verification and a write remain a race boundary.
- Restart marks observations unknown, waits interrupted and recovery disabled. It does not recreate workloads.
- Windows Job Objects protect owned descendants. POSIX graceful shutdown cleans groups; SIGKILL cannot execute userspace cleanup. Observed PIDs are never owned.
- GPU rules require local `nvidia-smi`; co-tenants and legitimate training pauses can resemble stalls.

State lives under `~/.codex/monitor-node` or `CODEX_MONITOR_HOME`, outside watched trees. Stop observations with the MCP tools. `node codex-monitor/runtime/cli.js stop-broker` stops only the launcher.

## Legacy helpers

Original Python helpers and regression tests remain on `develop` for compatibility. They are not used or shipped by the Node plugin. See [v0.1 standalone documentation](https://github.com/EthenJ/codex-monitor/blob/v0.1/README.md).
