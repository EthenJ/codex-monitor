import { EventEmitter } from 'node:events';
import { Json, now } from './common.js';

// A bounded lifecycle journal. No evidence, authorization, log lines or sensor samples.
export class Changes {
  revision: number;
  entries: Json[];
  private previous: Map<string, string>;
  private updates = new EventEmitter();
  private closed = false;
  constructor(snapshot: Json = {}) {
    this.revision = Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0;
    this.entries = (Array.isArray(snapshot.changes) ? snapshot.changes : []).slice(-128);
    this.previous = this.project(snapshot);
    this.updates.setMaxListeners(32);
  }
  private project(snapshot: Json) {
    const values: Json[] = [];
    for (const m of Object.values(snapshot.monitors || {}) as Json[]) values.push({ category: 'monitor', id: m.id,
      name: String(m.name || '').slice(0, 100), state: m.state, muted: Boolean(m.muted), outcome: m.outcome?.reason });
    for (const e of Object.values(snapshot.events || {}) as Json[]) values.push({ category: 'event', id: e.id,
      monitor_id: e.monitor_id, event_type: e.event_type, state: e.state, processing: e.processing });
    if (snapshot.wait) values.push({ category: 'wait', id: snapshot.wait.id, state: snapshot.wait.state });
    if (snapshot.recovery) { const r = snapshot.recovery; values.push({ category: 'recovery', state: r.state,
      enabled: r.enabled, attempts: r.attempts, next_retry_at: r.next_retry_at, policy: r.policy }); }
    return new Map(values.map(v => [`${v.category}:${v.id || ''}`, JSON.stringify(v)]));
  }
  update(snapshot: Json) {
    const next = this.project(snapshot); let changed = false;
    for (const [key, value] of next) if (this.previous.get(key) !== value) {
      const previous = this.previous.get(key);
      this.entries.push({ ...JSON.parse(value), previous_state: previous ? JSON.parse(previous).state : null,
        revision: ++this.revision, at: now() }); changed = true;
    }
    this.previous = next; this.entries = this.entries.slice(-128); return changed;
  }
  notify() { this.updates.emit('change'); }
  close() { this.closed = true; this.notify(); }
  get listeners() { return this.updates.listenerCount('change'); }
  async wait(after: number, timeout: number, signal?: AbortSignal) {
    if (this.closed || this.revision !== after || signal?.aborted) return;
    if (this.listeners >= 32) throw Error('At most 32 live report viewers per thread');
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.updates.off('change', finish); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, timeout);
      this.updates.once('change', finish); signal?.addEventListener('abort', finish, { once: true });
    });
  }
}
