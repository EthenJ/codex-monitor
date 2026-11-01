# Interactive installation

Run `node install.mjs` from the complete repository or extracted release package in a normal terminal. It needs only Node.js to start; it checks Node 22.22+, npm and Codex CLI 0.166.0+ before installing. Node 24 and Codex 0.166.0 are the Windows validation baseline. The wizard does not install Node, Codex, Docker or OS services.

The wizard asks for the Codex configuration directory, client (CLI/desktop/both), default display mode, whether to include Stop/Interrupt reports, and whether to start the background launcher. Defaults are CLI, compact output, included reports and launcher startup. Existing installations require an explicit replacement choice and a final review of the plan. Recovery is configured separately per conversation; installation does not authorize or enable retries.

For `develop`, setup installs development dependencies and builds in the checkout. For a deployment package, it uses the included JavaScript. Both paths prepare a new durable deployment source under `CODEX_HOME/plugin-sources/codex-monitor`, install production dependencies, and verify a fresh MCP connection before changing plugin registration. A shared packaging allowlist excludes tests, workflows, TypeScript sources, reports, development dependencies and local state. Use `npm run package` after building to prepare a deployment package yourself.

Replacing an installation uses Codex's supported plugin and marketplace commands for `codex-monitor` only. The wizard refuses replacement when the named marketplace contains other plugins, or saved/live state indicates active monitors, waits, recovery or unresolved pending/unknown deliveries. Idle old services are shut down before replacement so new sessions load the updated runtime. It never cancels workloads automatically. Registering new work concurrently with an upgrade is unsupported: stop using monitor during installation. Plugin-specific policies and hook approvals may need review again after replacement. Old deployment sources and monitor state are preserved. A failed registration prints the retained source paths and requires inspection before retry; it does not claim a transactional rollback or blindly restore the whole Codex configuration.

## Preview or install from an agent session

An AI helping with setup should ask the same configuration questions before selecting answers. Use the user's existing choices and authorization; do not ask for them again. Prefer a short multiple-choice question for client and verbosity, then one for reports and launcher. Do not automatically uninstall this session's plugin or trust unrelated hooks. For a simulated installation, use a separate Codex home and leave the real installation unchanged.

Preview the wizard with `node install.mjs --dry-run`. For automation or an agent without an interactive terminal, create an answers file outside the installed plugin:

```json
{
  "codex_home": "C:/path/to/simulation-codex-home",
  "client": "cli",
  "display": "compact",
  "hooks": true,
  "bootstrap": false,
  "replace": false
}
```

Use an absolute Unix path on Linux/macOS. Set `CODEX_MONITOR_HOME` consistently if you use a custom monitor state directory; otherwise it defaults to `<codex_home>/monitor-node`. The plugin explicitly forwards `CODEX_HOME`, `CODEX_MONITOR_HOME` and its Codex executable overrides into its MCP process; Codex does not forward every environment variable by default.

```text
node install.mjs --config answers.json --dry-run
node install.mjs --config answers.json --yes
```

`--yes` requires an explicit configuration file. It confirms the reviewed installation choices, not Hook trust, recovery, goal changes or workload cancellation. Preview does not install dependencies or change plugin registration/preferences. Codex's diagnostic commands can maintain their own caches. If the selected home does not exist, preflight uses a disposable diagnostic home and leaves the selected path uncreated. A real installation may access the npm registry for locked dependencies. Invalid configuration and failed preflight stop before registration.

The installer saves only the display default in `<monitor-state>/settings.json`. A per-thread `monitor_display` setting takes precedence. Changing display preferences outside the bundle does not invalidate Hook trust. The install receipt is `<codex_home>/plugin-sources/codex-monitor/last-install.json`.

## Make the plugin effective

1. Finish installation before trusting hooks. Do not copy more files into the installed bundle afterward.
2. Fully exit and reopen the CLI or desktop client; resume the intended conversation. A hot reload or a tool list containing new names does not prove that an existing connection is using the new implementation.
3. In `/plugins`, confirm `codex-monitor` is enabled. In `/mcp`, check that `monitor` is connected. Ask Codex to actually call `monitor_display` with the current caller thread ID. This must execute, rather than merely appear in discovery.
4. If reports were included, open `/hooks`, review the exact `codex-monitor` Stop and Interrupt commands, and trust them. Only the official review flow grants trust. If the user has already authorized an assisting agent to review these exact hooks, the agent may complete that UI flow. The installer itself never edits trust databases or bypasses approval. Choosing `hooks: false` packages an empty hook list; reports remain available through MCP.
5. Start the launcher from an external terminal using the exact command printed by setup. Run it again after login/reboot. Startup failures are reported separately from installation success. Use the same `CODEX_HOME` and `CODEX_MONITOR_HOME` in that terminal and Codex.
6. Run a short command-exit demo. Verify the running count, callback, event inspection/acknowledgement, and normal Stop report. Do not leave test observers active.

CLI results are text. The background callback wakes the agent but does not itself appear as an independent arrival card; the awakened agent calls `monitor_event` to show the event result. HTML panels require a supporting graphical host and are not visually validated on desktop. `Stop` runs when the turn actually ends; queued callbacks can keep it active, and manual interruption uses `Interrupt` instead.

If using a simulation home, keep `CODEX_HOME` pointed at that directory when launching Codex, and restore your previous environment afterward. The wizard never copies account credentials to a simulation home; authenticate separately if you want a real model conversation there.

Official references: [plugin commands](https://learn.chatgpt.com/docs/developer-commands), [Hook review](https://learn.chatgpt.com/docs/hooks).
