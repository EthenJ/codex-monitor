import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Json, now, stateRoot, threadKey, VERSION } from './common.js';
import { rpc } from './service.js';
import { capacitySchema, monitorCapacity, capacityWarning } from './capacity.js';

export const reportSchema = z.object({
  type: z.literal('monitor_report'), version: z.string(), thread_id: z.string(), checked_at: z.number(),
  display_mode: z.enum(['compact', 'verbose']).optional(),
  source: z.enum(['live', 'saved', 'empty', 'unavailable']), verified: z.boolean(),
  revision: z.number(), changes: z.array(z.record(z.string(), z.unknown())), changes_omitted: z.number(),
  live_updates: z.boolean(),
  capacity: capacitySchema.nullable(),
  details: z.enum(['summary', 'active', 'full']).optional(),
  monitor_id: z.string().uuid().optional(),
  summary: z.object({ active: z.number(), running: z.number(), starting: z.number(), stopping: z.number(),
    stopped: z.number(), failed_or_unknown: z.number(), unhandled_events: z.number() }),
  monitors: z.array(z.record(z.string(), z.unknown())), events: z.array(z.record(z.string(), z.unknown())),
  omitted: z.object({ monitors: z.number(), events: z.number() }),
  wait: z.record(z.string(), z.unknown()).nullable(), recovery: z.record(z.string(), z.unknown()),
  goal_pause: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string()),
});
const active = new Set(['armed', 'starting', 'stopping']);
const handled = new Set(['acknowledged', 'superseded', 'suppressed', 'expired']);
export function summarize(snapshot: Json, source: 'live' | 'saved' | 'empty' | 'unavailable'): Json {
  const records: Json[] = Array.isArray(snapshot.monitors) ? snapshot.monitors : Object.values(snapshot.monitors || {});
  const events: Json[] = Array.isArray(snapshot.events) ? snapshot.events : Object.values(snapshot.events || {});
  const pending = events.filter(x => !handled.has(x.state));
  const selected = [...records].sort((a, b) => Number(active.has(b.state)) - Number(active.has(a.state)) || (b.latest_event?.occurred_at || 0) - (a.latest_event?.occurred_at || 0)).slice(0, 32);
  const r = snapshot.recovery || { enabled: false, state: 'disabled' };
  const verified = source === 'live' || source === 'empty';
  return { type: 'monitor_report', version: snapshot.version || VERSION, thread_id: snapshot.thread_id,
    checked_at: now(), source, verified, revision: snapshot.revision || 0, changes: (snapshot.changes || []).slice(-128),
    live_updates: source === 'live' && Number.isSafeInteger(snapshot.revision),
    // A filtered snapshot still contains the manager's thread-wide slot count.
    // Legacy services have no verified reservation count; never infer it from history.
    capacity: source === 'empty' ? monitorCapacity(0) : source === 'live' && capacitySchema.safeParse(snapshot.capacity).success ? snapshot.capacity : null,
    changes_omitted: Math.max(0, (snapshot.revision || 0) - (snapshot.changes || []).length),
    summary: { active: records.filter(x => active.has(x.state)).length,
      running: records.filter(x => x.state === 'armed').length,
      starting: records.filter(x => x.state === 'starting').length,
      stopping: records.filter(x => x.state === 'stopping').length,
      stopped: records.filter(x => x.state === 'stopped').length,
      failed_or_unknown: records.filter(x => ['failed', 'unknown'].includes(x.state)).length, unhandled_events: pending.length },
    monitors: selected.map(x => ({ id: x.id, name: String(x.name || '').slice(0, 100), kind: x.kind, state: x.state, deadline: x.deadline,
      muted: Boolean(x.muted),
      latest_event: x.latest_event, outcome: x.outcome?.reason,
      ...(active.has(x.state) ? { stop: { tool: 'stop', monitor_id: x.id } } : {}) })),
    events: pending.slice(-8).map(x => ({ id: x.id, monitor_id: x.monitor_id, event_type: x.event_type, state: x.state, occurred_at: x.occurred_at, timing: x.timing, deferred_reason: x.deferred_reason })),
    omitted: { monitors: records.length - selected.length, events: Math.max(0, pending.length - 8) },
    wait: snapshot.wait ? { state: snapshot.wait.state, mode: snapshot.wait.mode, deadline: snapshot.wait.deadline,
      started_at: snapshot.wait.started_at, released_at: snapshot.wait.released_at, elapsed_ms: snapshot.wait.elapsed_ms,
      monitor_ids: snapshot.wait.monitor_ids, goal_control: snapshot.wait.goal_control,
      pause_owner: snapshot.wait.pause_owner ?? snapshot.goal_pause?.owner,
      wake_scope: snapshot.wait.wake_scope, guard_ids: snapshot.wait.guard_ids,
      pause_barrier: snapshot.wait.pause_barrier, pause_checked_at: snapshot.wait.pause_checked_at,
      reason: snapshot.wait.reason, error: snapshot.wait.error } : null,
    goal_pause: snapshot.goal_pause ? { owner: snapshot.goal_pause.owner, checked_at: snapshot.goal_pause.checked_at } : undefined,
    recovery: { enabled: r.enabled, state: r.state, attempts: r.attempts ?? 0, policy: r.policy,
      next_retry_at: r.next_retry_at ?? null, deadline: r.deadline,
      ...(r.enabled ? { stop: { tool: 'recovery', enabled: false } } : {}) },
    warnings: verified ? [...(r.state === 'default_unavailable' ? [`Default automatic recovery unavailable: ${r.reason}`] : []),
      ...(snapshot.callback_hold ? [`Monitor callbacks held: ${snapshot.callback_hold}`] : [])]
      : ['Service unavailable. Saved states are historical and do not establish that observers or recovery are currently running.'] };
}
// Human-facing end-of-turn output. Detailed history stays in structured status.
export function compactReport(report: Json): string {
  if (!report.verified) return 'Monitor · live status unavailable';
  const { running, starting, stopping } = report.summary;
  const parts = [running ? `${running} running` : 'none running'];
  if (starting) parts.push(`${starting} starting`);
  if (stopping) parts.push(`${stopping} stopping`);
  if (report.recovery?.enabled) parts.push('auto-retry on');
  if (report.wait?.state === 'waiting' && report.wait.goal_control === 'paused') parts.push(report.wait.pause_barrier === 'ready' ? 'goal waiting for event' : 'goal paused; finishing current turn');
  if (report.wait?.state === 'waiting' && report.wait.mode === 'blocking') parts.push('waiting for event or CLI input');
  const pressure = capacityWarning(report.capacity);
  if (pressure) parts.push(pressure);
  return `Monitor · ${parts.join(' · ')}`;
}
export async function waitReport(threadId: string, after: number, waitMs: number, signal?: AbortSignal, root = stateRoot()) {
  try { return summarize(await rpc(path.join(root, threadKey(threadId)), 'report_wait', { after_revision: after, wait_ms: waitMs }, waitMs + 2000, signal), 'live'); }
  catch (e) {
    if (signal?.aborted) throw e;
    const report = await readReport(threadId, root);
    return { ...report, live_updates: false, warnings: [...report.warnings, 'Live updates unavailable; reconnect explicitly to try again.'] };
  }
}
export async function readReport(threadId: string, root = stateRoot(), timeout = 1200) {
  const { snapshot, source } = await readSnapshot(threadId, root, timeout);
  return summarize(snapshot, source);
}
async function readSnapshot(threadId: string, root: string, timeout: number, full = false): Promise<{
  snapshot: Json; source: 'live' | 'saved' | 'empty' | 'unavailable';
}> {
  const directory = path.join(root, threadKey(threadId));
  try { return { snapshot: await rpc(directory, 'status', full ? { details: 'full' } : {}, timeout), source: 'live' }; }
  catch {
    try {
      const snapshot = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
      if (snapshot.thread_id !== threadId.toLowerCase()) throw Error('Saved thread mismatch');
      return { snapshot, source: 'saved' };
    } catch (e: any) {
      const missing = e.code === 'ENOENT' && !existsSync(path.join(directory, 'endpoint.json'));
      return { snapshot: { thread_id: threadId, recovery: { enabled: false, state: missing ? 'disabled' : 'unknown' } }, source: missing ? 'empty' : 'unavailable' };
    }
  }
}
// Read diagnostics without starting a service, observer, connection or recovery.
export async function readStatus(threadId: string, options: { monitor_id?: string; details?: 'summary' | 'active' | 'full' } = {}, root = stateRoot()) {
  const details = options.details ?? (options.monitor_id ? 'full' : 'summary');
  if (options.monitor_id && details !== 'full') throw Error('monitor_id requires details: full');
  const { snapshot, source } = await readSnapshot(threadId, root, 1200, details === 'full');
  const report = summarize(snapshot, source);
  if (details !== 'full') return { ...report, details };
  const records: Json[] = Array.isArray(snapshot.monitors) ? snapshot.monitors : Object.values(snapshot.monitors || {});
  const events: Json[] = Array.isArray(snapshot.events) ? snapshot.events : Object.values(snapshot.events || {});
  const selected = options.monitor_id ? records.filter(m => m.id === options.monitor_id)
    : report.monitors.map((m: Json) => records.find(r => r.id === m.id)).filter(Boolean);
  if (options.monitor_id && !selected.length) throw Error('Unknown monitor ID');
  const selectedEvents = options.monitor_id ? events.filter(e => e.monitor_id === options.monitor_id)
    : report.events.map((e: Json) => events.find(r => r.id === e.id)).filter(Boolean);
  return { ...report, details, ...(options.monitor_id ? { monitor_id: options.monitor_id } : {}),
    monitors: selected, events: selectedEvents.slice(-8),
    omitted: { monitors: options.monitor_id ? 0 : report.omitted.monitors,
      events: options.monitor_id ? Math.max(0, selectedEvents.length - 8) : report.omitted.events } };
}
