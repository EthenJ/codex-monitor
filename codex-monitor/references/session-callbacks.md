# Session callback mapping

This skill uses the local Codex CLI's queue/resume path by default:

```text
codex queue --thread <thread-id> --message <event-prompt> --resume
```

Capture `CODEX_THREAD_ID` from the registering Codex process when available. A detached monitor must retain this exact ID; when started elsewhere, pass `--codex-thread` explicitly. `--debounce-ms` and `--max-events` reduce duplicate callbacks but do not provide durable exactly-once delivery. There is no retry after an ambiguous timeout: inspect the callback log/target session before resubmitting.

Verified against local Codex CLI 0.166.0: `queue --resume` may exit zero with a warning when wakeup fails. The adapter treats warnings as callback failures and preserves the diagnostic. Queue acceptance is not evidence that Codex finished processing the callback. Check this interface with `codex queue --help` on other installations; a skill cannot add a native event-injection tool by itself.

For an OpenAI Agents API host, the analogous callback is a follow-up `agent.session.input.message` event submitted to the existing `session_id` through `POST /v1/agents/sessions/{session_id}/events`. The API documentation calls this “continue or steer the session”; an idle session starts a new turn and input during an active turn steers it. Use a separate callback service to hold API credentials rather than putting them in a monitor command line. This repository provides the local CLI adapter and a generic callback-command seam, not a complete Agents API service.

Related but different OpenAI features:

- **Session webhooks** report agent lifecycle events such as `agent.session.idle` or `agent.session.failed`. They are inbound notifications to an application, not a local command-output watcher.
- **Scheduled automations** deliver saved instructions to a session at a time or recurring schedule. They are useful for time or GitHub triggers, not arbitrary stdout events.
- **Background mode** runs a response asynchronously but does not turn a local process's stdout into a follow-up message.

Claude Code's corresponding native feature is named **Monitor tool**. Its documentation describes a background command whose output lines are delivered as events to the same conversation, with a bounded deadline and a cancellation path. This skill borrows that event-to-session behavior while using Codex's queue/resume adapter.

Sources:

- https://code.claude.com/docs/en/tools-reference#monitor-tool
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (v2.1.98: Monitor tool for streaming events from background scripts)
- https://developers.openai.com/api/docs/guides/agents-api/sessions
- https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks
- https://developers.openai.com/api/docs/guides/agents-api/sessions/automations
