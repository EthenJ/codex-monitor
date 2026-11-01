# Native Windows validation

Current candidate: Node plugin v0.2.3 on `develop`. The deployment branch and packages exclude tests, workflows and TypeScript source. Legacy Python results do not establish Node coverage.

## Latest verified run

Windows, Node 24.22.0, Codex 0.166.0: **153 tests, 147 passed, six expected skips, zero failures**. The six skips cover physical NVIDIA access and POSIX-only GPU-provider/permission checks. TypeScript compilation and both skill validators passed. See [v0.2.3 notes](releases/v0.2.3.md) for changes and installation.

The goal investigation reproduced ordinary callbacks bypassing manual pause, unrelated events waking an authorized wait, later selected events escaping cancelled waits, and repeated manual pauses sharing identical second-resolution goal snapshots. Regression tests cover those failures, stale reads, notification/response ordering, equivalent wait reuse and expired history. Four real App Server fixtures validate complete pause/resume and interruption paths against a local synthetic provider. They confirm that pausing a goal leaves its current turn running.

Full validation also exposed a Windows pending-deletion `EPERM` race during concurrent startup and a transient SQLite cleanup lock in the native network fixture. Startup acquisition now retries only within its existing deadline, with deterministic tests preserving persistent permission failures. Test cleanup uses bounded retries and still reports final errors. The final full suite passed after both fixes.

The suite includes real Codex registration and replacement from both an isolated source checkout and a deployment package. Tests verify paths containing spaces/Unicode, UTF-8 BOM answers, a previously nonexistent Codex home, preview behavior, both hook choices, actual MCP tool execution and default display settings. It also verifies launcher replacement, preservation of unrelated configuration, active-monitor refusal and dependency/registration failure behavior. Synthetic local providers exercise native events, hooks and recovery without user credentials or paid models.

For v0.2.2, the user reinstalled the plugin successfully; fresh discovery and actual execution verified the new tools, native callback and both trusted reporting hooks. That release's CI passed Ubuntu container installation and replacement. The v0.2.3 tests use isolated homes and do not upgrade the user's live installation. Desktop HTML rendering, manual macOS installation and current physical GPU acceptance remain unverified.

## Run the suite

Use native PowerShell, not WSL, to test Windows Job Objects. Install Node 22.22+ (24 recommended), npm and Codex CLI 0.166.0+.

```powershell
npm ci
npm run build
$env:CODEX_MONITOR_TEST_NATIVE = '1'
node --test tests/node/*.test.mjs
python tools/validate_skill.py codex-monitor
npm run package -- dist/codex-monitor-v0.2.3
```

Native installation tests download locked npm dependencies unless already available in an offline cache. They use temporary homes and do not copy account credentials. Ordinary `npm test` leaves the optional native tests disabled. Read-only physical GPU cases require `CODEX_MONITOR_TEST_GPU=1` and working `nvidia-smi`.

## New-session installation acceptance

Run `node install.mjs --dry-run` in a normal terminal, or ask an agent to collect preferences and create an answers file as described in the [installation guide](../codex-monitor/references/installation.md). Use a distinct simulation home to preserve the current plugin.

Verify that setup asks about the configuration directory, client, compact/verbose display, reporting hooks and launcher. Inspect the plan before confirming. After installation, follow its printed environment and restart instructions. Check `/plugins` and `/mcp`, actually execute `monitor_display`, then review only this plugin's Stop/Interrupt hooks through `/hooks` if enabled. Finish installation before hook review; later bundle edits invalidate its fingerprint.

Run a short command-exit demo and verify start, native callback, event inspection/acknowledgement and the one-line Stop report. Manual interruption uses Interrupt. CLI output is text; an independent background-arrival card and HTML panel are not supported there. Do not treat a tool catalog or UI resource as proof of desktop graphical rendering.

Keep logs, runtime versions and skip reasons. Clean up test observers/brokers by their recorded identities; preserve unrelated workloads. Monitor state and preferences live outside the plugin bundle.
