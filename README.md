# codex-monitor

A Node.js Codex plugin for workload events, native goal waiting and bounded session recovery. It watches commands, files, process exit, training inactivity and NVIDIA GPU utilization, then delivers native tool results to the same conversation. Routine progress stays local while the agent continues useful work.

Original goal inspection, editing, budgets and status remain in Codex. No Codex source build or model API key is required.

## Install

Requires Node.js 22.22+ (24 recommended) and a compatible local Codex daemon. Validated with Codex 0.166.0.

```text
npm ci
npm run build
npm run bootstrap
codex plugin marketplace add .
codex plugin add codex-monitor@codex-monitor
```

Restart Codex to load the seven tools. Disable older standalone copies of the skill to avoid duplicate guidance. Bootstrap starts a hidden launcher outside the MCP client's process job; run it once per login/reboot from an external terminal. It installs no OS service or scheduled task.

For a prebuilt deployment package replace the first two commands with `npm ci --omit=dev`. The Node plugin has no Python runtime dependency. Native bindings use Koffi's published prebuilt binaries where available.

## Typical request

> Monitor training progress and process exit. Alert if metrics stop changing and GPU utilization stays low. Prepare evaluation while training runs. When only training remains, pause the goal and resume it on completion or an alert. Retry transient conversation network failures with a finite budget, but never resume after I manually interrupt or pause.

## How it works

1. `monitor_start` registers an observer and confirms readiness.
2. A separate per-thread Node service watches the workload without calling the model for healthy progress.
3. Events are saved, filtered for duplicates/expiry and submitted through `turn/start.toolOutput` to the existing daemon.
4. Codex reads evidence and uses `monitor_ack` to acknowledge handled event IDs. Pending results already handled independently are suppressed.
5. With authorization, the native goal pauses while waiting and resumes after event submission and state verification.

Tools: `monitor_start`, `monitor_status`, `monitor_stop`, `monitor_wait`, `monitor_cancel_wait`, `monitor_ack`, `monitor_recovery`.

Commands are owned and cleaned up on cancellation. Watchdogs never terminate existing training PIDs. File/GPU rules support startup grace, dwell times, aggregation and recovery hysteresis. Native file notifications and local GPU/PID sampling do not wake the model. Read [usage and lifecycle contracts](codex-monitor/references/plugin.md).

## Recovery

Recovery is opt-in. Defaults: five attempts, exponential delay from 15 seconds, five-minute delay cap, 30-minute incident limit and 24-hour supervisor lifetime. Disable with `monitor_recovery(enabled: false)`.

Codex's built-in retries finish first. Verified transient connection, stream and server failures qualify. Manual interruption disables recovery. Paused/ended goals, exhausted budgets, authentication/policy errors, active user work and ambiguous submission are never overridden. Silence alone is not failure. Recovery reconciles completed effects before continuing; it does not automatically replay commands or restart training.

## Build and test

```text
npm test
npm run package -- dist/codex-monitor-v0.3.0
```

Deployment packages include compiled JavaScript, dependency manifests, plugin metadata and skill instructions. Tests, workflows, TypeScript source, reports, caches and local state are excluded. Development stays on `develop`; this preview does not update deployment `main` or v0.1.

Enable isolated native App Server tests with `CODEX_MONITOR_TEST_NATIVE=1`. They use temporary Codex homes and a local synthetic model endpoint, never user credentials or paid models. Network fixtures inject HTTP failures, broken streams and manual interruption.

```text
docker build -f tests/container/Dockerfile -t codex-monitor-network-test .
docker run --rm --network none codex-monitor-network-test
```

Image building downloads dependencies; test execution uses only container loopback. Exact coverage is recorded in [Node validation](https://github.com/EthenJ/codex-monitor/blob/develop/docs/node-validation.md). Prior Python platform/GPU results do not establish Node platform coverage.

For Ubuntu installation, full container checks and manual workload/goal/GPU cases, follow the [Ubuntu validation guide](https://github.com/EthenJ/codex-monitor/blob/develop/docs/ubuntu-validation.md).

## Boundaries

- Native events remain tool outputs; presentation and scheduling are controlled by Codex. Immediate tool preemption is not promised.
- Submission, turn completion and acknowledgement are separate states. Queued events cannot be recalled. Uncertain submissions are not blindly retried; exactly-once execution is not guaranteed.
- Goal waiting/recovery require the same loaded local daemon. There is no atomic compare-and-set/start; concurrent user actions between verification and a write remain a race boundary.
- Restart marks observations unknown, waits interrupted and recovery disabled. It does not recreate workloads.
- Windows Job Objects protect owned descendants. POSIX graceful shutdown cleans groups; SIGKILL cannot execute userspace cleanup. Observed PIDs are never owned.
- GPU rules require local `nvidia-smi`; co-tenants and legitimate training pauses can resemble stalls.

State lives under `~/.codex/monitor-node` or `CODEX_MONITOR_HOME`, outside watched trees. Stop observations with the MCP tools. `node codex-monitor/runtime/cli.js stop-broker` stops only the launcher.

## Legacy helpers

Original Python helpers and regression tests remain on `develop` for compatibility. They are not used or shipped by the Node plugin. See [v0.1 standalone documentation](https://github.com/EthenJ/codex-monitor/blob/main/README.md).
