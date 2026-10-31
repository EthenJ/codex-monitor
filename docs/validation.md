# Validation report

Reviewed on 2026-10-31. This report describes the local release review and the automated checks committed with it. CI results belong to the exact commit shown in [GitHub Actions](https://github.com/EthenJ/codex-monitor/actions/workflows/test.yml).

## Scope and method

The review covered all four runtime scripts, skill instructions and references, installation layout, callback argument handling, process ownership, native/fallback file watching, health transitions, cancellation, bounded queues/output, and CI configuration. Suspected failures were reproduced with focused tests before the relevant fixes. Existing tests were retained and expanded; `--dry-run` is exercised on a real triggered condition.

## Findings and fixes

| Area | Failure found | Resulting behavior |
| --- | --- | --- |
| Callback status | A failed command callback could still yield exit code zero. | Any callback failure makes the final status nonzero, independently of `--stop-on-callback-error`. |
| Process ownership | Shell timeout could leave descendants alive; startup logging could raise before cleanup. | Owned commands/callbacks are grouped and cleaned up on normal completion, timeout, cancellation, or startup log failure. Windows children are created suspended, assigned to a Job Object, then resumed. Observed `--pid` processes remain untouched. |
| Windows compatibility | Older `communicate()` implementations could block while writing unread callback input, bypassing timeout. | Stdin JSON is supplied through a temporary file. A regression was reproduced on Python 3.12.0 and passes after the fix. |
| CLI values | A leading `--` in a message/name was interpreted as an option instead of a value. | The adapter uses `--message=...` / `--thread=...`, preserves metacharacters as argv data, and rejects Windows shell shims as `--codex-bin`. |
| File debouncing | Deletes/recreation could be suppressed; backlog draining could merge writes that occurred seconds apart. | Only repeated modifications are suppressed, using observation times. Deletes, renames and recreation remain distinct. |
| Subscription identity | Renaming/replacing the watched root could silently leave the wrong directory observed. | Root identity is checked and replacement/removal is a fatal sensor error. |
| macOS event paths | FSEvents returned canonical paths for a registered alias such as `/var`, and synthetic ancestor notifications could fail path filtering. | Canonical backend paths map to the registered root without resolving the event's leaf; unrelated ancestor/sibling notifications are ignored. Root replacement/removal still fails explicitly. |
| macOS process cleanup | A group with an exited, unreaped leader could raise `EPERM` during cleanup. | Reap the exited leader and retry once. Real permission failures still propagate, including for a live leader. |
| Backend startup | Cleanup could join an observer that had never started and obscure its original error. | Only started threads are joined; failed observer startup preserves its diagnostic. Missing optional dependencies fall back only in `auto` mode. |
| Health state | GPU outages could imply recovery; subscription delays and directory metadata could distort progress timing. | Unknown GPU values do not prove recovery. Health timing begins after subscriptions are ready; only qualifying progress resets inactivity. Pending events are processed before health evaluation. |
| GPU shutdown | A hung query could delay watchdog expiry; an unexpected worker exception could silently disable sampling. | Queries are cancellable independently of their ten-second limit, and unexpected worker failures are fatal sensor errors. |
| Resource bounds | Matching output and callback diagnostics could accumulate without suitable bounds. | Matched lines use a 256-item backpressure queue; file/GPU/PID events have a 1,024-item queue with explicit overflow failure. Callback output is drained into a 64 KiB tail. Lines over 16,000 characters fail explicitly; Codex messages are capped with a truncation marker. |

## Original Windows review (before the Ubuntu changes)

Windows 11 Pro for Workstations 26H2, build 26300; Codex CLI 0.166.0.

| Python runtime | Suite | Result |
| --- | --- | --- |
| 3.10.0, temporary compatibility runtime | 59 tests | Pass |
| 3.12.0, temporary compatibility runtime | 59 tests | Pass |
| 3.14.8, existing local runtime | 59 tests | Pass |

The temporary older runtimes are compatibility test fixtures, not recommended installations. Downloads and runtime files are ignored and excluded from Git. Each suite was run with resource warnings enabled as errors:

```powershell
python -W error::ResourceWarning -m unittest discover -s tests -v
python tools/validate_skill.py codex-monitor
```

The local system skill validator also passes. The suite includes real subprocess callbacks receiving Chinese JSON, real Windows file notifications, large/unread input, a 12 MB output producer with bounded diagnostics, descendant cleanup, PID exit, expiry/event-limit/cancellation preserving the training PID, simulated GPU failure/recovery, and queue overflow. The tests use deterministic health clocks where timing alone would not establish the state-machine rules.

A native CLI negative-path probe also confirmed that `--message=--help` is parsed as message data: an all-zero, nonexistent thread UUID is rejected as a missing thread, rather than causing an argument parsing failure. No message was sent to an existing conversation by this probe.

A clean Git archive of runtime revision `8fc1df6` was extracted outside the source tree into an ignored release-check directory. Its skill validator and all 59 tests passed, confirming that required helper files are included in the committed source. The eight installed skill files were synchronized to the final runtime source, checked by SHA-256, and passed both skill validators.

## Ubuntu and live GPU review

The follow-up review ran on Ubuntu 24.04.3 LTS, x86_64, kernel `7.0.0-38-generic`, with two NVIDIA GeForce RTX 4090 D cards and driver `610.57.04`. Existing GPU workloads were preserved; hardware tests only queried the driver and ran temporary local callbacks. Optional dependencies were isolated in project environments: watchdog 6.0.0 and psutil 7.2.2.

| Failure reproduced | Fix and regression coverage |
| --- | --- |
| `nvidia-smi --id=0,999` returned success and only GPU 0, silently omitting the missing card. | Query index, UUID and PCI identity with utilization; require every requested selector to appear. Empty selectors, malformed rows, duplicate rows, nonfinite/out-of-range values and provider failures fail explicitly. Aliases for the same card are supported. |
| Under `--gpu-match any`, alternating low cards could accumulate a dwell even though neither card remained low. | Track dwell per card; `any` requires one continuous low card, while `all` starts when the last card becomes low. Changed device sets and outages restart evidence. |
| An already-active GPU condition retained the original utilization values. | Successful samples refresh utilization evidence, including while waiting for a file-stall condition. |
| POSIX `SIGTERM` exited immediately without the cleanup path or a final lifecycle record. | Both entry points handle SIGTERM as cancellation, restore the previous signal handler, and clean up owned commands, callbacks and hanging GPU queries. Real subprocess tests also preserve an observed PID. |
| Linux native watching through a directory symlink missed atomic publications. | Subscribe to the canonical root and map notifications back to the registered path. A real native regression watches a missing Chinese filename through a symlink and publishes it atomically three times. Root replacement still fails explicitly. |
| A Python build can expose `pidfd_open` while the running kernel or container disallows it. | Fall back to psutil for unsupported/blocked calls; missing PIDs and unrelated failures remain sensor errors. Injected syscall failures exercise the fallback with real child exits. |

The symlink behavior follows from watchdog 6.0.0's default [`IN_DONT_FOLLOW` event mask](https://github.com/gorakhargosh/watchdog/blob/v6.0.0/src/watchdog/observers/inotify_c.py). The PID and signal adapters follow the documented [pidfd availability](https://docs.python.org/3.12/library/os.html#os.pidfd_open) and [main-thread signal handling](https://docs.python.org/3.12/library/signal.html#signals-and-threads). [NVIDIA's interface reference](https://docs.nvidia.com/deploy/nvidia-smi/index.html) documents physical GPU selectors; the partial-selection failure above was reproduced directly on this host.

Final Ubuntu suite results, with resource warnings treated as errors:

| Runtime / environment | Discovered | Passed | Skipped | Result |
| --- | ---: | ---: | ---: | --- |
| Python 3.10.19 + platform dependencies | 111 | 106 | 5 | Pass |
| Python 3.12.3 + platform dependencies | 111 | 106 | 5 | Pass |
| Python 3.13.11 + platform dependencies | 111 | 106 | 5 | Pass |
| Python 3.14.3 + platform dependencies | 111 | 106 | 5 | Pass |
| Python 3.12.3, clean environment without watchdog or psutil | 111 | 103 | 8 | Pass |
| Python 3.13.11, opt-in real NVIDIA checks | 4 | 4 | 0 | Pass |

The five default skips are one Windows-only test and four opt-in hardware tests. The clean environment also skips two native-watchdog tests and one psutil-fallback test; ordinary file tests exercise snapshot fallback there. Python 3.12 exercises real Linux pidfds, while this host's Conda Python 3.13 lacks `os.pidfd_open` and exercises the real psutil adapter. The first Ubuntu review added 22 portable/POSIX regressions and four opt-in GPU tests; the second boundary review below added 26 more, expanding the original 59-test suite to 111 discovered tests.

The four live checks passed actual index/UUID/PCI selection, detection of a partially missing GPU selection, repeated sampling and dry-run shutdown, and a real low-utilization callback receiving JSON on stdin. The callback test used existing utilization fluctuations with a short test dwell and a 100% boundary; it did not start or stop GPU work. Recovery/hysteresis/outage transitions were tested deterministically, including `alert -> provider failure -> low samples -> recovery` with one alert and no false recovery.

Reproduce in the project environment:

```bash
.venv/bin/python -W error::ResourceWarning -m unittest discover -s tests -v
CODEX_MONITOR_TEST_GPU=1 .venv/bin/python -W error::ResourceWarning \
  -m unittest discover -s tests -p test_live_gpu.py -v
.venv/bin/python tools/validate_skill.py codex-monitor
.venv/bin/python -m pip check
```

Skill validation, both CLI help entry points, byte-compilation, dependency consistency and `git diff --check` also passed. These are local Ubuntu results; Windows/macOS execution and hosted CI results must be checked separately for the published revision.

## Second boundary review

The second pass re-examined ownership before subscription readiness, failure while creating/starting worker threads, partial cleanup, callback data boundaries, short deadlines, inaccessible paths and symlink identity changes. It reproduced and fixed these additional cases:

| Boundary | Resulting behavior and evidence |
| --- | --- |
| Cancellation during file subscription | An interrupted `ready.wait()` now closes the watcher. The owner keeps its reference before calling `start()`. A backend created after cancellation also cleans itself up. Tests assert the subscription thread exits. |
| Output-reader initialization fails after process creation | Both command and callback paths clean up their owned process and output pipe, even before the ordinary reader cleanup block exists. Tests launch real sleeping processes and inject reader construction failure. Interrupted owned startup also cleans the whole process group after its leader exits. |
| Worker start or resource cleanup fails | Unstarted workers are not joined. File cleanup failures do not skip worker cleanup; the final lifecycle record includes cleanup errors and the exit status is nonzero. The original worker-start diagnostic remains visible. |
| Very short command lifetime | A reproduced 1 ms lifetime waited roughly 250 ms on the fixed queue timeout. Queue and EOF waits now use the remaining lifetime. Output received after the deadline cannot start another callback. OS process creation and cleanup are still not hard real-time operations. |
| Monitored file itself is a symlink | Native parent notifications missed target writes. Auto mode now reports snapshot fallback for a file symlink; explicit native mode rejects it with guidance to use polling or the target path. Polling tests cover target writes, retargeting, disappearance and recreation. A native file becoming a symlink fails explicitly. |
| Directory alias changes before registration | Canonicalization is refreshed when the watcher is armed and checked against the recorded root identity. A real file publication through a retargeted alias proves the new destination is observed. |
| Recursive snapshot loses directory access | `Path.rglob()` silently omitted unreadable descendants on this host, yielding false deletion evidence. Explicit `scandir` traversal preserves permission and I/O errors. Snapshot traversal honors cancellation rather than delivering a partial snapshot. |
| Output/callback command contains NUL | OS argv construction raised an uncaught `ValueError`. Callback adapters now return a failure diagnostic; the command monitor records callback failure, emits its final record and exits nonzero. |

The GPU oracle enumerates **13,122** four-sample sequences for two cards: each card reads low (5%), exactly at the low boundary (10%), or exactly at the recovery boundary (20%). It checks both `all` and `any` against an independent sliding-window dwell model and hysteresis state. Additional tests cover file/GPU truth tables, outages during an existing alert, warmup equality, 0%/100% thresholds, and invalid timing/template combinations being rejected before any workload starts. This is exhaustive over that finite model; it does not establish coverage of every possible driver, filesystem or scheduler behavior.

All four Python versions, the clean minimal environment and the four opt-in GPU tests were rerun after these changes. Resource warnings remain errors. The remaining platform/hardware limits below still apply.

## Windows verification handoff (historical, Ubuntu commit `6983e66`)

The [Windows validation checklist](windows-validation.md) provides PowerShell commands and expected results for the final working tree. A further test review corrected the late-observer cancellation regression to intercept both platform backends: the earlier test only intercepted `_watchdog()` and would incorrectly run real `_windows()` during the simulation on Windows. The corrected dispatch was also exercised locally with a simulated Windows platform. The live GPU invalid-selection test now accepts either a nonzero driver response or a rejected partial result, matching the adapter's two failure paths.

Three new tests in `tests/test_windows.py` require real Windows: repeated cancellation of pending directory reads with kernel handle counts; exact observed PID exit status; and Job cleanup of a callback tree after forced termination of the monitor while preserving an independently observed process. These are **pending actual Windows execution** and are skipped locally. They increase discovery from 111 to **114** tests. On Windows with GPU opt-in disabled, the expected count is **96 passed / 18 skipped** (14 POSIX-only tests and four live GPU opt-in tests), for both minimal and optional-dependency environments. These counts describe expectations, not a claimed Windows pass.

The final local checks on Python 3.10.19, 3.12.3, 3.13.11 and 3.14.3 each found 114 tests: **106 passed / 8 skipped** (four real-Windows tests in total and four opt-in GPU tests). The clean Python 3.12 environment passed **103 / 114**, with 11 expected skips. All four live GPU checks passed again. Local verification preceded the commit; the handoff checklist records both Git state and normalized source hashes to distinguish the tested source from older Windows results. A source-only ZIP was also prepared locally with all new tests and the checklist, plus `VALIDATION-SOURCE.json`; it excludes virtual environments, caches and Git metadata. Git users should verify the published revision with the checklist in that revision.

## Windows follow-up after the Ubuntu changes

The Ubuntu runtime revision `6983e66` was pulled and tested on native Windows 11 Pro for Workstations 26H2, build 26300, x64, PowerShell 7.6.9. Runtime scripts required no further changes. See the [Windows execution report and repeatable checklist](windows-validation.md) for full details.

| Local environment | Discovered / passed / skipped | Result |
| --- | --- | --- |
| Python 3.10.0, no optional dependencies | 115 / 97 / 18 | Pass |
| Python 3.12.0, no optional dependencies | 115 / 97 / 18 | Pass |
| Python 3.14.8, clean venv without optional dependencies | 115 / 97 / 18 | Pass |
| Python 3.14.8, isolated venv with watchdog 6.0.0 and psutil 7.2.2 | 115 / 97 / 18 | Pass |
| Python 3.12.0, source copied to a Chinese/space-containing directory | 115 / 97 / 18 | Pass |

All runs treated resource warnings as errors. Final logs contained no resource warnings, ignored exceptions or thread tracebacks. The 18 skips are 14 POSIX/Linux-only tests and four opt-in live GPU checks. All four Windows-specific tests executed. Both skill validators, CLI help and `pip check` passed. A nonexistent GPU provider returned exit status 1 with one error event and an unavailable sensor, without a false health transition. Live NVIDIA sampling remains untested on this Windows host; the Ubuntu hardware results above remain valid for that host.

The initial local 3.10/3.12 runs reproduced the [incoming CI handle-count failure](https://github.com/EthenJ/codex-monitor/actions/runs/41211603526). The test retained its final watcher object while the warm-up object had already been released. On Python 3.12, construction alone added four synchronization handles: baseline 136, constructed 140, armed 143, closed-but-retained 140, released 136. Three further batches of 20 start/close/release cycles each remained at 136. The regression now releases the watcher after checking its thread has exited, before measuring; its leak tolerance is unchanged.

An additional real Windows console test sends `CTRL_C_EVENT` inside a separate hidden console. Native and snapshot watchers and the command helper must emit a final cancelled record and exit successfully. The observed PID remains alive, and owned command descendants cannot continue writing after cancellation. This complements the existing forced-termination Job Object check and does not send console signals to unrelated processes. Source discovery is now 115; non-Windows hosts skip this additional Windows-only test. No live Codex wake-up was attempted.

The first follow-up CI passed the Windows jobs but exposed a pre-existing macOS test assumption: it created a file before registration, wrote it again later, and required exactly one callback. Logs showed the historical create and later modification arriving 507–544 ms apart, legitimately outside the 500 ms debounce interval. The native integration test now publishes only after registration and verifies callback delivery. Exact create/modify burst suppression, deletion/recreation preservation and backlog timing remain covered by the deterministic regressions; no runtime debounce rule was weakened.

## Cross-platform CI

The workflow runs Windows, Ubuntu and macOS with Python 3.10, 3.12 and 3.14: nine combinations. Optional platform dependencies are installed to exercise the native `watchdog` and PID adapters. Two additional Ubuntu/Windows Python 3.12 jobs run without optional dependencies, exercising actual snapshot fallback on Ubuntu and dependency-free Win32 adapters on Windows. Separate tests cover explicit snapshot mode and missing-dependency behavior. All 11 jobs have a ten-minute timeout. Check the workflow's commit-specific result before attributing a pass to a revision.

The [first expanded CI run](https://github.com/EthenJ/codex-monitor/actions/runs/41144612492) passed all six Windows/Ubuntu combinations and exposed the macOS path and zombie-group cleanup defects above. These were fixed rather than skipped. Four new regressions cover canonical paths, unrelated notifications, the exited-leader retry, and genuine permission failures. The atomic-replacement health test now waits for subscription/progress acknowledgements and uses an explicit short snapshot interval; the native event test still exercises create/modify/rename/delete. The simulated GPU integration test holds its low state until the alert is delivered, so a busy consumer does not miss an artificially brief test condition. The slow-callback backlog regression stops after three events with a separate safety deadline, instead of requiring three 100 ms callbacks to fit a 350 ms wall-clock budget on a shared runner.

The cleanup handling is consistent with [Apple's XNU signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c), whose group iteration excludes zombies and can return `EPERM` when no eligible member is found. The [watchdog FSEvents adapter](https://github.com/gorakhargosh/watchdog/blob/v6.0.0/src/watchdog/observers/fsevents.py) canonicalizes its watched path and emits synthetic parent-directory changes. CI logs and local regression tests provide the release-specific evidence; these source links explain the backend behavior.

Runtime revision `8fc1df6` [passed all nine CI jobs](https://github.com/EthenJ/codex-monitor/actions/runs/41145420101). Windows runs all 59 tests; Ubuntu and macOS run 58 and skip the one Windows-only shell-shim test. The workflow was then updated to the official Node 24 releases [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-python v7.1.0](https://github.com/actions/setup-python/releases/tag/v7.1.0), pinned by full commit hashes, to remove the observed Node 20 deprecation warning. Subsequent workflow results are linked at the top of this report.

## Remaining limits

- Real NVIDIA sampling and low-utilization callbacks passed on the Ubuntu host above. Driver resets, physical GPU removal and real hardware failure/recovery were not induced; these conditions use simulated providers and deterministic state tests. AMD/Apple GPUs and MIG-specific metrics remain outside the supported adapter.
- A real idle Codex conversation executing a follow-up turn has not been verified end to end. Tests validate transport arguments, custom callback delivery, failure handling, and local CLI parsing. They do not establish daemon reachability or host survival after the registering turn ends.
- Delivery has no durable outbox or exactly-once guarantee. A crash, backend coalescing or queue overflow may lose observations; an ambiguous callback timeout may already have submitted its message. Inspect the destination before retrying manually.
- A file notification does not establish checkpoint completeness. Prefer a producer completion event or atomic publication of the final file.
- Application event-queue overflow fails explicitly. Native backend coalescing and kernel event loss remain best-effort: watchdog 6.0.0 discards Linux inotify records with watch descriptor `-1`, including kernel `IN_Q_OVERFLOW`, so the monitor cannot promise to diagnose every native kernel overflow. Use a heartbeat/inactivity rule for progress and explicit polling when that tradeoff suits the filesystem.
- GPU utilization and file inactivity indicate a suspected stall. Shared cards and normal validation/loading/checkpoint pauses affect interpretation; choose thresholds for the workload's real cadence.
- POSIX cleanup covers the owned process group. A deliberately detached process that leaves that group is outside this ownership model. Abrupt host termination and unavailable filesystems cannot guarantee callback delivery.
