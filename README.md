# codex-monitor

A Node.js Codex plugin for workload events, native goal waiting and bounded session recovery. It watches commands, files, process exit, training inactivity and NVIDIA GPU utilization, then delivers native tool results to the same conversation. Routine progress stays local while the agent continues useful work.

Version **0.2.3** fixes callbacks that could bypass a manually paused goal, makes conditional pause/resume respect later user actions, and distinguishes a confirmed goal pause from notification-only waiting. Interactive installation, compact reports and configurable session recovery remain available.

Original goal inspection, editing, budgets and status remain in Codex. No Codex source build or model API key is required.

## Install

Requires Node.js 22.22+ (24 recommended), npm, Codex CLI 0.166.0+ and a compatible local Codex daemon. Validated with Codex 0.166.0.

From the complete repository or extracted release package, run in a normal terminal:

```text
node install.mjs
```

The wizard asks for the Codex configuration directory, client, compact/verbose output, automatic Stop/Interrupt reports and launcher startup. It shows the plan before installing. An existing installation requires an explicit replacement choice. Use `node install.mjs --dry-run` to preview, or [agent-assisted configuration](codex-monitor/references/installation.md#preview-or-install-from-an-agent-session) for a noninteractive shell.

Setup builds a source checkout when necessary, stages a complete deployment bundle, installs production dependencies, and executes an isolated MCP probe before registering the plugin. It preserves monitor state and unrelated Codex settings. It refuses to replace an installation with active monitors, waits, recovery or unresolved pending deliveries; reconcile those first. Avoid starting monitors during an upgrade. Recovery is not enabled by installation.

Finish installation, then fully reopen Codex to load all eleven tools. Check `/plugins` and `/mcp`, and ask Codex to actually call `monitor_display` in the resumed conversation. If reports were included, review this plugin's exact hooks in `/hooks`. Installing does not grant hook trust; changing the installed bundle after review invalidates its fingerprint. The launcher must be started again after login/reboot from an external terminal; no OS service is installed. Setup prints the exact command and activation checklist. See the [installation guide](codex-monitor/references/installation.md) for simulation and upgrade details.

For manual installation of a deployment package, run `npm ci --omit=dev`, `npm run bootstrap`, `codex plugin marketplace add .`, and `codex plugin add codex-monitor@codex-monitor`, then follow the same activation checklist. Build a source checkout with `npm ci` and `npm run build` first. When upgrading from v0.1, stop its standalone observers and disable/remove the old skill to avoid duplicate callbacks. The Node plugin has no Python runtime dependency; native bindings use Koffi's published prebuilt binaries where available.

## Typical request

> Monitor training progress and process exit. Alert if metrics stop changing and GPU utilization stays low. Prepare evaluation while training runs. When only training remains, pause the goal and resume it on completion or an alert. Retry transient conversation network failures with a finite budget, but never resume after I manually interrupt or pause.

## How it works

1. `monitor_start` registers an observer and confirms readiness.
2. A separate per-thread Node service watches the workload without calling the model for healthy progress.
3. Events are saved, filtered for duplicates/expiry and submitted through `turn/start.toolOutput` to the existing daemon.
4. Codex uses `monitor_event` to inspect the trigger and evidence, then supplies a resolution after handling. The same card acknowledges the events and reports current status. Pending results already handled independently are suppressed.
5. With authorization, the native goal pauses while waiting and resumes after event submission and state verification.

Manual goal pause holds ordinary callbacks locally until resume; event expiry still applies. Only selected events from an explicitly authorized goal wait may wake its paused goal. Pause does not interrupt an already-running turn or tool: the agent must finish its status report and yield. Later user edits and disconnects cancel conditional restoration and require reconciliation. See [goal waiting details](codex-monitor/references/plugin.md#native-goal-waiting).

Tools: `monitor_start`, `monitor_event`, `monitor_display`, `monitor_validate`, `monitor_report`, `monitor_status`, `monitor_stop`, `monitor_wait`, `monitor_cancel_wait`, `monitor_ack`, `monitor_recovery`.

MCP clients discover parameter types, ranges and enums through `tools/list`. `monitor_start` infers command/watchdog mode and applies finite defaults. Commands without `match` report exit only. Start automatically checks configuration and local prerequisites. Use `monitor_validate` to preview normalized settings and verify the exact loaded host thread without starting a workload or recovery. See [minimal examples and validation](codex-monitor/references/plugin.md#typed-configuration-and-preflight).

`monitor_report` displays one human-readable line, such as `Monitor · 2 running` or `Monitor · none running`. Bundled `Stop` and `Interrupt` hooks emit the same concise summary without waking the model. Cancelled/stopped monitors and lifecycle history are omitted from routine text; details remain in structured tool data and `monitor_status`. Unverified saved state is reported as unavailable, never as currently running. The skill guides agents to stop obsolete observers and acknowledge handled events while preserving monitoring for pending work. Review and trust the installed hooks in `/hooks`; installation alone does not trust hooks. Client rendering varies, and `codex exec --json` may omit hook messages. No new turn is submitted merely to show status.

Complete every build, dependency installation and file copy before reviewing hooks. Codex fingerprints the entire installed plugin bundle; modifying it afterward can cause `plugin contents changed; hook approval required`. Review the updated hooks again, then verify a fresh scan and execution. Cached trust metadata in an already-loaded thread is insufficient; see the [installation reference](codex-monitor/references/plugin.md).

All eleven tools include readable summaries and an MCP Apps view. On compatible hosts, `monitor_report` opens a live panel with workload counts, recovery state and bounded lifecycle transitions; other operation cards offer live updates on demand. `monitor_event` highlights the selected triggers, including exit status and whether action is still needed. Compact mode omits inactive monitors and shows the latest eight relevant transitions; verbose displays the full bounded history. The panel waits for changes through bounded MCP calls without involving the agent. Hidden views stop re-arming, and disconnected views require explicit reconnection. Background transitions update the timeline; independent native chat cards still require a real tool call. Hosts without MCP Apps retain text and structured results. Codex 0.166.0 exposes MCP Apps behind the experimental `enable_mcp_apps` feature.

Codex CLI 0.166.0 displays text tool results, not the HTML panel. All tools therefore use plain-text cards without Markdown tables or duplicate JSON. `monitor_display(thread_id, mode: "compact" | "verbose")` selects the workflow per thread without restarting. Compact is the default: start/stop and event cards carry fresh status, so the agent can omit redundant diagnostic and final-report calls. The previous four-call callback sequence becomes an event inspection followed by one combined acknowledgement/status card; already-inspected events can use the combined call alone. Verbose retains separate status/ack/report calls and adds diagnostic details. Errors remain visible in either mode. Every actual call still has the CLI's host-owned `Called` header; the plugin cannot hide or merge those headers. Enabling the engine's MCP Apps flag does not add an HTML renderer to the terminal. The optional desktop panel remains separately unverified. See the [validation evidence](https://github.com/EthenJ/codex-monitor/blob/develop/docs/releases/v0.2.2.md#validation).

Native event callbacks also use readable text with exact monitor/event references. Raw workload evidence and registered actions are retrieved through `monitor_status`, rather than printed in the notification. Recovery notifications identify the retry attempt and failed turn. Event delivery still uses the native tool-output channel.

Commands are owned and cleaned up on cancellation. Watchdogs never terminate existing training PIDs. File/GPU rules support startup grace, dwell times, aggregation and recovery hysteresis. Native file notifications and local GPU/PID sampling do not wake the model. Read [usage and lifecycle contracts](codex-monitor/references/plugin.md).

## Recovery

Recovery is opt-in. Each eligible failure waits a **fixed 300 seconds** before the next attempt, with a **three-hour limit per incident**. Configure `retry_interval_ms` and `max_elapsed_ms` to change these defaults. The optional `max_attempts` cap defaults to the elapsed limit divided by the interval, rounded up (36); it no longer stops after five attempts. The separate supervisor lifetime defaults to 24 hours. Disable with `monitor_recovery(enabled: false)`.

Codex's built-in retries finish first. The default `retry_mode: "transient"` accepts recognized connection, stream and server failures. When the user requests retries for any failed turn, choose `retry_mode: "all_failed"`: unknown, missing, authentication and rate-limit errors also qualify. Both modes require a verified terminal `failed` status. Manual interruption disables recovery. Paused/ended goals, explicit host budget/usage/policy stops, active user work and ambiguous submissions remain protected. Silence alone is not failure. Recovery reconciles completed effects before continuing; it does not automatically replay commands or restart training. See [configuration and timing details](codex-monitor/references/plugin.md#session-recovery).

## Development and validation

Source, tests and build tooling live on the `develop` branch. Run these commands there:

```text
npm test
npm run package -- dist/codex-monitor-v0.2.3
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
