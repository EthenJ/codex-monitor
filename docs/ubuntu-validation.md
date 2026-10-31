# Ubuntu validation guide

Use `develop` for the Node preview. `main` remains the standalone deployment branch. Node.js 22.22+ is required; Node 22.22.0, 24.17.0 and Codex 0.166.0 have been tested on Ubuntu. Use a regular user shell. Do not run the plugin or its observers with `sudo`.

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

Native tests create isolated Codex homes and a synthetic local Responses endpoint. They do not use your account or contact a paid model. On Linux, two Windows Job Object tests and the opt-in physical GPU test are expected to be skipped: currently 76 tests, 73 passing and three skips with native tests enabled. Record the commit (`git rev-parse HEAD`), `git status --short`, Node/Codex versions and complete output when reporting a failure.

On a host with working NVIDIA drivers, also run:

```bash
nvidia-smi
CODEX_MONITOR_TEST_NATIVE=1 CODEX_MONITOR_TEST_GPU=1 node --test --test-timeout=25000 tests/node/*.test.mjs
```

This should pass 74 tests with only the two Windows skips. GPU checks only query existing devices and run a finite quiet observer; they do not create GPU load or signal training processes. They check selections and sampling, while deterministic fixtures cover low-utilization/recovery transitions. Set `CODEX_MONITOR_NVIDIA_SMI` if the executable is outside `PATH`. See the [GPU validation guide](gpu-validation.md) for a read-only real transition probe and simulated driver failures.

For an Ubuntu 24.04 container run, with Docker installed and accessible to your user:

```bash
docker build -f tests/container/Dockerfile.ubuntu -t codex-monitor-ubuntu-test .
docker run --rm --init --network none codex-monitor-ubuntu-test
```

The image runs the complete Node suite as UID 1000, including native host fault tests, with no external networking. Image building downloads dependencies. This validates Linux userspace, not a physical GPU or the desktop application's daemon lifecycle.

To build and run both the dedicated network fixture and the full Ubuntu image, with separate logs and bounded test-container resources:

```bash
bash tools/validate-docker.sh
```

The runner uses `--init --network none`, two CPUs, 3 GiB RAM and a 512-PID limit for each test container. It retains uniquely tagged images and logs, and removes its test containers. The Ubuntu image discovers `tests/node/*.test.mjs` so new boundary and GPU-provider regressions are included. Physical GPU access is not enabled in these containers.

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

- **Files:** watch a temporary metrics file, then write, atomically replace, rename and delete it. Check native delivery, full evidence and explicit acknowledgement. Writes inside the notification debounce interval must still reset inactivity; deletion must not. Repeat on the filesystem you actually use; network mounts may require explicit `file_backend: polling`.
- **Processes:** observe a disposable training process, then stop the observer. The training process must survive. Separately launch a command owned by the monitor and cancel it; its descendants must exit. Graceful POSIX shutdown is covered; forced SIGKILL cannot run userspace cleanup.
- **Goal waiting:** authorize “pause while waiting, resume on completion or an alert.” Ensure healthy metrics do not create turns, the native goal is paused during waiting, and an event resumes the unchanged goal without resetting budget. Test cancellation and a manual goal edit while waiting.
- **Recovery:** enable it explicitly with finite limits. Use the isolated native tests for HTTP 503 and broken streams. Manually interrupt a real disposable task and verify recovery disables. Do not disrupt unrelated network traffic to test this.
- **GPU:** confirm `nvidia-smi` works, choose the actual GPU IDs and meaningful progress file, and use startup grace/dwell/hysteresis appropriate to training. Check quiet healthy operation, stall notification, recovery and exit. Missing samples are unknown, never zero. Queries, quiet monitoring and a diagnostic 100% threshold/recovery cycle passed on two RTX 4090 D cards. Actual idle-to-loaded transitions and distributed-training recovery still need separate validation.

Before stopping, read `monitor_status`, acknowledge handled events and report remaining observers, waits and recovery. An accepted native result is not proof that every external action completed. See [runtime contracts](../codex-monitor/references/plugin.md) and [recorded results](node-validation.md).
