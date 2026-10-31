# Node v0.3 preview validation

Validation date: 2026-11-01. This preview is developed on `develop`. Deployment `main` and the published v0.1 release are unchanged. The [Python v0.2 report](plugin-validation.md) is historical and does not establish Node compatibility.

## Local Windows results

Environment: Windows build 26300, Node.js 24.22.0, npm 11.19.1, Codex CLI/daemon 0.166.0. No Codex source build or user model credentials were used in isolated tests.

- TypeScript strict compilation passed.
- **40 Node tests passed, zero skipped** with `CODEX_MONITOR_TEST_NATIVE=1`.
- Legacy Python compatibility suite: **115 tests, 97 passed and 18 platform/hardware skips**. Python is not a dependency of the Node plugin.
- Both skill validators passed. Production dependency audit reported zero known vulnerabilities after updating Zod to 4.6.7.
- Built a deployment package, installed production dependencies from its lock file, and installed it with the real `codex plugin marketplace add` / `codex plugin add` commands in an isolated Codex home. Codex reported version 0.3.0 and discovered the enabled `codex-monitor:codex-monitor` skill. The installed server exposed all seven tools and successfully armed/stopped an observer.
- Deployment packaging excludes tests, workflows, TypeScript sources, Python helpers, validation reports, local state and caches. Compiled runtime, dependency manifests and required plugin/skill metadata are included.

## Behavior covered

- Native file readiness, initially absent progress files, root replacement, state-path aliases, quiet training inactivity, cancellation without terminating an observed PID, and owned command exit without matching output.
- Native `turn/start.toolOutput`, event IDs, acknowledgement, pending suppression, deduplication, supersession, TTL expiration and no automatic replay after ambiguous submission.
- Original goal budget/usage preservation, authorized pause/resume, later objective/budget changes, cancellation while preparing/submitting, manual interruption, and failed delivery settling the dependent wait.
- Recovery allowlist, finite backoff/attempts, newer user work, manual pause/interruption, budget exhaustion, goal edits/clear, concurrent disabling, uncertain submission and conservative restart behavior.
- GPU dwell continuity on the same card, aggregation, hysteresis and unknown/missing sensor results using deterministic fixtures.
- Official MCP SDK disconnect/reconnect, hidden launcher reuse, forced owned-descendant cleanup and survival across a strict Windows kill-on-close MCP host job.
- Unicode output, including multibyte characters split across pipe chunks.

Actual callbacks from the legacy regression and Docker/WSL installation attempts also arrived in the current Codex conversation as `codex_monitor.monitor_event` tool outputs. Their evidence was inspected and their IDs acknowledged. They were not injected as user chat messages.

## Real native network faults

`tests/node/network.test.mjs` starts a real, isolated Codex App Server against a local synthetic Responses endpoint. Provider retries are disabled in the fixture to expose terminal failures. The production supervisor still waits for Codex's own retries to finish.

All three cases passed on Windows:

1. HTTP 503, verified failed turn, bounded recovery through native tool output, then successful completion.
2. Abrupt HTTP response-stream disconnection, terminal failure, then successful recovery.
3. User interruption of a hanging response stream, followed by zero recovery attempts and a disabled supervisor.

Codex 0.166.0 labels a truncated response body as `other`; recovery accepts only the observed, narrowly anchored transport-error signature. Unrecognized `other` failures remain ineligible.

## Container and additional platform coverage

The container fixture installs Node dependencies and Codex 0.166.0 during image build. Execution uses `docker run --rm --network none`, so only loopback networking is available to the synthetic provider. A dedicated development CI job runs this fixture; the Node matrix also covers Windows, Ubuntu and macOS on Node 22 and 24. Configuration alone is not a passing result.

Local Docker Desktop 4.97.0 was downloaded from Docker's official distribution and its SHA-256 verified. Installation was blocked because Windows `VirtualMachinePlatform` is disabled; the attempted WSL administrator launch returned “The operation was canceled by the user.” The user reported that no confirmation window appeared and will handle installation manually. Automated elevation did not complete, no reboot was performed, and no local container result is claimed.

The first [development CI run](https://github.com/EthenJ/codex-monitor/actions/runs/41225194674) passed all three native network cases in the container with external networking disabled. Node 22/24 checks passed on Ubuntu and macOS. Its two Windows Node jobs exposed an MCP registration failure that was not reproduced by the local Windows suite; follow-up diagnosis is tracked separately before declaring the matrix clean.

The Windows launcher now avoids requesting a second job breakaway when an external broker starts an observer. A new Windows test reproduces an enclosing job that denies breakaway; observer startup succeeds through the broker. Direct MCP startup still requires breakaway or an external bootstrap. See Microsoft's [nested job rules](https://learn.microsoft.com/windows/win32/procthread/nested-jobs). A flaky legacy polling test was also changed to synchronize replacement/deletion with watcher readiness and observed progress instead of racing a short inactivity deadline. Local checks pass; hosted rerun is required to confirm the CI failure is resolved.

Live NVIDIA hardware, real distributed training, production provider outages and other Codex versions have not been validated for this Node implementation. Standard Node matrix jobs skip native Codex tests when the CLI is unavailable; the dedicated container supplies the pinned CLI for real network fault coverage.

## Limits

Native API acceptance is separate from eventual agent processing and explicit acknowledgement. There is no exactly-once guarantee, queued-result recall, atomic compare-and-start, or guaranteed immediate interruption of a running tool. POSIX SIGKILL cannot run userspace descendant cleanup. Recovery never infers failure from silence, resets a goal budget, or restarts training automatically.

Reproduce locally:

```powershell
npm ci
npm run build
$env:CODEX_MONITOR_TEST_NATIVE = '1'
node --test --test-timeout=25000 tests/node/*.test.mjs
```

```text
docker build -f tests/container/Dockerfile -t codex-monitor-network-test .
docker run --rm --network none codex-monitor-network-test
```
