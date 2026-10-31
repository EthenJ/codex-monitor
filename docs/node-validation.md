# Node v0.3 preview validation

Validation date: 2026-11-01. This preview is developed on `develop`. Deployment `main` and the published v0.1 release are unchanged. The [Python v0.2 report](plugin-validation.md) is historical and does not establish Node compatibility.

## Local Windows results

Environment: Windows build 26300, Node.js 24.22.0, npm 11.19.1, Codex CLI/daemon 0.166.0. No Codex source build or user model credentials were used in isolated tests.

- TypeScript strict compilation passed.
- **50 Node tests passed, zero skipped** with `CODEX_MONITOR_TEST_NATIVE=1` after the follow-up review.
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

Local Windows Docker validation also passed after the user completed installation. The verified environment was Docker Desktop 4.97.0 (244584), Docker client/engine 29.9.2, context `desktop-linux`, Linux/amd64, and WSL kernel `6.18.54.1-microsoft-standard-WSL2`.

The repository Dockerfile built successfully from commit `91c5b7f`, using `node:24-bookworm-slim` and Codex 0.166.0. Build time was approximately 93 seconds including downloads. The resulting image was `codex-monitor-network-test:local-v03`, ID `sha256:bebbfb7c42b24768f3f4f621e834d14ae251ad54e053f540ad4d2d9ff0e9d9a7`.

Running that image with `--rm --init --network none` passed **all three native network tests, zero failures and zero skips**, in approximately four seconds: HTTP 503 recovery, interrupted response-stream recovery, and no recovery after a manual turn interruption. The container used only loopback for its synthetic model endpoint. The test container was removed after completion; the image remains available for reuse. Completion reached the current Codex conversation through a native monitor tool result and was explicitly acknowledged.

The final [development CI run for 1318741](https://github.com/EthenJ/codex-monitor/actions/runs/41226278410) completed with **all 18 jobs passing**:

| Coverage | Result |
| --- | --- |
| Node 22 and 24 on Windows, Ubuntu and macOS; compilation, regression and deployment packaging | All six jobs passed |
| Native HTTP 503, broken stream and manual interruption inside Docker with `--network none` | All three cases passed |
| Legacy Python 3.10, 3.12 and 3.14 on all three platforms | All nine jobs passed |
| Legacy tests without optional platform dependencies on Windows and Ubuntu | Both jobs passed |

The legacy replacement/deletion fixture accepts equal timestamps within older Windows monotonic-clock ticks while retaining progress-count and stall-duration assertions. No production behavior was weakened to accommodate the test.

The Windows launcher now avoids requesting a second job breakaway when an external broker starts an observer. A new Windows test reproduces an enclosing job that denies breakaway; observer startup succeeds through the broker locally and in hosted Windows CI. Direct MCP startup still requires breakaway or an external bootstrap. See Microsoft's [nested job rules](https://learn.microsoft.com/windows/win32/procthread/nested-jobs). A flaky legacy polling test was also changed to synchronize replacement/deletion with watcher readiness and observed progress instead of racing a short inactivity deadline.

Live NVIDIA hardware, real distributed training, production provider outages and other Codex versions have not been validated for this Node implementation. Standard Node matrix jobs skip native Codex tests when the CLI is unavailable; the dedicated container supplies the pinned CLI for real network fault coverage.

## Limits

The follow-up review corrected deletion being counted as training progress, repeat recovery submissions while the host snapshot lags, unresolved waits after acknowledgement/expiry, history cleanup losing event instructions, invalid option/ID handling, and abandoned proxy/watcher cleanup. Each behavior has regression coverage. Final full Ubuntu 24.04 container validation passed **48 tests with two Windows-only skips and zero failures**, using UID 1000 and `--init --network none`. Windows passed all 50 tests. The rebuilt deployment package again installed successfully and exposed all seven tools plus the enabled skill. See the [Ubuntu validation guide](ubuntu-validation.md) for real-machine checks. The CI result above records the earlier baseline; the review changes require their own passing run.

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
docker run --rm --init --network none codex-monitor-network-test
```
