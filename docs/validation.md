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
| Backend startup | Cleanup could join an observer that had never started and obscure its original error. | Only started threads are joined; failed observer startup preserves its diagnostic. Missing optional dependencies fall back only in `auto` mode. |
| Health state | GPU outages could imply recovery; subscription delays and directory metadata could distort progress timing. | Unknown GPU values do not prove recovery. Health timing begins after subscriptions are ready; only qualifying progress resets inactivity. Pending events are processed before health evaluation. |
| GPU shutdown | A hung query could delay watchdog expiry; an unexpected worker exception could silently disable sampling. | Queries are cancellable independently of their ten-second limit, and unexpected worker failures are fatal sensor errors. |
| Resource bounds | Matching output and callback diagnostics could accumulate without suitable bounds. | Matched lines use a 256-item backpressure queue; file/GPU/PID events have a 1,024-item queue with explicit overflow failure. Callback output is drained into a 64 KiB tail. Lines over 16,000 characters fail explicitly; Codex messages are capped with a truncation marker. |

## Local tests

Windows 11 Pro for Workstations 26H2, build 26300; Codex CLI 0.166.0.

| Python runtime | Suite | Result |
| --- | --- | --- |
| 3.10.0, temporary compatibility runtime | 55 tests | Pass |
| 3.12.0, temporary compatibility runtime | 55 tests | Pass |
| 3.14.8, existing local runtime | 55 tests | Pass |

The temporary older runtimes are compatibility test fixtures, not recommended installations. Downloads and runtime files are ignored and excluded from Git. Each suite was run with resource warnings enabled as errors:

```powershell
python -W error::ResourceWarning -m unittest discover -s tests -v
python tools/validate_skill.py codex-monitor
```

The local system skill validator also passes. The suite includes real subprocess callbacks receiving Chinese JSON, real Windows file notifications, large/unread input, a 12 MB output producer with bounded diagnostics, descendant cleanup, PID exit, expiry/event-limit/cancellation preserving the training PID, simulated GPU failure/recovery, and queue overflow. The tests use deterministic health clocks where timing alone would not establish the state-machine rules.

A native CLI negative-path probe also confirmed that `--message=--help` is parsed as message data: an all-zero, nonexistent thread UUID is rejected as a missing thread, rather than causing an argument parsing failure. No message was sent to an existing conversation by this probe.

## Cross-platform CI

The workflow runs Windows, Ubuntu and macOS with Python 3.10, 3.12 and 3.14: nine combinations. Optional platform dependencies are installed to exercise the native `watchdog` and PID adapters; separate tests exercise explicit snapshot mode and missing-dependency behavior. Each job has a ten-minute timeout. Check the workflow's commit-specific result before attributing a pass to a revision.

## Remaining limits

- No live NVIDIA card was exercised. `nvidia-smi` is unavailable on the local machine; health logic and cancellation are tested with simulated providers and real owned subprocesses.
- A real idle Codex conversation executing a follow-up turn has not been verified end to end. Tests validate transport arguments, custom callback delivery, failure handling, and local CLI parsing. They do not establish daemon reachability or host survival after the registering turn ends.
- Delivery has no durable outbox or exactly-once guarantee. A crash, backend coalescing or queue overflow may lose observations; an ambiguous callback timeout may already have submitted its message. Inspect the destination before retrying manually.
- A file notification does not establish checkpoint completeness. Prefer a producer completion event or atomic publication of the final file.
- GPU utilization and file inactivity indicate a suspected stall. Shared cards and normal validation/loading/checkpoint pauses affect interpretation; choose thresholds for the workload's real cadence.
- POSIX cleanup covers the owned process group. A deliberately detached process that leaves that group is outside this ownership model. Abrupt host termination and unavailable filesystems cannot guarantee callback delivery.
