import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { ensureService, rpc } from './service.js';
import { Json, VERSION, bounded, stateRoot, threadKey } from './common.js';
import { monitorSchema, recoverySchema, validationSchema, validationOutput, eventReviewSchema } from './contracts.js';
import { validateRequest } from './validation.js';
import { readReport, waitReport, reportSchema } from './report.js';
import { toolResult, toolTitles } from './presentation.js';
import { widgetHtml, widgetMeta, widgetUri } from './widget.js';
import { displayModeSchema, displaySettings } from './display.js';
const server = new McpServer({ name: 'codex-monitor', version: VERSION }, { instructions:
  'Monitor long tests/training and continue other work. When an active goal has only monitored external work left, call monitor_wait with the user\'s existing conditional pause/resume authorization and verify state: waiting plus goal_control: paused before yielding. Reconcile all unresolved thread events first; require live finite error/expiry fallbacks and training watchdogs. Default wake_scope is thread-wide ANY monitor. With pause_barrier: draining, end this turn promptly: early events stay queued until native idle confirmation. Follow-up messages may refresh a verified plugin-owned wait without cancelling it; retained authorization applies only while ownership is verified. goal_paused means leave the external/unverified pause unchanged, without retrying or forcing resume. Starting monitors, writing a final answer and reporting running counts do not pause goals. Never silently fall back to notification-only waiting for an active goal. Compact display is default: use monitor_event to inspect native callback IDs and show a trigger card; after handling use its resolution to acknowledge and report together. Trusted Stop/Interrupt hooks provide routine end-of-turn status; do not add report calls or repeat monitor counts solely because a turn is ending. Use status/report tools on request or as needed for monitor operations and diagnostics. Avoid redundant status/ack/report calls and stop calls for already stopped observers. monitor_display selects compact or verbose per thread. Never repeat stale events or enable goal control/recovery without applicable user authorization.' });
const thread = z.string().uuid().describe('Exact current caller CODEX_THREAD_ID, never the MCP server environment.');
server.registerResource('monitor-panel', widgetUri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
  contents: [{ uri: widgetUri, mimeType: 'text/html;profile=mcp-app', text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }],
}));
async function present(threadId: string, tool: string, data: Json, isError = false, report?: Json) {
  const display = displaySettings(threadId), snapshot = report || await readReport(threadId);
  const view = { ...snapshot, display_mode: display.mode, warnings: [...(snapshot.warnings || []), ...display.warnings] };
  const result = tool === 'monitor_report' ? view : { ...data, display_mode: display.mode, report: view };
  return toolResult(tool, result, isError, view, display.mode);
}
async function call(threadId: string, method: string, params: Json) {
  try {
    const result = await rpc(await ensureService(threadId), method, params, 60000);
    return present(threadId, `monitor_${method}`, result, ['failed', 'goal_pause_required', 'guard_required', 'goal_unavailable'].includes(result.state));
  } catch (e) {
    const result = { ok: false, error: { code: 'MONITOR_REQUEST_FAILED', message: bounded(e) },
      ...((e as any).report ? { validation: (e as any).report } : {}) };
    return present(threadId, `monitor_${method}`, result, true);
  }
}
server.registerTool('monitor_start', { title: toolTitles.monitor_start, description: 'Validate configuration and local prerequisites, then arm a finite command or watchdog. kind is inferred; command match is optional (exit-only). Routine progress stays local with watchdog_only. Commands are owned and stopped on cancel/deadline. Host callback availability is separate; use monitor_validate for a read-only host check.',
  inputSchema: monitorSchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'start', params));
