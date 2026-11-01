import { compactReport, summarize } from './report.js';
import { eventNames } from './event-text.js';
import { capacityWarning } from './capacity.js';
export const toolTitles = {
    monitor_start: 'Start workload monitor', monitor_stop: 'Stop workload monitor',
    monitor_status: 'Inspect workload monitors', monitor_report: 'Monitor status report',
    monitor_validate: 'Validate monitor configuration', monitor_wait: 'Wait for workload event',
    monitor_cancel_wait: 'Cancel workload wait', monitor_ack: 'Acknowledge monitor events',
    monitor_recovery: 'Configure session recovery',
    monitor_event: 'Workload event', monitor_display: 'Monitor display settings',
};
// Labels and errors are untrusted. Keep terminal controls, bidi overrides and
// Markdown/HTML constructs out of display text; preserve originals in structured data.
function label(value, limit = 160) {
    return String(value ?? 'unknown').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/[<>\\`*{}\[\]|]/g, '').slice(0, limit);
}
function at(value) {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000
        ? new Date(value).toISOString() : 'unknown';
}
function duration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return 'unknown';
    return value % 3600000 === 0 ? `${value / 3600000} h` : `${value / 1000} s`;
}
const liveStates = new Set(['armed', 'starting', 'stopping']);
function state(value) { return value === 'armed' ? 'running' : label(value); }
export function renderSummary(tool, data, isError = false, mode = 'compact', view) {
    const validation = data.validation || (tool === 'monitor_validate' ? data : undefined);
    if (validation) {
        const lines = [`Monitor · validation ${validation.valid ? 'passed' : 'failed'}`];
        for (const error of (validation.errors || []).slice(0, 5))
            lines.push(`  ${label(error.path)}: ${label(error.message, 250)}`);
        for (const warning of (validation.warnings || []).slice(0, 3))
            lines.push(`  Warning: ${label(warning, 250)}`);
        const omitted = Math.max(0, (validation.errors?.length || 0) - 5) + Math.max(0, (validation.warnings?.length || 0) - 3);
        if (omitted)
            lines.push(`  ${omitted} more details in structured status`);
        return lines.join('\n');
    }
    if (isError || data.ok === false)
        return `Monitor · request failed: ${label(data.error?.message || data.error || data.state || 'unknown error', 250)}`;
    if (tool === 'monitor_display')
        return `Monitor · ${label(data.mode)} display${data.warnings?.length ? '\n  ' + data.warnings.map((w) => label(w)).join('\n  ') : ''}`;
    if (tool === 'monitor_event') {
        const lines = [], events = data.events || [];
        for (const e of events.slice(0, mode === 'verbose' ? 8 : 3)) {
            const failure = ['monitor_error', 'monitor_expired', 'watchdog_stalled'].includes(e.event_type) ||
                (e.event_type === 'command_exit' && e.evidence?.returncode !== 0);
            const icon = failure ? '!' : e.event_type === 'command_exit' && e.evidence?.returncode === 0 ? '✓' : '●';
            const exit = ['command_exit', 'process_exit'].includes(e.event_type) ? ` · exit ${label(e.evidence?.returncode ?? 'unknown')}` : '';
            lines.push(`Monitor event · ${label(e.name || e.monitor_id)}`, `  ${icon} ${eventNames[e.event_type] || label(e.event_type)}${exit} · ${e.actionable ? 'needs review' : label(e.state)}`);
            if (mode === 'verbose')
                lines.push(`  Event: ${label(e.id)} · Monitor: ${label(e.monitor_id)}`, `  At ${at(e.occurred_at)} · observer ${state(e.monitor_state)}`);
        }
        if (events.length > 3 && mode !== 'verbose')
            lines.push(`  +${events.length - 3} more events in details`);
        const report = data.report || view;
        if (report)
            lines.push(compactReport(report));
        return lines.join('\n') || 'Monitor · no selected events';
    }
    if (tool === 'monitor_report') {
        const lines = [compactReport(data)];
        if (!data.verified || (data.details ?? (mode === 'verbose' ? 'active' : 'summary')) !== 'active')
            return lines[0];
        const active = (data.monitors || []).filter((m) => liveStates.has(m.state));
        for (const m of active.slice(0, 32))
            lines.push(`  ${label(m.name)} · ${state(m.state)} · ${label(m.kind)}${m.muted ? ' · notifications muted' : ''} · ${label(m.id, 36)}`);
        const omitted = Math.max(0, data.summary.active - Math.min(32, active.length));
        if (omitted)
            lines.push(`  +${omitted} more active monitors`);
        return lines.join('\n');
    }
    if (tool === 'monitor_status') {
        const r = summarize(data, 'live');
        const lines = [compactReport(r)];
        if (mode === 'compact') {
            if (r.summary.unhandled_events)
                lines[0] += ` · ${r.summary.unhandled_events} events to review`;
            return lines.join('\n');
        }
        const active = r.monitors.filter((m) => liveStates.has(m.state));
        for (const m of active.slice(0, 6))
            lines.push(`  ${label(m.name)} · ${state(m.state)} · until ${at(m.deadline)}`);
        if (r.summary.active > 6)
            lines.push(`  +${r.summary.active - 6} more active monitors`);
        for (const event of r.events.slice(0, 3)) {
            const monitor = r.monitors.find((m) => m.id === event.monitor_id);
            lines.push(`  Event · ${label(monitor?.name || event.monitor_id)} · ${label(event.event_type)} · ${label(event.state)}`);
        }
        if (r.summary.unhandled_events > 3)
            lines.push(`  +${r.summary.unhandled_events - 3} more events to review`);
        if (r.wait && ['preparing', 'waiting', 'waking'].includes(r.wait.state))
            lines.push(`  Goal wait · ${label(r.wait.state)} · goal ${label(r.wait.goal_control || 'unverified')}`);
        return lines.join('\n');
    }
    if (tool === 'monitor_recovery') {
        if (!data.enabled)
            return 'Monitor · auto-retry off';
        return `Monitor · auto-retry on · ${label(data.state)}\n  Every ${duration(data.policy?.retry_interval_ms)} · limit ${duration(data.policy?.max_elapsed_ms)} per incident`;
    }
    if (tool === 'monitor_ack') {
        const count = data.event_ids?.length || 0;
        return `Monitor · ${count} ${count === 1 ? 'event' : 'events'} acknowledged${view ? '\n' + compactReport(view) : ''}`;
    }
    if (tool === 'monitor_cancel_wait')
        return 'Monitor · wait cancelled · goal unchanged';
    if (tool === 'monitor_wait' && data.state === 'goal_paused')
        return `Monitor · goal remains paused · ${data.pause_owner === 'external' ? 'manual or external pause' : 'pause ownership unverified'}`;
    if (tool === 'monitor_wait')
        return `Monitor · wait ${state(data.state)}${data.goal_control ? ` · goal ${label(data.goal_control)}` : ''}${data.goal_control === 'unchanged' ? ' (active goals may continue)' : ''}${data.pause_barrier === 'draining' ? ' · finish this turn; wake held until idle' : ''}${data.reason || data.error ? ` · ${label(data.reason || data.error)}` : ''}`;
    const lines = [`Monitor · ${label(data.name || data.id || tool)} · ${state(data.state)}`];
    if (mode === 'verbose' && tool === 'monitor_start' && data.deadline != null)
        lines.push(`  Until ${at(data.deadline)}`);
    return lines.join('\n');
}
export function toolResult(tool, data, isError = false, view, mode = 'compact') {
    let text = renderSummary(tool, data, isError, mode, view);
    const warning = capacityWarning(data.capacity ?? (view?.verified ? view.capacity : null));
    if (warning && data.error?.code !== 'MONITOR_CAPACITY_EXCEEDED' && !text.includes(warning))
        text += `\n  ${warning}`;
    return {
        // CLI renders content literally, including blocks marked assistant-only.
        // Keep one readable block for every tool and retain machine data separately.
        content: [{ type: 'text', text }],
        structuredContent: data, ...(isError ? { isError: true } : {}),
        _meta: { monitorView: { tool, title: toolTitles[tool] || tool, result: data, report: view, isError, display_mode: mode } },
    };
}
