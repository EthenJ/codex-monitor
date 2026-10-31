# Ubuntu validation guide

Use `develop` for the Node preview. `main` remains the standalone deployment branch. Node.js 22.22+ is required; Node 24 and Codex 0.166.0 are the tested versions. Use a regular user shell. Do not run the plugin or its observers with `sudo`.

## Prepare and test

From your checkout, preserving any local changes before switching branches:

```bash
git switch develop
git pull --ff-only origin develop
node --version
codex --version
npm ci
npm run build
CODEX_MONITOR_TEST_NATIVE=1 node --test --test-timeout=25000 tests/node/*.test.mjs
```

Native tests create isolated Codex homes and a synthetic local Responses endpoint. They do not use your account or contact a paid model. On Linux, the two Windows Job Object tests are expected to be skipped. All other tests should pass. Record the commit (`git rev-parse HEAD`), Node/Codex versions and complete output when reporting a failure.

For an Ubuntu 24.04 container run, with Docker installed and accessible to your user:

```bash
docker build -f tests/container/Dockerfile.ubuntu -t codex-monitor-ubuntu-test .
docker run --rm --init --network none codex-monitor-ubuntu-test
```

The image runs the complete Node suite as UID 1000, including native host fault tests, with no external networking. Image building downloads dependencies. This validates Linux userspace, not a physical GPU or the desktop application's daemon lifecycle.

## Install into your Codex environment

If upgrading an existing copy, first stop its observers and pending waits, disable recovery, and stop its Node launcher with `node codex-monitor/runtime/cli.js stop-broker`. Allow idle thread services to exit. Disable an older standalone skill so it does not supply conflicting instructions.

From an external terminal, after building:

```bash
npm run bootstrap
codex plugin marketplace add .
codex plugin add codex-monitor@codex-monitor
```

If the same plugin version was already cached, use `codex plugin remove codex-monitor@codex-monitor` before adding it again. Restart the Codex client, then verify the seven monitor tools are available. Keep Node and the Codex CLI accessible in the environment inherited by the launcher. Rerun bootstrap after logout/reboot; there is no system service.

## Exercise the real workload/session boundary

- **Files:** watch a temporary metrics file, then write, atomically replace, rename and delete it. Check native delivery, full evidence and explicit acknowledgement. Deletion must not reset training inactivity. Repeat on the filesystem you actually use; network mounts may require explicit `file_backend: polling`.
- **Processes:** observe a disposable training process, then stop the observer. The training process must survive. Separately launch a command owned by the monitor and cancel it; its descendants must exit. Graceful POSIX shutdown is covered; forced SIGKILL cannot run userspace cleanup.
- **Goal waiting:** authorize “pause while waiting, resume on completion or an alert.” Ensure healthy metrics do not create turns, the native goal is paused during waiting, and an event resumes the unchanged goal without resetting budget. Test cancellation and a manual goal edit while waiting.
- **Recovery:** enable it explicitly with finite limits. Use the isolated native tests for HTTP 503 and broken streams. Manually interrupt a real disposable task and verify recovery disables. Do not disrupt unrelated network traffic to test this.
- **GPU:** confirm `nvidia-smi` works, choose the actual GPU IDs and meaningful progress file, and use startup grace/dwell/hysteresis appropriate to training. Check quiet healthy operation, stall notification, recovery and exit. Missing samples are unknown, never zero. GPU and distributed-training behavior still need real hardware validation.

Before stopping, read `monitor_status`, acknowledge handled events and report remaining observers, waits and recovery. An accepted native result is not proof that every external action completed. See [runtime contracts](../codex-monitor/references/plugin.md) and [recorded results](node-validation.md).
