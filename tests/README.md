# Test coverage and maintenance

The Node suite covers the current plugin. Build before running individual files;
they import the generated runtime, not TypeScript source.

```sh
npm test
```

For a focused subagent regression after building:

```sh
npm run build
node --test --test-timeout=60000 tests/node/subagents*.test.mjs
```

## Coverage map

| Area | Primary coverage |
| --- | --- |
| Ownership, subtree access, delivery leases, root policy | `node/subagents.test.mjs` with `node/fixtures/subagents.mjs` |
| Async lifecycle and persistence races | `node/subagents-races.test.mjs`; controlled RPC gates determine ordering |
| Real native agent messages and closure | `node/subagents-native.test.mjs`; isolated host with a test MCP adapter |
| Real spawn, inherited production MCP tools and shared service | `node/subagents-service-native.test.mjs` |
| Native goal lifecycle and blocking input | `node/goal-native.test.mjs`, `node/blocking-native.test.mjs`, `node/cli-input-native.test.mjs` |
| Recovery, sensors and compatibility pause mode | `node/runtime.test.mjs`, `node/blocking.test.mjs`, `node/network.test.mjs`, `node/edges.test.mjs` |
| Event inspection/acknowledgement and display | `node/display.test.mjs`, `node/presentation.test.mjs` |
| Reports, hooks, installation and package activation | `node/report.test.mjs`, `node/hooks-native.test.mjs`, `node/installer*.test.mjs` (includes cross-workspace MCP/UI loading) |
| SSH transport and shared incidents | `node/ssh*.test.mjs` and `container/Dockerfile.ssh` |

Fake-host tests verify deterministic state transitions. Native tests verify host
protocol and tool behavior; they use an isolated local Responses provider rather
than a paid model. Neither establishes model compliance with skill instructions.

## Optional environments

- Set `CODEX_MONITOR_TEST_NATIVE=1` to run native host fixtures with a compatible
  Codex CLI installed. Leave the user's installed plugin and Codex home unchanged.
- Set `CODEX_MONITOR_TEST_SSH=1` with Docker running and build
  `container/Dockerfile.ssh` as `codex-monitor-ssh-test` for real SSH tests.
  `node tools/test-ssh-linux.mjs` exercises the isolated Linux SSH client/server.
- Build `container/Dockerfile.ubuntu` for the full non-root Ubuntu suite; run with
  `--rm --init --network none`. Local native provider fixtures still use loopback.
- GPU hardware/provider and platform-specific cases have explicit gates in their
  test files. Report skipped tests separately from passes.

The Python `test_*.py` files cover the separately supported standalone helpers.
They are not duplicates of the Node plugin tests and are not run by `npm test`:

```sh
python -W error::ResourceWarning -m unittest discover -s tests -v
```

## v0.4.1 cleanup

- Removed the generic native integration smoke test using an incomplete callback
  payload. Native goal and production MCP tests provide stronger end-to-end checks.
- Merged expired-event assertions into the existing atomic/idempotent event
  inspection and resolution test, retaining unknown-ID and expiry behavior.
- Removed the duplicate native child-event variant. The production MCP subagent
  test now owns event delivery, continuation-count and unchanged-goal assertions;
  native parent-message and close variants remain.
- Extracted the shared subagent fixture and removed unrelated duplicate callback
  assertions from the SSH creator-partition case. Fake-host test names no longer
  imply native-host coverage.
- Kept GPU parser edge cases in `edges.test.mjs` and removed their duplicate
  assertions from the runtime health-state test. Named transient recovery tests
  explicitly to distinguish them from `all_failed` behavior.
- Merged the separate plugin-install fixture into the real wizard fixture. It
  verifies cross-workspace loading, all eight tool names and UI resources after
  both installation and upgrade, without copying/installing a second fixture.

This removes four redundant top-level cases. Fifteen new regression cases
cover reproduced lifecycle races and associated boundaries, so the total grows.
Compatibility pause mode, transient/all-failed recovery and Python standalone
coverage remain because those behaviors are still supported.

Before removing a regression, identify where its observable behavior is covered.
Prefer deterministic gates over timing guesses for concurrency. Bound waits and
clean up fixture processes, servers and directories even when assertions fail.
