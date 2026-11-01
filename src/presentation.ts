import { Json } from './common.js';
import { summarize } from './report.js';

export const toolTitles: Record<string, string> = {
  monitor_start: 'Start workload monitor', monitor_stop: 'Stop workload monitor',
  monitor_status: 'Inspect workload monitors', monitor_report: 'Monitor status report',
  monitor_validate: 'Validate monitor configuration', monitor_wait: 'Wait for workload event',
  monitor_cancel_wait: 'Cancel workload wait', monitor_ack: 'Acknowledge monitor events',
  monitor_recovery: 'Configure session recovery',
};
// Workload labels are untrusted text, never Markdown/HTML supplied by the workload.
function cell(value: unknown, limit = 160): string {
  return String(value ?? '—').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .slice(0, limit).replace(/[&<>\\`*_{}\[\]()#+.!|~-]/g, c => `&#${c.charCodeAt(0)};`);
}
function at(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000
    ? new Date(value).toISOString() : '—';
}
function duration(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value / 1000} s` : '—';
}
function rows(entries: Array<[string, unknown]>) {
  return ['| Field | Value |', '| --- | --- |', ...entries.map(([key, value]) => `| ${cell(key)} | ${cell(value)} |`)];
}
function recoveryRows(r: Json): Array<[string, unknown]> {
  return [['Recovery', `${r.enabled ? 'enabled' : 'disabled'} · ${r.state ?? 'unknown'}`],
    ['Attempts', r.attempts ?? 0], ['Retry interval', duration(r.policy?.retry_interval_ms)],
    ['Incident limit', duration(r.policy?.max_elapsed_ms)], ['Next retry (UTC)', at(r.next_retry_at)]];
}
export function renderSummary(tool: string, data: Json, isError = false): string {
  const lines = [`**Codex Monitor · ${cell(toolTitles[tool] || tool)}**`, ''];
  if (isError || data.ok === false) {
    lines.push('**Request failed**', '', ...rows([['Error', data.error?.message || data.error || data.state || 'Validation failed']]));
    if (!data.validation && tool !== 'monitor_validate') return lines.join('\n');
  }
  const validation = data.validation || (tool === 'monitor_validate' ? data : undefined);
  if (validation) {
    lines.push('', `**Validation: ${validation.valid ? 'passed' : 'failed'}**`, '', '| Check | Status |', '| --- | --- |');
    for (const check of (validation.checks || []).slice(0, 10)) lines.push(`| ${cell(check.name)} | ${cell(check.status)} |`);
    for (const error of (validation.errors || []).slice(0, 5)) lines.push(`- ${cell(error.path)}: ${cell(error.message)}`);
    for (const warning of (validation.warnings || []).slice(0, 5)) lines.push(`- ${cell(warning, 350)}`);
    lines.push('', 'Snapshot only; validation starts no workload or recovery.');
  } else if (tool === 'monitor_report' || tool === 'monitor_status') {
    const r = tool === 'monitor_report' ? data : summarize(data, 'live');
    lines.push(r.verified ? `Status source: ${cell(r.source)}` : '**Unverified saved state — live supervision is not confirmed.**', '',
      ...rows([['Active monitors', r.summary.active], ['Stopped', r.summary.stopped],
        ['Failed / unknown', r.summary.failed_or_unknown], ['Unhandled events', r.summary.unhandled_events],
        ['Wait', r.wait?.state || 'none'], ...recoveryRows(r.recovery)]));
    if (r.monitors?.length) {
      lines.push('', '| Monitor | State | Deadline (UTC) |', '| --- | --- | --- |');
      for (const m of r.monitors.slice(0, 6)) lines.push(`| ${cell(m.name)} | ${cell(m.state)} | ${at(m.deadline)} |`);
      const omitted = Math.max(0, r.monitors.length - 6) + (r.omitted?.monitors || 0);
      if (omitted) lines.push('', `${omitted} more monitor records in structured status/history.`);
    }
    lines.push('', `Checked: ${at(r.checked_at)} · Thread: ${cell(r.thread_id)}`);
  } else if (tool === 'monitor_recovery') {
    lines.push(...rows(recoveryRows(data)));
  } else {
    const entries: Array<[string, unknown]> = [['State', data.state ?? (isError ? 'failed' : 'unknown')]];
    if (data.name) entries.push(['Monitor', data.name]);
    if (data.id) entries.push(['Monitor ID', data.id]);
    if (data.deadline != null) entries.push(['Deadline (UTC)', at(data.deadline)]);
    if (data.monitor_ids) entries.push(['Selected monitors', data.monitor_ids.length]);
    if (data.event_ids) entries.push(['Acknowledged events', data.event_ids.length]);
    if (data.reason) entries.push(['Reason', data.reason]);
    if (data.goal) entries.push(['Goal', typeof data.goal === 'string' ? data.goal : 'See structured result']);
    if (data.notifications) entries.push(['Notifications', data.notifications]);
    lines.push(...rows(entries));
  }
  return lines.join('\n');
}
export function toolResult(tool: string, data: Json, isError = false, view?: Json) {
  return { content: [
    { type: 'text' as const, text: renderSummary(tool, data, isError), annotations: { audience: ['user' as const] } },
    // Keep the JSON fallback for clients that do not consume structuredContent.
    { type: 'text' as const, text: JSON.stringify(data), annotations: { audience: ['assistant' as const] } },
  ], structuredContent: data, ...(isError ? { isError: true } : {}),
    _meta: { monitorView: { tool, title: toolTitles[tool] || tool, result: data, report: view, isError } } };
}
