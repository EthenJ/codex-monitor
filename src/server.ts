import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { ensureService, rpc } from './service.js';
import { Json, VERSION, bounded, stateRoot, threadKey } from './common.js';
import { monitorSchema, recoverySchema, validationSchema, validationOutput } from './contracts.js';
import { validateRequest } from './validation.js';
import { readReport, waitReport, reportSchema } from './report.js';
import { toolResult, toolTitles } from './presentation.js';
import { widgetHtml, widgetMeta, widgetUri } from './widget.js';
const server = new McpServer({ name: 'codex-monitor', version: VERSION }, { instructions:
  'Register finite workload observers and continue independent work. Events arrive as native monitor_event tool outputs. Inspect status and acknowledge handled event IDs; stale or acknowledged events must not repeat work. Monitor long tests and training. Call monitor_report once before final responses or yielding; never wake a model solely for reporting. Use monitor_validate for uncertain configuration. Goal pause/resume and session retry require applicable user authorization.' });
const thread = z.string().uuid().describe('Exact current caller CODEX_THREAD_ID, never the MCP server environment.');
server.registerResource('monitor-panel', widgetUri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
  contents: [{ uri: widgetUri, mimeType: 'text/html;profile=mcp-app', text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }],
}));
async function call(threadId: string, method: string, params: Json) {
  try {
    const result = await rpc(await ensureService(threadId), method, params, 60000);
    return toolResult(`monitor_${method}`, result, result.state === 'failed', await readReport(threadId));
  } catch (e) {
    const result = { ok: false, error: { code: 'MONITOR_REQUEST_FAILED', message: bounded(e) },
      ...((e as any).report ? { validation: (e as any).report } : {}) };
    return toolResult(`monitor_${method}`, result, true, await readReport(threadId));
  }
}
server.registerTool('monitor_start', { title: toolTitles.monitor_start, description: 'Validate configuration and local prerequisites, then arm a finite command or watchdog. kind is inferred; command match is optional (exit-only). Routine progress stays local with watchdog_only. Commands are owned and stopped on cancel/deadline. Host callback availability is separate; use monitor_validate for a read-only host check.',
  inputSchema: monitorSchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'start', params));
server.registerTool('monitor_validate', { title: toolTitles.monitor_validate, description: 'Preflight a monitor_start or monitor_recovery configuration without starting workloads, observers, recovery or model turns. Returns normalized defaults, checks, errors and warnings. Checks files, existing PIDs, optional NVIDIA query, and the exact loaded host thread by default. A pass is a snapshot, not guaranteed future readiness.',
  inputSchema: validationSchema.extend({ thread_id: thread }), outputSchema: validationOutput, _meta: widgetMeta,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ thread_id, request, check_host }) => {
  const result = await validateRequest(thread_id, path.join(stateRoot(), threadKey(thread_id)), request, check_host ?? true);
  return toolResult('monitor_validate', result, !result.valid, await readReport(thread_id));
});
server.registerTool('monitor_status', { title: toolTitles.monitor_status, description: 'One bounded snapshot of monitors, event delivery, wait and recovery. Pass monitor_id for full evidence. Submitted is not acknowledged. Report status before ending a turn.', inputSchema: {
  thread_id: thread, monitor_id: z.string().uuid().optional(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'status', params));
server.registerTool('monitor_report', { title: toolTitles.monitor_report, description: 'Display a compact structured monitor status report before yielding or on request. Includes events, deadlines, wait/recovery policy and stop actions. Reads existing state without starting a service or model turn; saved state is explicitly unverified. Stop/Interrupt hooks use the same report after the turn.',
  inputSchema: { thread_id: thread,
    after_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('UI only: wait until the lifecycle revision changes. Agents should omit this.'),
    wait_ms: z.number().int().min(1).max(25000).optional().describe('UI only: bounded event wait, default 25000 ms; requires after_revision.'),
  }, outputSchema: reportSchema, _meta: widgetMeta,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ thread_id, after_revision, wait_ms }, extra) => {
  if (wait_ms !== undefined && after_revision === undefined) throw Error('wait_ms requires after_revision');
  const result = after_revision === undefined ? await readReport(thread_id) : await waitReport(thread_id, after_revision, wait_ms ?? 25000, extra.signal);
  return toolResult('monitor_report', result, false, result);
});
server.registerTool('monitor_stop', { title: toolTitles.monitor_stop, description: 'Stop observation; preserve an observed PID. An owned command is terminated with its descendants. Cancel dependent wait without resuming goal.', inputSchema: {
  thread_id: thread, monitor_id: z.string().uuid(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'stop', params));
server.registerTool('monitor_wait', { title: toolTitles.monitor_wait, description: 'Record waiting for ANY selected monitor and return immediately. Quote actual user authorization for conditional goal pause AND resume; do not invent it. Only pause after independent work is exhausted. Without authorization an active goal keeps continuing.', inputSchema: {
  thread_id: thread, monitor_ids: z.array(z.string().uuid()), resume_instructions: z.string(), goal_authorization: z.string().optional(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'wait', params));
server.registerTool('monitor_cancel_wait', { title: toolTitles.monitor_cancel_wait, description: 'Cancel wait, mute selected notifications and leave goal unchanged. Cannot recall in-flight events.', inputSchema: { thread_id: thread }, _meta: widgetMeta }, ({ thread_id }) => call(thread_id, 'cancel_wait', {}));
server.registerTool('monitor_ack', { title: toolTitles.monitor_ack, description: 'Acknowledge specific events after inspecting and reconciling their evidence. State a resolution, including already handled or superseded. Prevent pending stale wakeups; never claim unfinished work completed.', inputSchema: {
  thread_id: thread, event_ids: z.array(z.string().uuid()), resolution: z.string(),
}, _meta: widgetMeta }, ({ thread_id, ...params }) => call(thread_id, 'ack', params));
server.registerTool('monitor_recovery', { title: toolTitles.monitor_recovery, description: 'Configure bounded recovery after verified failed Codex turns. Requires explicit user authorization. Defaults: fixed 300 seconds, 3-hour incident limit, 24-hour lifetime. all_failed includes unlisted errors but preserves manual interruption, paused goals, host limits and uncertain submissions. Disable to cancel pending retries.',
  inputSchema: recoverySchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'recovery', params));
await server.connect(new StdioServerTransport());
