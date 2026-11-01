import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Json, now, stateRoot, threadKey, VERSION } from './common.js';
import { rpc } from './service.js';

export const reportSchema = z.object({
  type: z.literal('monitor_report'), version: z.string(), thread_id: z.string(), checked_at: z.number(),
  display_mode: z.enum(['compact', 'verbose']).optional(),
  source: z.enum(['live', 'saved', 'empty', 'unavailable']), verified: z.boolean(),
  revision: z.number(), changes: z.array(z.record(z.string(), z.unknown())), changes_omitted: z.number(),
  live_updates: z.boolean(),
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
    changes_omitted: Math.max(0, (snapshot.revision || 0) - (snapshot.changes || []).length),
    summary: { active: records.filter(x => active.has(x.state)).length,
      running: records.filter(x => x.state === 'armed').length,
      starting: records.filter(x => x.state === 'starting').length,
      stopping: records.filter(x => x.state === 'stopping').length,
      stopped: records.filter(x => x.state === 'stopped').length,
      failed_or_unknown: records.filter(x => ['failed', 'unknown'].includes(x.state)).length, unhandled_events: pending.length },
    monitors: selected.map(x => ({ id: x.id, name: String(x.name || '').slice(0, 100), state: x.state, deadline: x.deadline,
      latest_event: x.latest_event, outcome: x.outcome?.reason,
      ...(active.has(x.state) ? { stop: { tool: 'monitor_stop', monitor_id: x.id } } : {}) })),
    events: pending.slice(-8).map(x => ({ id: x.id, monitor_id: x.monitor_id, event_type: x.event_type, state: x.state, occurred_at: x.occurred_at, deferred_reason: x.deferred_reason })),
    omitted: { monitors: records.length - selected.length, events: Math.max(0, pending.length - 8) },
    wait: snapshot.wait ? { state: snapshot.wait.state, monitor_ids: snapshot.wait.monitor_ids, goal_control: snapshot.wait.goal_control,
      pause_owner: snapshot.wait.pause_owner ?? snapshot.goal_pause?.owner,
      wake_scope: snapshot.wait.wake_scope, guard_ids: snapshot.wait.guard_ids,
      pause_barrier: snapshot.wait.pause_barrier, pause_checked_at: snapshot.wait.pause_checked_at, error: snapshot.wait.error } : null,
    goal_pause: snapshot.goal_pause ? { owner: snapshot.goal_pause.owner, checked_at: snapshot.goal_pause.checked_at } : undefined,
    recovery: { enabled: r.enabled, state: r.state, attempts: r.attempts ?? 0, policy: r.policy,
      next_retry_at: r.next_retry_at ?? null, deadline: r.deadline,
      ...(r.enabled ? { stop: { tool: 'monitor_recovery', enabled: false } } : {}) },
    warnings: verified ? [] : ['Service unavailable. Saved states are historical and do not establish that observers or recovery are currently running.'] };
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
  const directory = path.join(root, threadKey(threadId));
  try { return summarize(await rpc(directory, 'status', {}, timeout), 'live'); }
  catch {
    try {
      const snapshot = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
      if (snapshot.thread_id !== threadId.toLowerCase()) throw Error('Saved thread mismatch');
      return summarize(snapshot, 'saved');
    } catch (e: any) {
      const missing = e.code === 'ENOENT' && !existsSync(path.join(directory, 'endpoint.json'));
      return summarize({ thread_id: threadId, recovery: { enabled: false, state: missing ? 'disabled' : 'unknown' } }, missing ? 'empty' : 'unavailable');
    }
  }
}
