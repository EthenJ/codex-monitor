import type { BigIntStats, Stats } from 'node:fs';
import path from 'node:path';

type FileStats = Stats | BigIntStats;
function milliseconds(ns: bigint) {
  // Match Node's number-Stats conversion without truncating sub-ms precision.
  return Number(ns / 1000000000n) * 1000 + Number(ns % 1000000000n) / 1000000;
}
function version(stats: FileStats) {
  return JSON.stringify([Number(stats.dev), Number(stats.ino), Number(stats.size), Number(stats.mode),
    'mtimeNs' in stats ? milliseconds(stats.mtimeNs) : stats.mtimeMs,
    'ctimeNs' in stats ? milliseconds(stats.ctimeNs) : stats.ctimeMs]);
}

/** Reconcile backend notifications against the file version actually observed. */
export class FileObservations {
  private versions = new Map<string, string>();
  remember(file: string, stats: FileStats) {
    if (stats.isFile()) this.versions.set(path.resolve(file), version(stats));
  }
  accept(change: string, file: string, stats?: FileStats) {
    const key = path.resolve(file);
    if (change === 'unlink') this.versions.delete(key);
    if (change === 'unlinkDir') {
      for (const candidate of this.versions.keys()) if (candidate.startsWith(key + path.sep)) this.versions.delete(candidate);
    }
    if (change !== 'add' && change !== 'change') return true;
    if (!stats?.isFile()) { this.versions.delete(key); return true; }
    const current = version(stats), previous = this.versions.get(key);
    this.versions.set(key, current);
    return previous !== current;
  }
  clear() { this.versions.clear(); }
}
