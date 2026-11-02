import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { ensureService, rpc } from './service.js';
import { VERSION, bounded, stateRoot, threadKey } from './common.js';
import { monitorSchema, recoverySchema, validationSchema, validationOutput, eventReviewSchema, resumeInstructionsSchema } from './contracts.js';
import { validateRequest } from './validation.js';
import { readReport, readStatus, waitReport, reportSchema } from './report.js';
import { toolResult, toolTitles } from './presentation.js';
import { widgetHtml, widgetMeta, widgetUri } from './widget.js';
import { displayModeSchema, displaySettings } from './display.js';
import { CAPACITY_ERROR } from './capacity.js';
const server = new McpServer({ name: 'codex-monitor', version: VERSION }, { instructions: 'Monitor long tests/training and continue independent work. When only external work remains in CLI, poll defaults to blocking: keep the MCP call pending and the native goal unchanged. Background CLI input-history sampling, monitor events and finite timeout release that same call without model polling. Omit timeout_ms for the default one-hour wait; when a valid timeout is supplied, use that value instead. Do not require an explicit default argument. Returned evidence still needs inspection and acknowledgement. Use structured event timing for internal planning: wait_elapsed_ms measures the active poll or monitor registration interval; monitor_elapsed_ms measures registration to observation. Keep these durations out of user summaries unless requested. user_input is only a wake hint; let Codex consume the actual message, never replay history text as instructions. input_unavailable requires explanation, not repeated retries. Require finite live error/expiry guards and training watchdogs; reconcile all unresolved thread events first. Default wake scope is thread-wide ANY monitor. Explicit mode pause retains authorized native goal pause and callback handoff: reuse conditional goal_authorization, verify waiting/paused, then end the turn promptly; early events await native idle. External/manual pauses remain unchanged. Manual resume of the same live paused goal releases the wait without muting its observers. Never silently rearm cancelled/interrupted sources. Compact display is default: inspect callback IDs with event; after handling supply resolution to acknowledge and report together. Evidence already returned by blocking needs no redundant inspection. Trusted Stop/Interrupt hooks provide routine summaries; do not repeat monitor counts or call status solely because a turn ends. Use status for operations, requests or diagnostics. Recovery defaults on once per new operational thread: all_failed, fixed 300s delay, 3h incident limit. Preserve later opt-outs and manual interruption; never repeatedly re-enable it. Explicit policy changes and goal mutations still need applicable authorization.' });
const thread = z.string().uuid().describe('Exact current caller CODEX_THREAD_ID, never the MCP server environment.');
server.registerResource('monitor-panel', widgetUri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri: widgetUri, mimeType: 'text/html;profile=mcp-app', text: widgetHtml,
            _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }],
}));
async function present(threadId, tool, data, isError = false, report) {
    const display = displaySettings(threadId), snapshot = report || await readReport(threadId);
    const view = { ...snapshot, display_mode: display.mode, warnings: [...(snapshot.warnings || []), ...display.warnings] };
    const result = tool === 'status' ? view : { ...data, display_mode: display.mode, report: view };
    return toolResult(tool, result, isError, view, display.mode);
}
async function call(threadId, method, params, signal) {
    const tool = method === 'block_wait' || method === 'wait' ? 'poll' : method === 'cancel_wait' ? 'stop' : method;
    try {
        const timeout = method === 'block_wait' ? (params.timeout_ms ?? 3600000) + 15000 : 60000;
        const result = await rpc(await ensureService(threadId), method, params, timeout, signal);
        return present(threadId, tool, result, ['failed', 'goal_pause_required', 'guard_required', 'goal_unavailable', 'input_unavailable', 'turn_unavailable', 'wait_active'].includes(result.state));
    }
    catch (e) {
        const capacityError = e.code === CAPACITY_ERROR;
        const result = { ok: false, error: { code: capacityError ? CAPACITY_ERROR : 'MONITOR_REQUEST_FAILED', message: bounded(e) },
            ...(capacityError ? { capacity: e.capacity, guidance: e.guidance } : {}),
            ...(e.report ? { validation: e.report } : {}) };
        return present(threadId, tool, result, true);
    }
}
server.registerTool('start', { title: toolTitles.start, description: 'Validate configuration and local prerequisites, then arm a finite command or watchdog. kind is inferred; command match is optional (exit-only). Routine progress stays local with watchdog_only. Commands are owned and stopped on cancel/deadline. Capacity warns at 24/32 occupied slots: reconcile obsolete observers and consolidate only compatible sources before adding more; do not blindly retry a full limit or stop required workloads. Host callback availability is separate; use validate for a read-only host check.',
    inputSchema: monitorSchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'start', params));
