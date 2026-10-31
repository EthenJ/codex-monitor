import { Json } from './common.js';
export class Health {
  armedAt: number; lastProgress: number; alerting = false;
  active: Json = {}; unknown = new Set<string>(); low = new Map<string, number>(); gpuIds = '';
  constructor(public options: Json, started: number) {
    this.armedAt = started + (options.warmup_ms || 0); this.lastProgress = this.armedAt;
    if (options.gpu_util_below != null) this.unknown.add('gpu_low');
  }
  progress(at: number) { this.lastProgress = Math.max(at, this.armedAt); delete this.active.file_stalled; }
  gpuUnknown() { this.low.clear(); delete this.active.gpu_low; this.unknown.add('gpu_low'); }
  gpu(at: number, values: Record<string, number>) {
    if (!Object.keys(values).length) { this.gpuUnknown(); return; }
    if (at < this.armedAt) { this.low.clear(); return; }
    const ids = Object.keys(values).sort().join(',');
    if (this.gpuIds && this.gpuIds !== ids) this.gpuUnknown();
    this.gpuIds = ids;
    for (const [gpu, value] of Object.entries(values)) {
      if (value < this.options.gpu_util_below) { if (!this.low.has(gpu)) this.low.set(gpu, at); } else this.low.delete(gpu);
    }
    const all = this.options.gpu_match !== 'any';
    const combine = (flags: boolean[]) => all ? flags.every(Boolean) : flags.some(Boolean);
    const recovering = !combine(Object.values(values).map(v => v < this.options.gpu_recover_above));
    if (recovering) delete this.active.gpu_low;
    else if (!this.active.gpu_low && combine(Object.values(values).map(v => v < this.options.gpu_util_below))) {
      const since = (all ? Math.max : Math.min)(...this.low.values());
      if (at - since >= this.options.gpu_below_for_ms) this.active.gpu_low = { duration_ms: at - since, threshold: this.options.gpu_util_below, utilization: values };
    }
    if (this.active.gpu_low) this.active.gpu_low.utilization = values;
    if (recovering || !this.alerting || this.active.gpu_low) this.unknown.delete('gpu_low');
  }
  tick(at: number) {
    const enabled = [];
    if (this.options.stalled_for_ms) {
      enabled.push('file_stalled');
      if (at - this.lastProgress >= this.options.stalled_for_ms && at >= this.armedAt) this.active.file_stalled = { duration_ms: at - this.lastProgress };
    }
    if (this.options.gpu_util_below != null) enabled.push('gpu_low');
    const stalled = this.options.dead_if === 'any' ? Object.keys(this.active).length > 0 : enabled.length > 0 && enabled.every(k => this.active[k]);
    if (!stalled && this.unknown.size) return;
    if (Boolean(stalled) !== this.alerting) {
      this.alerting = Boolean(stalled);
      return { event_type: stalled ? 'watchdog_stalled' : 'watchdog_recovered', conditions: structuredClone(this.active) };
    }
  }
}
export function parseGpu(output: string, selected: string): Record<string, number> {
  const values: Record<string, number> = {}, identities = new Set<string>(), indices = new Set<string>();
  const normalize = (id: string) => /^\d+$/.test(id) ? String(Number(id)) : /^[\da-f]{4,8}:[\da-f]{2}:[\da-f]{2}\.[0-7]$/i.test(id) ? id.toLowerCase().padStart(16, '0') : id.toLowerCase();
  for (const row of output.trim().split(/\r?\n/)) {
    const parts = row.split(',').map(s => s.trim());
    const number = Number(parts[3]);
    if (parts.length !== 4 || !/^\d+$/.test(parts[0]) || !parts[1] || !parts[2] || !parts[3] || !Number.isFinite(number) || number < 0 || number > 100 || indices.has(normalize(parts[0])) || normalize(parts[1]) in values) throw Error('Invalid GPU utilization response');
    indices.add(normalize(parts[0]));
    // UUID identity prevents a replacement card at the same index inheriting dwell.
    values[normalize(parts[1])] = number; parts.slice(0, 3).forEach(v => identities.add(normalize(v)));
  }
  if (selected !== 'all' && selected.split(',').some(s => !identities.has(normalize(s.trim())))) throw Error('Selected GPU missing from response');
  return values;
}
