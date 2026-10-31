import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureService, rpc } from './service.js';
import { Json, VERSION } from './common.js';
const server = new McpServer({ name: 'codex-monitor', version: VERSION }, { instructions:
  'Register finite workload observers and continue independent work. Events arrive as native monitor_event tool outputs. Inspect status and acknowledge handled event IDs; stale or acknowledged events must not repeat work. Monitor long tests and training. Check status once before final responses. Goal pause/resume and session retry require applicable user authorization.' });
const thread = z.string().uuid().describe('Exact current caller CODEX_THREAD_ID, never the MCP server environment.');
async function call(threadId: string, method: string, params: Json) {
  const result = await rpc(await ensureService(threadId), method, params, 60000);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
}
server.registerTool('monitor_start', { description: 'Arm a finite command or watchdog and return readiness. Watchdog observes existing training without killing it. Routine progress stays local with watchdog_only. Commands are owned and stopped on cancel/deadline.', inputSchema: {
  thread_id: thread, name: z.string(), kind: z.enum(['command', 'watchdog']), options: z.record(z.string(), z.unknown()).describe('Absolute cwd; command/match or watch_file/watch_directory/pid/GPU and health options. Explicit timeout_ms.'),
  instructions: z.string(), notify_on: z.array(z.string()).optional(), event_ttl_ms: z.number().int().optional(),
} }, ({ thread_id, ...params }) => call(thread_id, 'start', params));
server.registerTool('monitor_status', { description: 'One bounded snapshot of monitors, event delivery, wait and recovery. Pass monitor_id for full evidence. Submitted is not acknowledged. Report status before ending a turn.', inputSchema: {
  thread_id: thread, monitor_id: z.string().uuid().optional(),
} }, ({ thread_id, ...params }) => call(thread_id, 'status', params));
server.registerTool('monitor_stop', { description: 'Stop observation; preserve an observed PID. An owned command is terminated with its descendants. Cancel dependent wait without resuming goal.', inputSchema: {
  thread_id: thread, monitor_id: z.string().uuid(),
} }, ({ thread_id, ...params }) => call(thread_id, 'stop', params));
server.registerTool('monitor_wait', { description: 'Record waiting for ANY selected monitor and return immediately. Quote actual user authorization for conditional goal pause AND resume; do not invent it. Only pause after independent work is exhausted. Without authorization an active goal keeps continuing.', inputSchema: {
  thread_id: thread, monitor_ids: z.array(z.string().uuid()), resume_instructions: z.string(), goal_authorization: z.string().optional(),
} }, ({ thread_id, ...params }) => call(thread_id, 'wait', params));
server.registerTool('monitor_cancel_wait', { description: 'Cancel wait, mute selected notifications and leave goal unchanged. Cannot recall in-flight events.', inputSchema: { thread_id: thread } }, ({ thread_id }) => call(thread_id, 'cancel_wait', {}));
server.registerTool('monitor_ack', { description: 'Acknowledge specific events after inspecting and reconciling their evidence. State a resolution, including already handled or superseded. Prevent pending stale wakeups; never claim unfinished work completed.', inputSchema: {
  thread_id: thread, event_ids: z.array(z.string().uuid()), resolution: z.string(),
} }, ({ thread_id, ...params }) => call(thread_id, 'ack', params));
server.registerTool('monitor_recovery', { description: 'Configure bounded automatic recovery after verified transient Codex turn failures. Requires explicit user authorization. Interrupted turns, paused goals, budgets, permanent errors and uncertain submissions never auto-retry. Timers inspect host state locally, not by invoking the model. Disabling cancels pending retries.', inputSchema: {
  thread_id: thread, enabled: z.boolean(), authorization: z.string().optional(), max_attempts: z.number().int().optional(),
  base_delay_ms: z.number().int().optional(), max_delay_ms: z.number().int().optional(), max_elapsed_ms: z.number().int().optional(),
  lifetime_ms: z.number().int().optional(), check_interval_ms: z.number().int().optional(), retry_rate_limits: z.boolean().optional(),
} }, ({ thread_id, ...params }) => call(thread_id, 'recovery', params));
await server.connect(new StdioServerTransport());