server.registerTool('monitor_validate', { title: toolTitles.monitor_validate, description: 'Preflight a monitor_start or monitor_recovery configuration without starting workloads, observers, recovery or model turns. Returns normalized defaults, checks, errors and warnings. Checks files, existing PIDs, optional NVIDIA query, and the exact loaded host thread by default. A pass is a snapshot, not guaranteed future readiness.',
  inputSchema: validationSchema.extend({ thread_id: thread }), outputSchema: validationOutput.extend({ display_mode: displayModeSchema, report: reportSchema }), _meta: widgetMeta,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ thread_id, request, check_host }) => {
  const result = await validateRequest(thread_id, path.join(stateRoot(), threadKey(thread_id)), request, check_host ?? true);
  return present(thread_id, 'monitor_validate', result, !result.valid);
});
server.registerTool('monitor_status', { title: toolTitles.monitor_status, description: 'One bounded snapshot of monitors, event delivery, wait and recovery on request or for monitor operations and diagnostics. Pass monitor_id for full evidence. Submitted is not acknowledged.', inputSchema: {
  thread_id: thread, monitor_id: z.string().uuid().optional(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'status', params));
server.registerTool('monitor_report', { title: toolTitles.monitor_report, description: 'Show a one-line running monitor count on request or for diagnostics. Full events, deadlines, wait/recovery policy and stop actions remain in structuredContent. Reads existing state without starting a service or model turn; saved state is explicitly unverified. Trusted Stop/Interrupt hooks provide routine end-of-turn summaries without an agent report call.',
  inputSchema: { thread_id: thread,
    after_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('UI only: wait until the lifecycle revision changes. Agents should omit this.'),
    wait_ms: z.number().int().min(1).max(25000).optional().describe('UI only: bounded event wait, default 25000 ms; requires after_revision.'),
  }, outputSchema: reportSchema, _meta: widgetMeta,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ thread_id, after_revision, wait_ms }, extra) => {
  if (wait_ms !== undefined && after_revision === undefined) throw Error('wait_ms requires after_revision');
  const result = after_revision === undefined ? await readReport(thread_id) : await waitReport(thread_id, after_revision, wait_ms ?? 25000, extra.signal);
  return present(thread_id, 'monitor_report', result, false, result);
});
server.registerTool('monitor_event', { title: toolTitles.monitor_event,
  description: 'Show a native event card with full evidence and registered actions. Omit resolution to inspect without mutation. After handling, supply a factual resolution to acknowledge selected events and return current status in this same card. Already settled events stay settled. Never stops live workloads. In compact mode use instead of separate status/ack/stop/report calls.',
  inputSchema: eventReviewSchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'event', params));
server.registerTool('monitor_display', { title: toolTitles.monitor_display,
  description: 'Get or set compact (default) or verbose presentation for this exact thread. Compact uses key operation/event cards and reuses their status reports. Verbose shows diagnostic detail and permits separate inspection/ack/report calls. Does not hide host-owned Called headers or change workload, recovery, or hook trust.',
  inputSchema: { thread_id: thread, mode: displayModeSchema.optional() }, _meta: widgetMeta,
}, async ({ thread_id, mode }) => present(thread_id, 'monitor_display', displaySettings(thread_id, mode)));
server.registerTool('monitor_stop', { title: toolTitles.monitor_stop, description: 'Stop observation; preserve an observed PID. An owned command is terminated with its descendants. Cancel dependent wait without resuming goal.', inputSchema: {
  thread_id: thread, monitor_id: z.string().uuid(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'stop', params));
server.registerTool('monitor_wait', { title: toolTitles.monitor_wait, description: 'Before yielding to external work, check all unhandled events and live guarded monitors, confirm authorized native goal pause, then end the turn. Pending events return ready; missing finite error/expiry guards return guard_required. Default thread scope wakes on ANY monitor in this conversation, including newly registered monitors. Early events remain queued until the pausing turn ends and the host is idle. Reuse existing user pause/resume authorization; active goals without it return goal_pause_required. Verify state: waiting and goal_control: paused. Use selected scope only when explicitly narrowing the wake policy. Follow-up messages can refresh a plugin-owned paused wait in place, including new resume instructions; its existing authorization is retained. External/unverified pauses return goal_paused unchanged. Never cancel a wait solely to update its instructions.', inputSchema: {
  thread_id: thread, monitor_ids: z.array(z.string().uuid()).optional(),
  wake_scope: z.enum(['thread', 'selected']).optional().describe('Default thread: any monitor in this exact conversation may wake the goal. selected requires monitor_ids.'),
  resume_instructions: z.string(), goal_authorization: z.string().optional(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'wait', params));
server.registerTool('monitor_cancel_wait', { title: toolTitles.monitor_cancel_wait, description: 'Cancel wait, mute selected notifications and leave goal unchanged. Cannot recall in-flight events.', inputSchema: { thread_id: thread }, _meta: widgetMeta }, ({ thread_id }) => call(thread_id, 'cancel_wait', {}));
server.registerTool('monitor_ack', { title: toolTitles.monitor_ack, description: 'Acknowledge specific events after inspecting and reconciling their evidence. State a resolution, including already handled or superseded. Prevent pending stale wakeups; never claim unfinished work completed.', inputSchema: {
  thread_id: thread, event_ids: z.array(z.string().uuid()), resolution: z.string(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'ack', params));
server.registerTool('monitor_recovery', { title: toolTitles.monitor_recovery, description: 'Configure bounded recovery after verified failed Codex turns. Requires explicit user authorization. Defaults: fixed 300 seconds, 3-hour incident limit, 24-hour lifetime. all_failed includes unlisted errors but preserves manual interruption, paused goals, host limits and uncertain submissions. Disable to cancel pending retries.',
  inputSchema: recoverySchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'recovery', params));
await server.connect(new StdioServerTransport());
