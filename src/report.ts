import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Json, now, stateRoot, threadKey, VERSION } from './common.js';
import { rpc } from './service.js';

export const reportSchema = z.object({
  type: z.literal('monitor_report'), version: z.string(), thread_id: z.string(), checked_at: z.number(),
  source: z.enum(['live', 'saved', 'empty', 'unavailable']), verified: z.boolean(),
  summary: z.object({ active: z.number(), stopped: z.number(), failed_or_unknown: z.number(), unhandled_events: z.number() }),
  monitors: z.array(z.record(z.string(), z.unknown())), events: z.array(z.record(z.string(), z.unknown())),
  omitted: z.object({ monitors: z.number(), events: z.number() }),
  wait: z.record(z.string(), z.unknown()).nullable(), recovery: z.record(z.string(), z.unknown()),
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
    checked_at: now(), source, verified,
    summary: { active: records.filter(x => active.has(x.state)).length, stopped: records.filter(x => x.state === 'stopped').length,
      failed_or_unknown: records.filter(x => ['failed', 'unknown'].includes(x.state)).length, unhandled_events: pending.length },
    monitors: selected.map(x => ({ id: x.id, name: String(x.name || '').slice(0, 100), state: x.state, deadline: x.deadline,
      latest_event: x.latest_event, outcome: x.outcome?.reason,
      ...(active.has(x.state) ? { stop: { tool: 'monitor_stop', monitor_id: x.id } } : {}) })),
    events: pending.slice(-8).map(x => ({ id: x.id, monitor_id: x.monitor_id, event_type: x.event_type, state: x.state, occurred_at: x.occurred_at })),
    omitted: { monitors: records.length - selected.length, events: Math.max(0, pending.length - 8) },
    wait: snapshot.wait ? { state: snapshot.wait.state, monitor_ids: snapshot.wait.monitor_ids } : null,
    recovery: { enabled: r.enabled, state: r.state, attempts: r.attempts ?? 0, policy: r.policy,
      next_retry_at: r.next_retry_at ?? null, deadline: r.deadline,
      ...(r.enabled ? { stop: { tool: 'monitor_recovery', enabled: false } } : {}) },
    warnings: verified ? [] : ['Service unavailable. Saved states are historical and do not establish that observers or recovery are currently running.'] };
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
