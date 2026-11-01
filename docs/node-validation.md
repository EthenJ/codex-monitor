# Node plugin validation

## v0.2.3 goal pause and resume fixes

Windows with Node 24.22.0 and Codex 0.166.0 passed **153 tests: 147 passed, six expected skips, zero failures**. Four isolated native App Server tests cover conditional goal waiting, manual pause/resume, interruption and repeated manual pause. See [Windows validation](node-windows-validation.md) for the reproduced defects, Windows startup/cleanup follow-ups and test command, and [v0.2.3 release notes](releases/v0.2.3.md) for behavior and installation. The user's installed plugin is unchanged by these isolated tests. Earlier sections record historical snapshots.

[Final source CI at `fe2e4f0`](https://github.com/EthenJ/codex-monitor/actions/runs/41289652521) passed all **18 jobs**, including Node 22/24 on Windows, Ubuntu and macOS, native network fault injection and the full Ubuntu 24.04 suite with external networking disabled. Runtime code is unchanged from `83e9353`; later commits correct native fixture initialization and callback-turn selection. The fixture creates a paused goal, starts its explicit turn and then activates the goal, preventing native idle-goal startup from racing the controlled model request. All four goal lifecycle scenarios also passed locally on Windows and in the Ubuntu container.

## v0.2.2 candidate

Typed MCP schemas, read-only preflight validation, `monitor_report` and informational Stop/Interrupt hooks are implemented on `develop`. The current Windows suite has **104 tests: 98 passed and six expected platform/hardware skips**. Real Codex tests use isolated homes and a local synthetic provider; user configuration and hook trust remain unchanged. A deterministic regression verifies the fix for a startup lock released during concurrent service registration. Extended file-observation diagnostics captured Windows directory changes with identical timestamps; preflight and documentation now state the limits of stat-based polling, and readiness fixtures use distinguishable initial metadata without waiting after readiness.

See [v0.2.2 release notes](releases/v0.2.2.md) for final CI, isolated installation evidence, hook rendering/trust requirements and remaining platform limitations. Main, published tags and the live v0.2.1 installation are unchanged during candidate validation.

## Public v0.2.1 recovery update

Package 0.2.1 adds a configurable fixed 300-second retry interval, a three-hour incident limit, and explicit `all_failed` coverage for unlisted terminal failures. Windows with native host tests enabled passed **85 tests: 81 passed, four expected skips**. See [v0.2.1 release notes](releases/v0.2.1.md) for current validation and the authorized main-history cleanup. The records below describe earlier snapshots.

## Public v0.2 release follow-up

Public package **0.2.0** is preserved at tag `v0.2`; the historical preview labels below do not denote public releases. During release preparation, a real failed turn contained `codexErrorInfo: "other"` and the exact message `stream disconnected before completion: Our servers are currently busy. Please try again in a moment.` The previous classifier rejected it. The v0.2 classifier accepted only that additional exact message, without accepting arbitrary unknown errors or overriding permanent error codes. The task's recovery supervisor was disabled when the real failure occurred.

A synthetic SSE `response.failed` provider reproduced the same message and `other` classification through Codex 0.166.0. The native test verified a terminal failure, backoff, one recovery submission and successful completion. Unknown/quoted/suffixed messages and permanent error codes remain rejected. Windows with native tests enabled passed **76 tests: 72 passed, four expected skips**. Release-specific CI is recorded in the [release notes](releases/v0.2.md).

Validation date: 2026-11-01. This preview is developed on `develop`. Deployment `main` and the published v0.1 release are unchanged. The [Python v0.2 report](plugin-validation.md) is historical and does not establish Node compatibility.

## File observation reconciliation after the Ubuntu review

The [CI run for 9058a75](https://github.com/EthenJ/codex-monitor/actions/runs/41232085391) exposed directory-listening failures on Windows and macOS; Ubuntu passed. Windows polling compared initial bigint file statistics with later number statistics and emitted a modification for an unchanged existing file. macOS native callbacks also failed the initial-file assertion. These notifications could incorrectly reset training inactivity.

The sensor now records the initial selected-file versions from Chokidar's public scan filter and reconciles subsequent notifications before updating health or notification debounce. File identity, size, mode, mtime and ctime use consistent numeric representations, retaining sub-millisecond timestamps. Unchanged versions are suppressed; observed writes, atomic replacements, deletion and recreation remain observable. This adds no startup sleep or extra filesystem polling. Version history is cleared on deletion and shutdown. It compares metadata, not file contents; a filesystem that exposes no metadata change cannot establish a new write.

Windows build 26300, Node 24.22.0 and Codex 0.166.0 passed **74 tests: 70 passed, four expected skips, zero failures**, with native host tests enabled. The skips are the physical GPU test and three POSIX GPU-provider fixtures. Five additional regression cases cover mixed stat representations, quiet initial files and immediate post-readiness create/write/replace/delete/recreate behavior on both native and polling backends. The [CI run for a8d1576](https://github.com/EthenJ/codex-monitor/actions/runs/41232873182) passed all 18 jobs, including all six Node 22/24 jobs on Windows, macOS and Ubuntu. The full Ubuntu 24.04 container passed 71 of 74 tests with three expected skips; the dedicated native network fixture also passed all three cases. The remaining 11 jobs validated legacy Python compatibility.

The rebuilt production package includes the compiled file-observation module and excludes development sources, tests, workflows and TypeScript dependencies. Its production dependency install reported zero known vulnerabilities. Installation through the real Codex plugin CLI in a new isolated home succeeded; all seven MCP tools and the enabled skill were discovered, and an observer was armed and stopped successfully. The user's active Codex configuration was unchanged.

## Local Docker and native GPU delivery follow-up

Docker was installed on the Ubuntu host for this follow-up: Engine/client 29.1.3, Buildx 0.30.1, containerd 2.2.1, cgroup v2 and overlayfs. The working tree is still based on `develop` commit `7be4880`, with the fixes and new tests described here. Both images built and ran successfully via `tools/validate-docker.sh`:

| Container | Result |
| --- | --- |
| Dedicated native network fixture, `node:24-bookworm-slim` | **3 passed, zero failures/skips**, about 3.09 seconds |
| Full Ubuntu 24.04 image, UID/GID 1000, Node 24.22.2, Codex 0.166.0 | **69 tests: 66 passed, three expected skips, zero failures**, about 14.37 seconds |

The three Ubuntu skips were two Windows Job Object tests and the opt-in physical GPU test. All new boundary and executable GPU-provider tests ran. The Ubuntu Dockerfile previously listed only the original three test files; its entrypoint now discovers `tests/node/*.test.mjs` so added regressions are included. Host tests with real GPUs enabled separately passed 67 of 69 cases on both Node 22.22.0 and 24.17.0.

Both test containers used `--init --network none --cpus 2 --memory 3g --pids-limit 512`, with no host workload mounts or GPU passthrough. Package/image downloads occurred during builds; test providers used only container loopback. Test containers were removed. Images remain for reuse: `codex-monitor-network-test:local-20261031185345-486924` (`00a390e5f00b7`) and `codex-monitor-ubuntu-test:local-20261031185345-486924` (`e0812d8b2cc5`). Local logs, full image IDs/configuration, runtime versions and source hashes are retained under ignored `.tmp-docker-gpu-8lmkyaay/`.

A watchdog registered directly with the local plugin service also observed a real diagnostic GPU threshold crossing (100%/99%, approximately 306 ms below the configured 100% threshold) and recovery. Both `watchdog_stalled` and `watchdog_recovered` arrived in the original conversation as native tool outputs, were inspected and explicitly acknowledged. The observer stopped at its two-event limit. This verifies the GPU event-to-conversation path, while actual 0–10% idle-to-loaded transitions and real driver outages remain untested on hardware. No existing training process was stopped or modified.

## Additional GPU pipeline coverage

The subsequent local follow-up adds three POSIX GPU-provider tests. The complete suite now has **69 tests**; on Ubuntu with native Codex and physical GPU tests enabled, Node 22.22.0 and 24.17.0 each passed **67 tests with two Windows-only skips**. The previous 66-test totals below describe the earlier working tree.

The new executable provider fixture exercises the actual subprocess and parser pipeline: low/mid/high utilization, persistent `N/A`, no false recovery across unknown samples, rearming, malformed/duplicate/missing devices, nonzero driver exit, and cancellation/deadline cleanup of a hung query. All three tests passed. Windows skips these POSIX fixtures explicitly.

`tools/probe-gpu-transitions.mjs` additionally observed a real threshold-and-recovery cycle on the two busy RTX 4090 D cards without signalling any existing workload. The reusable probe collected 27 samples and completed in about 7.76 seconds with a 100% diagnostic threshold; it saw a sustained 99% sample and subsequent recovery to 100%. Separate checks verified expiry without a cycle returns an inconclusive result and invalid parameters fail. This establishes a real sampling/event transition, not actual idle-to-loaded training recovery. See [GPU validation](gpu-validation.md) for reproduction and limits.

## Ubuntu physical-host follow-up

Tested the working tree based on `develop` commit `7be4880`, including the fixes below, on Ubuntu 24.04 as a regular user. Environment: Linux 7.0.0-38-generic, Node 24.17.0 and 22.22.0, npm 11.17.0, Codex 0.166.0, two NVIDIA RTX 4090 D cards with driver 610.57.04. The initial unchanged baseline passed 48 of 50 tests, with two Windows-only skips.

Four reproduced issues were corrected, with regressions that failed before the fixes:

- HTTP chunks could split a UTF-8 character and corrupt Chinese monitor names, paths or instructions. The service now decodes the complete, byte-bounded request. Tests also cover authentication, malformed JSON and the exact 65,536-byte limit with multibyte input.
- Command debounce suppressed distinct consecutive matching lines. Only identical consecutive matches are now suppressed within the interval.
- Native and polling file debounce also suppressed training-progress updates. Every observed write now resets inactivity; only notifications are debounced. Deletion and directory churn still do not reset progress.
- A file used as `cwd`, or a directory used as `watch_file`, could be reported as armed. Registration now rejects both; periodic verification also rejects replacement of a file with a directory.

Final checks:

| Check | Result |
| --- | --- |
| Strict TypeScript build on Node 22.22.0 and 24.17.0 | Passed |
| Full Node suite, native Codex and physical GPU enabled, on each Node version | **66 tests: 64 passed, two Windows Job Object skips, zero failures** |
| Real local App Server, HTTP 503, broken response stream, manual interruption | Passed using isolated Codex homes and a synthetic loopback provider |
| Native/polling recursion, filename filtering, ignored initial files; 12 concurrent observer registrations | Passed |
| Owned command output limit, timeout, cancellation and failed startup | Passed |
| GPU warmup, exact dwell, hysteresis, unknown samples, file/card `all`/`any`, malformed/missing CSV | Passed deterministic tests |
| Missing GPU executable | One unknown-sensor error, no false stall, finite expiry |
| Production-only package in a separate temporary directory | Lock-file install/audit passed; seven MCP tools discovered; Chinese paths, arm/reconnect/status/stop passed; sources/tests/Python/development dependencies excluded |
| Legacy Python compatibility suite (Python 3.13) | **115 tests: 106 passed, nine platform/opt-in skips** |
| Skill manifest and whitespace checks | Passed |

Physical GPU tests queried both cards using index, UUID, PCI bus ID and combined selections, and rejected a nonexistent UUID. The finite observer collected multiple successful samples and expired with no false stall, recovery or sensor-error events. Utilization was approximately 99–100%; the test used a zero-percent low threshold to verify quiet monitoring without changing existing workloads. No training process was started, stopped or signalled. At this stage sustained-low/recovery transitions were covered only by deterministic fixtures; the subsequent follow-up above adds real diagnostic threshold crossings. Enable the quiet read-only test with `CODEX_MONITOR_TEST_GPU=1`; optionally set `CODEX_MONITOR_NVIDIA_SMI` to the executable path.

The initial physical-host review did not run Windows/macOS or Docker (Docker was absent then), and did not install into the user's active Codex configuration. The subsequent Docker and native GPU delivery results are recorded above. Earlier CI/Windows/container evidence below applies to the recorded earlier revisions, not these new fixes. Use the [Node Windows checklist](node-windows-validation.md) to validate this working tree on Windows. Task test observers and services were stopped after validation.

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

## Follow-up lifecycle review

The review corrected these boundary cases and added regression coverage:

- File deletion and directory churn no longer reset training inactivity. Startup grace begins after sensor registration is ready.
- An accepted recovery submission cannot be duplicated while the host still reports the preceding failed turn.
- Acknowledged or expired pending events and observers that end without a deliverable event settle dependent waits, leaving the goal unchanged. Muted observers cannot start another wait.
- History cleanup preserves instructions for unresolved events and removes settled event references with their monitor records.
- Invalid options and inherited-object IDs are rejected. Cancellation during registration and failed proxy connections clean up their watchers and owned processes.

Final full Ubuntu 24.04 container validation passed **48 tests with two Windows-only skips and zero failures**, using UID 1000 and `--init --network none`. Windows passed all 50 tests. The rebuilt deployment package again installed successfully and exposed all seven tools plus the enabled skill. See the [Ubuntu validation guide](ubuntu-validation.md) for real-machine checks.

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

The final [development CI run for 52b18aa](https://github.com/EthenJ/codex-monitor/actions/runs/41229790267), including the follow-up lifecycle fixes, completed with **all 18 jobs passing**:

| Coverage | Result |
| --- | --- |
| Node 22 and 24 on Windows, Ubuntu and macOS; compilation, regression and deployment packaging | All six jobs passed |
| Native HTTP 503, broken stream and manual interruption inside Docker with `--network none`; full Ubuntu 24.04 suite as UID 1000 | Three network cases passed; full suite passed 48 tests with two Windows-only skips |
| Legacy Python 3.10, 3.12 and 3.14 on all three platforms | All nine jobs passed |
| Legacy tests without optional platform dependencies on Windows and Ubuntu | Both jobs passed |

The legacy replacement/deletion fixture accepts equal timestamps within older Windows monotonic-clock ticks while retaining progress-count and stall-duration assertions. No production behavior was weakened to accommodate the test.

The Windows launcher now avoids requesting a second job breakaway when an external broker starts an observer. A new Windows test reproduces an enclosing job that denies breakaway; observer startup succeeds through the broker locally and in hosted Windows CI. Direct MCP startup still requires breakaway or an external bootstrap. See Microsoft's [nested job rules](https://learn.microsoft.com/windows/win32/procthread/nested-jobs). A flaky legacy polling test was also changed to synchronize replacement/deletion with watcher readiness and observed progress instead of racing a short inactivity deadline.

The physical-host follow-ups above add NVIDIA query, quiet-monitoring and diagnostic threshold/recovery coverage. Actual idle-to-loaded training transitions, distributed training, production provider outages and other Codex versions remain unvalidated. Standard Node matrix jobs skip native Codex tests when the CLI is unavailable and skip the opt-in GPU test; the dedicated container supplies the pinned CLI for real network fault coverage.

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
docker run --rm --init --network none codex-monitor-network-test
```
