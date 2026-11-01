# Codex Monitor

A Node.js plugin that watches external work and wakes the same Codex conversation
when an event needs attention. The agent can continue independent work or wait
for a callback instead of repeatedly checking logs.

Supports command completion and output matching, file/directory changes, process
exit, training inactivity and NVIDIA GPU utilization. It also provides authorized
goal pause/resume and optional recovery after conversation errors. No Codex source
build, Python runtime or separate model API key is required.

## How it works

1. Codex registers a finite observer through the plugin's typed MCP tools.
   Configuration and local prerequisites are validated before observation starts.
2. A background Node.js service watches the workload. Healthy progress and local
   sensor sampling do not invoke the model.
3. Relevant events are saved and delivered through the existing local Codex
   daemon as native tool outputs to the original conversation.
4. The agent inspects the evidence, performs the registered action and
   acknowledges the event. Trusted Stop/Interrupt hooks report a concise running
   count when the turn ends, without a separate agent reporting call.

When only monitored work remains, `monitor_wait` can pause the native goal with
the user's pause/resume authorization. It checks unresolved events and live
fallback guards, confirms the pause, and holds early events until the current
turn has ended. A subsequent eligible event resumes the same goal. Manual pauses,
interruptions and later goal changes take precedence; the plugin retains the
native goal interface and budget.

Stopping a command monitor terminates its owned command tree. A watchdog observes
an existing workload and never terminates its PID. Native callbacks require the
same loaded local Codex daemon. CLI output is text; graphical panels depend on
client support.

## Installation

Requires Node.js **22.22+** (24 recommended), npm, Codex CLI **0.166.0+** and a
compatible local Codex daemon. Tested on Windows and Ubuntu with Codex 0.166.0.
GPU monitoring additionally requires working `nvidia-smi`.

Download and extract a complete package from [Releases](https://github.com/EthenJ/codex-monitor/releases),
or clone the repository. Run from its directory in a normal terminal:

```sh
node install.mjs
```

The wizard asks for the Codex configuration directory, client, compact/verbose
output, automatic hook reports and background launcher startup. It shows the
plan before installing. Use `node install.mjs --dry-run` to preview it.

After installation:

1. Fully exit and reopen Codex. Check the plugin in `/plugins` and its connection
   in `/mcp`; ask Codex to call `monitor_display` to verify execution.
2. If automatic reports were included, review and trust this plugin's Stop and
   Interrupt hooks in `/hooks`. An upgrade may require reviewing them again.
3. If the launcher was not started, run the command printed by setup from an
   external terminal. Start it again after login/reboot; no OS service is installed.

Before upgrading, reconcile active monitors, waits, recovery and unresolved
events. The installer refuses to replace a busy installation. See the
[installation guide](codex-monitor/references/installation.md) for upgrades,
custom directories and noninteractive setup.

## Configuration

Describe the workload and desired action to Codex, for example:

> Monitor this training process and its metrics file for 24 hours. Alert if
> progress stops for five minutes and GPU utilization stays below 10% for two
> minutes. Continue other work; when only training remains, pause the goal and
> resume it on an event. Do not enable conversation retries.

Configuration uses MCP tools with validated types and ranges. The agent supplies
the exact current `thread_id`; `options.cwd` must be an absolute workload directory.

| Setting | Tool / field | Default |
| --- | --- | --- |
| Display | `monitor_display`: `mode` | `compact`; use `verbose` for diagnostics |
| Observer lifetime | `monitor_start`: `options.timeout_ms` | 30 minutes; watchdog maximum 7 days, owned command maximum 30 minutes |
| File progress | `options.watch_file` or `options.watch_directory`, `options.stalled_for_ms` | Inactivity rule requires an explicit duration |
| GPU health | `options.gpu_util_below`, `options.gpu_below_for_ms`, `options.gpu_id` | Off until a threshold is set; default dwell 2 minutes, GPU `0` |
| Retry interval | `monitor_recovery`: `retry_interval_ms` | Fixed 300,000 ms (5 minutes) |
| Retry incident limit | `monitor_recovery`: `max_elapsed_ms` | 10,800,000 ms (3 hours) |
| Recovery lifetime | `monitor_recovery`: `lifetime_ms` | 86,400,000 ms (24 hours) |

For training, use `options.watchdog_only: true` to keep healthy progress quiet, with
`process_exit`, `watchdog_stalled`, `monitor_error` and `monitor_expired` notifications.
Choose `options.dead_if: "all"` to require both configured file and GPU stall conditions,
or `"any"` to alert on either. Set a lifetime that covers the expected run.

Recovery is **off until explicitly authorized**. It waits for Codex's own retries
to finish, then retries verified failed turns within the configured limits.
`retry_mode: "transient"` covers recognized connection/server failures;
`"all_failed"` additionally covers unlisted failures. Manual interruption,
paused goals and host budget/usage limits prevent recovery. Disable it with
`monitor_recovery` using `enabled: false`.

Use `monitor_validate` to preview configuration, `monitor_status` to inspect a
specific observer, and `monitor_report` when a status summary is wanted. Routine
end-of-turn summaries come from trusted hooks. State is stored in
`<CODEX_HOME>/monitor-node` (normally `~/.codex/monitor-node`), or
`CODEX_MONITOR_HOME` when set. Use consistent directories for Codex and the launcher.

See the [tool and configuration reference](codex-monitor/references/plugin.md)
for complete examples, GPU rules, goal waiting and recovery policies.

## License

[MIT](LICENSE).
