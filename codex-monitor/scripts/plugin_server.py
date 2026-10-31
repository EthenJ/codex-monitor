"""Codex Monitor MCP tools. Install the project's [plugin] dependencies first."""
from __future__ import annotations

import json
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from plugin_runtime import ensure_service, rpc

mcp = FastMCP("codex-monitor", instructions=(
    "Register bounded workload observers and continue independent work. Training progress stays local; "
    "wake only on a meaningful event. monitor_wait returns immediately: it is not a blocking tool. "
    "Always obtain the exact current CODEX_THREAD_ID; never infer a thread from a shared MCP process. "
    "Read monitor_status once before ending a turn and report armed monitors, delivery failures, "
    "deadlines, and how to stop them. Native goal pause/resume requires explicit user authorization."))


def call(thread_id, method, **params):
    return rpc(ensure_service(thread_id), method, params, timeout=55 if method == "wait" else 18)


@mcp.tool()
def monitor_start(thread_id: str, name: str, kind: Literal["command", "watchdog"],
                  options: dict[str, Any], instructions: str,
                  notify_on: list[str] | None = None) -> dict[str, Any]:
    """Arm a monitor, return its ID/readiness/deadline, then continue other work.

    thread_id: exact UUID from this conversation's CODEX_THREAD_ID (not the MCP server env).
    name: stable job name; identical live registrations reuse the existing monitor.
    options: helper options with underscores; cwd MUST be absolute. For command use
      command, match, timeout_ms (max 1800000). The command is OWNED and stopped on expiry/cancel.
      For existing training use watchdog: watch_file/watch_directory, stalled_for_ms, pid,
      gpu_util_below, gpu_below_for_ms, gpu_recover_above, warmup_ms, dead_if,
      watchdog_only=true, timeout_ms. It never kills the observed PID.
      File events: watch_directory, recursive, pattern, max_events=1.
    instructions: authorized next action on an event, not an arbitrary shell callback.
    notify_on: event types to wake on; default includes completion, stall, errors and expiry.
      For quiet training use process_exit, watchdog_stalled, monitor_error, monitor_expired.
      Filtering notifications does not stop local health tracking.
    """
    return call(thread_id, "start", name=name, kind=kind, options=options,
                instructions=instructions, notify_on=notify_on)


@mcp.tool()
def monitor_status(thread_id: str, monitor_id: str | None = None) -> dict[str, Any]:
    """One bounded status snapshot of this thread's monitors and wait. Not a wait/poll loop.

    submitted means callback submission, not confirmed execution. unknown is not healthy.
    Defaults to a compact summary of live monitors and recent history. Pass monitor_id
    to retrieve that monitor's complete evidence and callback instructions.
    Include a concise workload-level status in the final answer.
    """
    return call(thread_id, "status", monitor_id=monitor_id, compact=True)


@mcp.tool()
def monitor_stop(thread_id: str, monitor_id: str) -> dict[str, Any]:
    """Stop the named observation. Never kill an observed training PID.

    A command monitor owns its command and stops it. Cancels any dependent wait without
    resuming a paused goal. 'stopping' means cleanup is still in progress.
    """
    return call(thread_id, "stop", monitor_id=monitor_id)


@mcp.tool()
def monitor_wait(thread_id: str, monitor_ids: list[str], resume_instructions: str,
                 goal_authorization: str = "") -> dict[str, Any]:
    """Record a wait and return immediately; use only after independent work is exhausted.

    Wakes once when ANY selected monitor fires. For AND conditions use one combined watchdog.
    Without goal_authorization, only records pending work: it does NOT prevent an active
    native goal from continuing. With it, pause the active goal, deliver a follow-up on an
    event, then resume that same unchanged goal. Quote the user's EXPLICIT instruction
    allowing conditional pause AND resume here; never invent authorization. A previous
    applicable authorization persists. Do not call with authorization merely because
    monitoring was requested. Preserve goal budget; never mark waiting as complete/blocked.
    If the goal/daemon cannot be verified, return failure rather than claim goal waiting.
    After a successful pause, report monitor status and yield. A later user goal edit,
    cancellation, or lost connection must not be overridden.
    """
    return call(thread_id, "wait", monitor_ids=monitor_ids, resume_instructions=resume_instructions,
                goal_authorization=goal_authorization)


@mcp.tool()
def monitor_cancel_wait(thread_id: str) -> dict[str, Any]:
    """Cancel event-driven continuation for a wait; leave its paused goal unchanged.

    Observers remain visible; stop them separately if no longer needed.
    """
    return call(thread_id, "cancel_wait")


if __name__ == "__main__":
    mcp.run(transport="stdio")
