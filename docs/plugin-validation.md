# Historical Python v0.2 plugin validation (Windows)

This report describes the superseded Python plugin. For the current Node plugin, see [Node validation](node-validation.md).

Validation date: 2026-11-01. Development work is on `develop`; `main` and the published v0.1 release remain unchanged.

## Implemented behavior

- Installable Codex compatibility plugin and local marketplace entry.
- Five structured MCP tools: registration, compact status/full monitor evidence, stop, nonblocking wait and cancel-wait.
- Per-thread detached observers with bounded persistent state, registration reuse, explicit readiness and finite deadlines.
- Quiet training progress and bounded coalescing of actual events.
- User-authorized pause/resume of the existing native goal. Original `/goal` inspection, editing and native status/progress display remain in use. Native status is `paused` during a plugin wait and returns to `active` after delivery; no custom footer field is claimed.
- Independent local launcher for Windows MCP hosts that terminate child process jobs on disconnect. No scheduled task, OS service installation, or Codex source build.

## Checks performed

- Windows, Python 3.14.8, Codex CLI/daemon 0.166.0, MCP SDK 1.30.0 and wsproto 1.3.2.
- Installed a deployment-only package with the real `codex plugin marketplace add` and `codex plugin add` commands in an isolated Codex home. The plugin installed as version 0.2.0, and `skills/list` discovered its enabled skill in the installed cache.
- Official MCP SDK client initialized the actual stdio server, listed all five tools, registered an armed native file observer, closed the connection/process, opened a second client, found the same armed observer, then stopped it and confirmed cancellation.
- A separate caller process exited after registration; the observer was still armed when inspected in a later tool invocation.
- Connected through the existing local daemon's WebSocket proxy and read the current thread's goal state. Lifecycle control requires that the target thread be loaded in that same daemon, avoiding silent updates to another host's stored session.
- In an isolated local App Server fixture with a non-network model endpoint, created a test goal, paused it, resumed it and cleared it. The target text and token budget were preserved, with zero model tokens consumed. This checks native lifecycle RPC behavior; it does not constitute an end-to-end idle model-generation test.
- Behavioral tests exercise quiet progress, stall/expiry events, callbacks, registration reuse, cancellation during delivery and after history pruning, post-turn usage accounting, user goal changes, budget exhaustion, service restart, snapshot/evidence retrieval, and responsive status during a slow callback. App Server request/response ID collisions cannot be mistaken for lifecycle responses; unhandled approval requests are denied. Repeated launcher initialization reuses the original process.

The full regression suite is also run from a monitored background job. The Windows real-console Ctrl+C fixture explicitly clears an inherited ignore-Ctrl+C attribute before spawning its subjects, so it exercises cancellation correctly even when launched by a hidden monitor service.

Final local full-suite result: **141 tests discovered, 123 passed, 18 expected skips** in 32.523 seconds, with `ResourceWarning` treated as an error. All four Windows-specific tests ran, including real console cancellation. All 26 plugin/MCP tests passed within that run. A finite command monitor observed the full suite and submitted its completion event to the original task thread.

## Limits

- Native goal waiting remains experimental. The host's lifecycle API has no atomic compare-and-set; an external user edit racing between the final verification and a status write cannot be ruled out.
- Authorization text records an actual user instruction; a nonempty string cannot prove consent. The skill/tool contract forbids inventing authorization.
- Callback submission to the real task thread was verified. Automatic model execution after idle delivery and immediate steering/preemption are not claimed. State distinguishes accepted submission from confirmed execution.
- Service crash, ambiguous delivery or an uncertain lifecycle mutation requires inspection. There is no blind retry, durable outbox or exactly-once guarantee.
- The user-started launcher must be initialized again after login/reboot. It does not automatically start with Windows.
- No live Windows NVIDIA GPU was available. New plugin behavior on Ubuntu/macOS has not been locally validated; earlier standalone Ubuntu/GPU validation remains documented separately.
