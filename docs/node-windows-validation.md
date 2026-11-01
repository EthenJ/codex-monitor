# Native Windows validation

Current candidate: Node plugin v0.2.2 on `develop`. The deployment branch and packages exclude tests, workflows and TypeScript source. Legacy Python results do not establish Node coverage.

## Latest verified run

Windows, Node 24.22.0, Codex 0.166.0: **132 tests, 126 passed, six expected skips, zero failures**. The six skips cover physical NVIDIA access and POSIX-only GPU-provider/permission checks. TypeScript compilation and skill validation passed. See [v0.2.2 notes](releases/v0.2.2.md) for features and remaining acceptance checks.

The suite includes real Codex registration and replacement from both an isolated source checkout and a deployment package. Tests verify paths containing spaces/Unicode, UTF-8 BOM answers, a previously nonexistent Codex home, preview behavior, both hook choices, actual MCP tool execution and default display settings. It also verifies launcher replacement, preservation of unrelated configuration, active-monitor refusal and dependency/registration failure behavior. Synthetic local providers exercise native events, hooks and recovery without user credentials or paid models.

The current user installation is not replaced by these tests. Interactive terminal acceptance in a new user session remains the next check. Desktop HTML rendering, the new installer on Ubuntu/macOS and current physical GPU acceptance remain unverified.

## Run the suite

Use native PowerShell, not WSL, to test Windows Job Objects. Install Node 22.22+ (24 recommended), npm and Codex CLI 0.166.0+.

```powershell
npm ci
npm run build
$env:CODEX_MONITOR_TEST_NATIVE = '1'
node --test tests/node/*.test.mjs
python tools/validate_skill.py codex-monitor
npm run package -- dist/codex-monitor-v0.2.2
```

Native installation tests download locked npm dependencies unless already available in an offline cache. They use temporary homes and do not copy account credentials. Ordinary `npm test` leaves the optional native tests disabled. Read-only physical GPU cases require `CODEX_MONITOR_TEST_GPU=1` and working `nvidia-smi`.

## New-session installation acceptance

Run `node install.mjs --dry-run` in a normal terminal, or ask an agent to collect preferences and create an answers file as described in the [installation guide](../codex-monitor/references/installation.md). Use a distinct simulation home to preserve the current plugin.

Verify that setup asks about the configuration directory, client, compact/verbose display, reporting hooks and launcher. Inspect the plan before confirming. After installation, follow its printed environment and restart instructions. Check `/plugins` and `/mcp`, actually execute `monitor_display`, then review only this plugin's Stop/Interrupt hooks through `/hooks` if enabled. Finish installation before hook review; later bundle edits invalidate its fingerprint.

Run a short command-exit demo and verify start, native callback, event inspection/acknowledgement and the one-line Stop report. Manual interruption uses Interrupt. CLI output is text; an independent background-arrival card and HTML panel are not supported there. Do not treat a tool catalog or UI resource as proof of desktop graphical rendering.

Keep logs, runtime versions and skip reasons. Clean up test observers/brokers by their recorded identities; preserve unrelated workloads. Monitor state and preferences live outside the plugin bundle.