server.registerTool('validate', { title: toolTitles.validate, description: 'Preflight a start or recovery configuration without starting workloads, observers, recovery or model turns. Returns normalized defaults, checks, errors and warnings. Checks files, existing PIDs, optional NVIDIA query, and the exact loaded host thread by default. A pass is a snapshot, not guaranteed future readiness.',
    inputSchema: validationSchema.extend({ thread_id: thread }), outputSchema: validationOutput.extend({ display_mode: displayModeSchema, report: reportSchema }), _meta: widgetMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ thread_id, request, check_host }) => {
    const result = await validateRequest(thread_id, path.join(stateRoot(), threadKey(thread_id)), request, check_host ?? true);
    return present(thread_id, 'validate', result, !result.valid);
});
server.registerTool('status', { title: toolTitles.status, description: 'Read existing monitor state without starting a service or recovery. Default compact summary; details: active lists live monitors, full includes bounded configuration/evidence. monitor_id selects one monitor and implies full. Saved data is unverified. UI revision waits are read-only, not agent polling. Trusted hooks already provide routine end-of-turn summaries.',
    inputSchema: { thread_id: thread,
        monitor_id: z.string().uuid().optional().describe('Select one monitor with full evidence; cannot combine with UI revision waits or summary/active details.'),
        details: z.enum(['summary', 'active', 'full']).optional().describe('Default summary (active in verbose mode), or full when monitor_id is supplied. Full evidence stays structured; human text remains concise.'),
        after_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('UI only: wait until the lifecycle revision changes. Agents should omit this.'),
        wait_ms: z.number().int().min(1).max(25000).optional().describe('UI only: bounded event wait, default 25000 ms; requires after_revision.'),
    }, outputSchema: reportSchema, _meta: widgetMeta,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ thread_id, monitor_id, details, after_revision, wait_ms }, extra) => {
    if (wait_ms !== undefined && after_revision === undefined)
        throw Error('wait_ms requires after_revision');
    if (after_revision !== undefined && (monitor_id || details === 'full'))
        throw Error('UI revision waits cannot select a monitor or full evidence');
    const effective = details ?? (monitor_id ? 'full' : displaySettings(thread_id).mode === 'verbose' ? 'active' : 'summary');
    const result = after_revision === undefined ? await readStatus(thread_id, { monitor_id, details: effective })
        : { ...await waitReport(thread_id, after_revision, wait_ms ?? 25000, extra.signal), details: effective };
    return present(thread_id, 'status', result, false, result);
});
server.registerTool('event', { title: toolTitles.event,
    description: 'Inspect selected events with full evidence, timing and registered actions. Omit resolution for read-only inspection. After handling, supply a factual resolution to acknowledge and return final status in this card. Already settled events stay settled. Never stops workloads. This is the single event inspection/acknowledgement interface.',
    inputSchema: eventReviewSchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'event', params));
server.registerTool('display', { title: toolTitles.display,
    description: 'Get or set compact (default) or verbose presentation for this exact thread. Compact uses key operation/event cards; verbose shows diagnostic details. Does not change workload, recovery or hook trust, or hide host-owned Called headers.',
    inputSchema: { thread_id: thread, mode: displayModeSchema.optional() }, _meta: widgetMeta,
}, async ({ thread_id, mode }) => present(thread_id, 'display', displaySettings(thread_id, mode)));
server.registerTool('stop', { title: toolTitles.stop, description: 'With monitor_id, stop that observer; owned commands and descendants are terminated, observed PIDs are preserved. target: wait cancels only waiting and mutes its selected notifications, preserving observers, workload processes and goal. Specify exactly one target; never stop an owned command merely to end waiting.', inputSchema: {
        thread_id: thread, monitor_id: z.string().uuid().optional(),
        target: z.literal('wait').optional().describe('Use only to stop the current wait, without monitor_id. Observer cancellation uses monitor_id instead.'),
    }, _meta: widgetMeta }, ({ thread_id, monitor_id, target }) => {
    if ((monitor_id !== undefined) === (target === 'wait'))
        throw Error('Specify either monitor_id or target: wait, never both or neither');
    return call(thread_id, target === 'wait' ? 'cancel_wait' : 'stop', target === 'wait' ? {} : { monitor_id });
});
server.registerTool('poll', { title: toolTitles.poll, description: 'Wait for monitored external work after useful independent work is done. Default blocking mode keeps the caller tool pending and the native goal unchanged; monitor events, finite timeout or newly submitted CLI input release it without model polling. Requires readable CLI input history and an active caller turn. Event evidence returns through this same call; inspect and acknowledge it, never assume acknowledged. Thread scope wakes on ANY thread monitor. Existing unresolved events return ready; missing error/expiry guards return guard_required. If input history is unavailable do not repeatedly retry. Explicit mode: pause retains authorized native goal pause/callback behavior; requires existing conditional goal_authorization and confirmed goal_control: paused before yielding. Never override an external/manual goal pause.', inputSchema: {
        thread_id: thread, monitor_ids: z.array(z.string().uuid()).optional(),
        mode: z.enum(['blocking', 'pause']).optional().describe('Default blocking for CLI. pause uses the legacy authorized native goal pause and callback handoff.'),
        timeout_ms: z.number().int().min(100).max(86400000).default(3600000).describe('Optional blocking deadline: omit for 3600000 ms (1 hour); a supplied value takes precedence, maximum 24 hours. Reassess once on timeout rather than polling with tool calls.'),
        input_poll_ms: z.number().int().min(50).max(5000).optional().describe('Background CLI input-history sampling interval, default 250 ms; no model turns.'),
        wake_scope: z.enum(['thread', 'selected']).optional().describe('Default thread: any monitor in this exact conversation may wake the goal. selected requires monitor_ids.'),
        resume_instructions: resumeInstructionsSchema, goal_authorization: z.string().optional(),
    }, _meta: widgetMeta }, ({ thread_id, mode = 'blocking', ...params }, extra) => call(thread_id, mode === 'blocking' ? 'block_wait' : 'wait', params, extra.signal));
server.registerTool('recovery', { title: toolTitles.recovery, description: 'Override or disable bounded recovery after verified failed Codex turns. New operational threads enable the installation preset once: all_failed, fixed 300 seconds, 3-hour incident limit, 24-hour lifetime. Explicit enabling/customization needs applicable authorization. Manual interruption, explicit opt-outs, paused goals, host limits and uncertain submissions take precedence; later monitor calls never re-enable stopped policies. enabled: false disables this thread.',
    inputSchema: recoverySchema.extend({ thread_id: thread }), _meta: widgetMeta,
}, ({ thread_id, ...params }) => call(thread_id, 'recovery', params));
await server.connect(new StdioServerTransport());
