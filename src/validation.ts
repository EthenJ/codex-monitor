import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Bridge, BridgeLike, getGoal, loaded } from './bridge.js';
import { Json, bounded, now, within } from './common.js';
import { monitorSchema, recoveryPolicy, defaultEvents, commandOptions } from './contracts.js';
import { validateOptions } from './sensors.js';
import { capture } from './processes.js';
import { parseGpu } from './health.js';

export class ValidationFailure extends Error {
  constructor(public report: Json) { super(report.errors.map((x: Json) => x.message).join('; ')); }
}

export function normalizeMonitor(raw: unknown, directory: string): Json {
  const p = monitorSchema.parse(raw);
  const kind = p.kind ?? ('command' in p.options ? 'command' : 'watchdog');
  let options = validateOptions(kind, { ...p.options, ...(kind === 'command' ? { match: 'match' in p.options ? p.options.match ?? '(?!)' : '(?!)' } : {}) }, directory);
  if (kind === 'command') options = Object.fromEntries(Object.entries(options).filter(([key]) => key in commandOptions.shape));
  // Keep raw supplied strings (shell syntax/paths) intact; schemas must not trim them.
  return { ...p, kind, options, notify_on: p.notify_on ?? defaultEvents, event_ttl_ms: p.event_ttl_ms ?? 3600000 };
}
export async function checkFiles(o: Json, directory: string) {
  if (!(await stat(o.cwd)).isDirectory()) throw Error('cwd must be a directory');
  await access(o.cwd, constants.R_OK | constants.X_OK);
  if (!o.watch_file && !o.watch_directory) return;
  const root = await realpath(o.watch_file ? path.dirname(o.watch_file) : o.watch_directory);
  if (!(await stat(root)).isDirectory()) throw Error('Watch root must be a directory');
  await access(root, constants.R_OK | constants.X_OK);
  // Resolve the nearest existing ancestor without creating a state directory.
  let ancestor = path.resolve(directory); const missing: string[] = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (e: any) { if (e.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw e; missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  }
  const state = path.join(ancestor, ...missing);
  if (o.watch_directory && within(state, root)) throw Error('State must be outside watched tree');
  if (o.watch_file) {
    if (within(path.join(root, path.basename(o.watch_file)), state)) throw Error('Cannot watch monitor state files');
    try {
      const entry = await lstat(o.watch_file);
      if (entry.isSymbolicLink()) throw Error('Watch the symlink target explicitly');
      if (!entry.isFile()) throw Error('watch_file must be a regular file');
      await access(o.watch_file, constants.R_OK);
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
}
export async function validateRequest(threadId: string, directory: string, request: Json, checkHost = true,
  connect: () => Promise<BridgeLike> = () => Bridge.connect()) {
  const result: Json = { valid: false, checked_at: now(), operation: request.operation, normalized: null, checks: [], errors: [], warnings: [] };
  async function check(name: string, field: string, run: () => Promise<void>) {
    try { await run(); result.checks.push({ name, status: 'passed', message: 'Verified at validation time' }); }
    catch (e) {
      result.checks.push({ name, status: 'failed', message: bounded(e) });
      if (e instanceof z.ZodError) result.errors.push(...e.issues.map(x => ({ code: x.code, path: [field, ...x.path].join('.'), message: x.message })));
      else result.errors.push({ code: name.toUpperCase() + '_FAILED', path: field, message: bounded(e) });
    }
  }
  let normalized: Json | undefined;
  await check('configuration', 'config', async () => {
    if (request.operation === 'start') normalized = normalizeMonitor(request.config, directory);
    else if (request.operation === 'recovery') {
      const { config, policy } = recoveryPolicy(request.config);
      normalized = config.enabled ? { enabled: true, ...policy } : { enabled: false };
    } else throw Error('operation must be start or recovery');
    result.normalized = normalized;
  });
  if (normalized && request.operation === 'start') {
    const o = normalized.options;
    await check('filesystem', 'config.options.cwd', () => checkFiles(o, directory));
    if (o.pid) await check('process', 'config.options.pid', async () => { process.kill(o.pid, 0); });
    if (o.gpu_util_below != null) await check('gpu', 'config.options.gpu_id', async () => {
      parseGpu(await capture(o.nvidia_smi || 'nvidia-smi', ['--query-gpu=index,uuid,pci.bus_id,utilization.gpu', '--format=csv,noheader,nounits'], {}, 5000), o.gpu_id);
    });
    if (normalized.kind === 'command') result.warnings.push('The workload command is not executed during validation; executable availability and its eventual exit status are not verified.');
    result.warnings.push('Validation does not arm observers. Files, PIDs, GPU access and watcher readiness can change before registration.');
  }
  if (checkHost && normalized) await check('host', 'thread_id', async () => {
    const bridge = await connect();
    try {
      await loaded(bridge, threadId);
      if (request.operation === 'recovery' && normalized?.enabled) {
        const goal = await getGoal(bridge, threadId);
        if (goal && (goal.status !== 'active' || (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget))) throw Error('Goal paused, ended or budget exhausted; recovery cannot run');
      }
    } finally { await bridge.close(); }
  });
  else result.checks.push({ name: 'host', status: 'skipped', message: 'No host verification; callback availability is unverified' });
  result.valid = result.errors.length === 0; return result;
}
