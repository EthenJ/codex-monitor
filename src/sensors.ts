import chokidar, { FSWatcher } from 'chokidar';
import path from 'node:path';
import { lstat, stat, realpath, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { capture, owned, Owned } from './processes.js';
import { observeWindowsPid } from './windows.js';
import { Health, parseGpu } from './health.js';
import { FileObservations } from './file-observations.js';
import { Json, integer, text, within, bounded } from './common.js';

export function validateOptions(kind: string, raw: Json, stateDirectory: string): Json {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('options must be an object');
  const shared = ['cwd', 'timeout_ms', 'max_events', 'debounce_ms'];
  const allowed = kind === 'command' ? [...shared, 'command', 'match', 'encoding'] :
    [...shared, 'watch_file', 'watch_directory', 'recursive', 'pattern', 'file_backend', 'poll_ms', 'stalled_for_ms', 'warmup_ms', 'pid', 'gpu_util_below', 'gpu_below_for_ms', 'gpu_recover_above', 'gpu_id', 'gpu_match', 'gpu_sample_ms', 'nvidia_smi', 'dead_if', 'watchdog_only', 'report_recovery'];
  if (!['command', 'watchdog'].includes(kind)) throw Error('kind must be command or watchdog');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw Error(`Unsupported option: ${key}`);
  if (!path.isAbsolute(text(raw.cwd, 'cwd', 4096))) throw Error('cwd must be absolute');
  const o: Json = { timeout_ms: 1800000, max_events: 0, debounce_ms: 200, warmup_ms: 0, poll_ms: 1000, gpu_sample_ms: 10000,
    gpu_below_for_ms: 120000, gpu_id: '0', gpu_match: 'all', dead_if: 'all', file_backend: 'auto', ...raw };
  integer(o.timeout_ms, 'timeout_ms', 1, kind === 'command' ? 1800000 : 604800000);
  for (const key of ['max_events', 'debounce_ms', 'warmup_ms']) integer(o[key], key, 0, 604800000);
  for (const key of ['poll_ms', 'gpu_sample_ms', 'gpu_below_for_ms']) integer(o[key], key, 10, 604800000);
  for (const key of ['recursive', 'watchdog_only', 'report_recovery']) if (o[key] !== undefined && typeof o[key] !== 'boolean') throw Error(`${key} must be boolean`);
  for (const key of ['pattern', 'nvidia_smi', 'encoding']) if (o[key] !== undefined) text(o[key], key, 4096);
  if (o.warmup_ms >= o.timeout_ms) throw Error('warmup_ms must be shorter than timeout_ms');
  if (kind === 'command') { text(o.command, 'command', 16000); text(o.match, 'match', 1000); new RegExp(o.match); new TextDecoder(o.encoding || 'utf-8'); return o; }
  if (o.watch_file && o.watch_directory) throw Error('Choose watch_file or watch_directory');
  for (const key of ['watch_file', 'watch_directory']) if (o[key]) o[key] = path.resolve(o.cwd, text(o[key], key, 4096));
  if (o.watch_directory && within(stateDirectory, o.watch_directory)) throw Error('State must be outside the watched directory');
  if (o.stalled_for_ms !== undefined) { integer(o.stalled_for_ms, 'stalled_for_ms', 1, 604800000); if (!o.watch_file && !o.watch_directory) throw Error('Inactivity requires a file source'); }
  if (o.pid !== undefined) integer(o.pid, 'pid', 1, 2147483647);
  if (!['all', 'any'].includes(o.dead_if) || !['all', 'any'].includes(o.gpu_match)) throw Error('Aggregation must be all or any');
  if (!['auto', 'native', 'polling'].includes(o.file_backend)) throw Error('Invalid file backend');
  if (o.gpu_util_below !== undefined) {
    integer(o.gpu_util_below, 'gpu_util_below', 0, 100);
    o.gpu_recover_above ??= o.gpu_util_below;
    integer(o.gpu_recover_above, 'gpu_recover_above', o.gpu_util_below, 100);
    const selectors = text(o.gpu_id, 'gpu_id', 1000).split(',').map(v => v.trim());
    if (selectors.some(v => !v) || (selectors.includes('all') && selectors.length !== 1)) throw Error('Invalid GPU selection');
    o.gpu_id = selectors.join(',');
  }
  if (!o.watch_file && !o.watch_directory && o.gpu_util_below === undefined && !o.pid) throw Error('At least one event source is required');
  if (o.watchdog_only && !o.stalled_for_ms && o.gpu_util_below === undefined && !o.pid) throw Error('watchdog_only requires a health or PID source');
  return o;
}
export interface Sensor { ready: Promise<Json>; stop(reason?: string): Promise<void> }
export function startSensor(kind: string, options: Json, emit: (event: Json) => void, ended: (outcome: Json) => void): Sensor {
  let stopping: Promise<void> | undefined;
  let stopped = false, ready = false, count = 0;
  let watcher: FSWatcher | undefined, command: Owned | undefined;
  const cleaners: Array<() => void | Promise<void>> = [];
  const addCleanup = (fn: () => void | Promise<void>) => { if (stopped) void Promise.resolve().then(fn).catch(() => {}); else cleaners.push(fn); };
  const o = options;
  let health = new Health(o, performance.now());
  const deadline = setTimeout(() => { send({ event_type: 'monitor_expired' }); void stop('deadline'); }, o.timeout_ms);
  addCleanup(() => clearTimeout(deadline));
  const stop = (reason = 'cancelled'): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      const errors = (await Promise.allSettled(cleaners.map(fn => Promise.resolve().then(fn)))).filter(r => r.status === 'rejected');
      if (watcher) await watcher.close();
      if (command) await command.stop();
      ended({ reason, event_count: count, ...(errors.length ? { cleanup_error: String((errors[0] as PromiseRejectedResult).reason) } : {}) });
    })();
    return stopping;
  };
  function send(event: Json) {
    if (stopped) return;
    emit(event); count++;
    if (o.max_events && count >= o.max_events) void stop('max_events');
  }
  const fail = (e: unknown) => { if (!stopped) { send({ event_type: 'monitor_error', error: bounded(e) }); void stop('monitor_error'); } };
  const startup = (async (): Promise<Json> => {
    try {
      if (!(await stat(o.cwd)).isDirectory()) throw Error('cwd must be a directory');
      if (stopped) throw Error('Monitor cancelled during registration');
      if (kind === 'command') {
        const regex = new RegExp(o.match);
        command = await owned(o.command, [], { cwd: o.cwd, shell: true });
        command.process.stdin!.end();
        if (stopped) { await command.stop(); throw Error('Monitor cancelled during registration'); }
        let last = -Infinity, lastValue: string | undefined;
        for (const stream of [command.process.stdout!, command.process.stderr!]) {
          const decoder = new TextDecoder(o.encoding || 'utf-8');
          let line = '';
          const consume = (chunk: string, final = false) => {
            line += chunk;
            let pos: number;
            while ((pos = line.indexOf('\n')) >= 0) { const value = line.slice(0, pos).replace(/\r$/, ''); line = line.slice(pos + 1); check(value); }
            if (line.length > 16000) fail(Error('Command output line exceeds 16000 characters'));
            if (final && line) { check(line); line = ''; }
          };
          const check = (value: string) => {
            if (value.length > 16000) { fail(Error('Command output line exceeds 16000 characters')); return; }
            const at = performance.now();
            if (regex.test(value) && (value !== lastValue || at - last >= o.debounce_ms)) {
              last = at; lastValue = value; send({ event_type: 'command_output', event: value });
            }
          };
          stream.on('data', chunk => consume(decoder.decode(chunk, { stream: true })));
          stream.on('end', () => consume(decoder.decode(), true));
          stream.on('error', fail);
        }
        void command.done.then(result => { if (!stopped) { send({ event_type: 'command_exit', returncode: result.code, signal: result.signal }); void stop('completed'); } });
        ready = true;
        return { observed_pid: command.pid, backend: 'owned-process' };
      }
      if (o.watch_file || o.watch_directory) {
        const target = o.watch_file || o.watch_directory;
        const rootAlias = o.watch_file ? path.dirname(target) : target;
        const root = await realpath(rootAlias), original = await stat(root, { bigint: true });
        if (!original.isDirectory()) throw Error('Watch root must be a directory');
        const verifyFile = async () => {
          try {
            const entry = await lstat(target);
            if (entry.isSymbolicLink()) throw Error('Watch the symlink target explicitly');
            if (!entry.isFile()) throw Error('watch_file must be a regular file');
          } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        };
        if (o.watch_file) {
          await verifyFile();
        }
        if (stopped) throw Error('Monitor cancelled during registration');
        // Parent subscription handles a file absent at registration and atomic replacement.
        const last = new Map<string, number>();
        const observations = new FileObservations();
        addCleanup(() => observations.clear());
        const selectedPath = (observed: string) => {
          const alias = path.join(rootAlias, path.relative(root, observed));
          if (o.watch_file && path.resolve(alias) !== target) return undefined;
          const relative = path.relative(rootAlias, alias);
          if (o.pattern && !path.matchesGlob(relative, o.pattern) && !path.matchesGlob(path.basename(alias), o.pattern)) return undefined;
          return alias;
        };
        watcher = chokidar.watch(root, { ignoreInitial: true, followSymlinks: false, atomic: false,
          depth: o.watch_file || !o.recursive ? 0 : undefined, backend: o.file_backend,
          // The public filter receives initial scan stats even with ignoreInitial.
          // Keep that baseline to reject delayed startup echoes without a sleep.
          ignored: (observed, stats) => {
            if (!ready && stats?.isFile() && selectedPath(observed)) observations.remember(observed, stats);
            return false;
          },
          pollingInterval: o.poll_ms, ignorePermissionErrors: false });
        const registered = watcher;
        addCleanup(() => registered.close());
        watcher.on('error', fail);
        watcher.on('all', (change, observed, stats) => {
          if (!ready || stopped) return;
          const alias = selectedPath(observed);
          if (!alias || !observations.accept(change, observed, stats)) return;
          const at = performance.now();
          // Every observed write is progress, even when its notification is
          // debounced. Deletion and directory churn do not prove progress.
          if (change === 'add' || change === 'change') health.progress(at);
          if (['add', 'change', 'addDir'].includes(change)) {
            if (at - (last.get(alias) ?? -Infinity) < o.debounce_ms) return;
            last.set(alias, at);
          } else last.delete(alias);
          if (last.size > 4096) last.delete(last.keys().next().value!);
          if (!o.watchdog_only) send({ event_type: 'file_change', change: ({ add: 'created', change: 'modified', unlink: 'deleted', addDir: 'created', unlinkDir: 'deleted' } as Json)[change], path: alias });
        });
        if (stopped) throw Error('Monitor cancelled during registration');
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('File watcher startup timed out')), 10000);
          addCleanup(() => { clearTimeout(timeout); reject(Error('File watcher registration cancelled')); });
          watcher!.once('ready', () => { clearTimeout(timeout); resolve(); });
          watcher!.once('error', e => { clearTimeout(timeout); reject(e); });
        });
        if (stopped) throw Error('Monitor cancelled during registration');
        let checking = false;
        const verify = setInterval(async () => {
          if (checking || stopped) return; checking = true;
          try {
            const current = await stat(rootAlias, { bigint: true });
            if (current.dev !== original.dev || current.ino !== original.ino) throw Error('Watched root was replaced or renamed');
            if (o.watch_file) await verifyFile();
          } catch (e) { fail(e); } finally { checking = false; }
        }, 250);
        addCleanup(() => clearInterval(verify));
      }
      if (o.pid) {
        if (process.platform === 'win32') addCleanup(observeWindowsPid(o.pid,
          code => { send({ event_type: 'process_exit', returncode: code }); void stop('process_exit'); }, fail));
        else {
          const identity = async () => {
            if (process.platform === 'linux') {
              const raw = await readFile(`/proc/${o.pid}/stat`, 'utf8');
              const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
              return fields[0] === 'Z' ? null : fields[19];
            }
            return (await capture('ps', ['-p', String(o.pid), '-o', 'lstart='], {}, 3000)).trim() || null;
          };
          const original = await identity();
          if (!original) throw Error('Observed PID is already exited');
          let checking = false;
          const timer = setInterval(async () => {
            if (checking || stopped) return; checking = true;
            try {
              if (await identity() !== original) { send({ event_type: 'process_exit', returncode: null }); void stop('process_exit'); }
            } catch (e: any) {
              let exited = e.code === 'ENOENT';
              if (process.platform === 'darwin') { try { process.kill(o.pid, 0); } catch (probe: any) { exited = probe.code === 'ESRCH'; } }
              if (exited) { send({ event_type: 'process_exit', returncode: null }); void stop('process_exit'); }
              else fail(e);
            } finally { checking = false; }
          }, process.platform === 'darwin' ? 1000 : 250);
          addCleanup(() => clearInterval(timer));
        }
      }
      if (stopped) throw Error('Monitor cancelled during registration');
      // Dwell/grace time begins only after file/PID registration is ready.
      health = new Health(o, performance.now());
      if (o.gpu_util_below != null) {
        const cancel = new AbortController();
        let inFlight: Promise<void> | undefined;
        let gpuTimer: NodeJS.Timeout | undefined, failed = false;
        const sample = async () => {
          try {
            const args = ['--query-gpu=index,uuid,pci.bus_id,utilization.gpu', '--format=csv,noheader,nounits'];
            if (o.gpu_id !== 'all') args.push(`--id=${o.gpu_id}`);
            const output = await capture(o.nvidia_smi || 'nvidia-smi', args, {}, 10000, cancel.signal);
            if (!stopped) { health.gpu(performance.now(), parseGpu(output, o.gpu_id)); failed = false; }
          } catch (e) { health.gpuUnknown(); if (!failed && !stopped) send({ event_type: 'monitor_error', sensor: 'gpu', error: bounded(e), health: 'unknown' }); failed = true; }
          if (!stopped) gpuTimer = setTimeout(() => { inFlight = sample(); }, o.gpu_sample_ms);
        };
        addCleanup(async () => { if (gpuTimer) clearTimeout(gpuTimer); cancel.abort(); await inFlight; });
        inFlight = sample();
      }
      const tick = setInterval(() => {
        if (!ready || stopped) return;
        const event = health.tick(performance.now());
        if (event && (event.event_type !== 'watchdog_recovered' || o.report_recovery)) send(event);
      }, Math.min(250, o.stalled_for_ms || 250));
      addCleanup(() => clearInterval(tick));
      if (stopped) throw Error('Monitor stopped during registration');
      ready = true;
      return { observed_pid: o.pid || null, backend: o.watch_file || o.watch_directory ? `chokidar-${o.file_backend}` : 'health' };
    } catch (e) { fail(e); await stop('monitor_error'); throw e; }
  })();
  return { ready: startup, stop };
}
