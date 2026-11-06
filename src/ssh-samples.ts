import path from 'node:path';
import { Json } from './common.js';
import { validateOptions } from './sensors.js';
import { connectionOptions, sshSchema, watchdogOptions } from './contracts.js';
import { parseGpu } from './health.js';
import { quote, sshArgs, SshSession } from './ssh-session.js';

export function normalizeSsh(kind: string, raw: Json, transport: Json) {
  const t = sshSchema.parse(transport); sshArgs(t);
  if (kind === 'connection') return { transport: t, options: { timeout_ms: 1800000, ...connectionOptions.parse(raw) } };
  if (kind !== 'watchdog') throw Error('SSH observes existing workloads; remote command ownership is not supported');
  watchdogOptions.parse(raw);
  if (raw.file_backend === 'native') throw Error('SSH shell observation supports metadata polling, not native file events');
  for (const value of Object.values(raw)) if (typeof value === 'string' && value.includes('\0')) throw Error('Remote options cannot contain NUL');
  // On Linux path === path.posix: filesystem ownership must be explicit,
  // never inferred from the path implementation object.
  const options = validateOptions(kind, { poll_ms: raw.watch_directory ? 30000 : 10000, gpu_sample_ms: 15000, ...raw, file_backend: 'polling' }, undefined, path.posix);
  if (options.poll_ms < 1000 || options.gpu_sample_ms < 1000) throw Error('SSH sampling intervals must be at least 1000 ms');
  return { transport: t, options };
}
export async function query(session: SshSession, script: string) {
  const r = await session.request(script);
  if (r.code !== 0) throw Error(`Remote read failed (exit ${r.code}${r.code === 124 || r.code === 137 ? ', sample timeout' : ''})`);
  return r.data;
}
export async function checkRemote(session: SshSession, kind: string, o: Json) {
  if (kind === 'connection') return;
  const cwd = quote(o.cwd);
  await query(session, `test -d ${cwd} && test -r ${cwd} && test -x ${cwd} && command -v stat >/dev/null && command -v cat >/dev/null`);
  if (o.watch_directory) await query(session, 'command -v find >/dev/null');
}
export async function fileSample(session: SshSession, o: Json) {
  const target = o.watch_file || o.watch_directory;
  const root = o.watch_file ? path.posix.dirname(target) : target;
  const r = quote(root), p = quote(target);
  let script = `test -d ${r} && test -r ${r} && test -x ${r} || exit 10; stat -L --printf='%d:%i\\n' -- ${r} || exit 11; `;
  if (o.watch_file) script += `test ! -L ${p} || exit 12; if test -e ${p}; then test -f ${p} && test -r ${p} || exit 13; stat --printf='%d:%i:%s:%y:%z' -- ${p}; else test ! -e ${p} || exit 14; printf MISSING; fi`;
  else script += `find -H ${r} ${o.recursive ? '' : '-maxdepth 1'} -mindepth 1 \\( -type f -o -type d \\) -printf '%P\\0%y:%D:%i:%s:%T@:%C@\\0'`;
  const bytes = await query(session, script), newline = bytes.indexOf(10);
  if (newline < 0) throw Error('Missing remote root identity');
  const identity = bytes.subarray(0, newline).toString(), content = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(newline + 1));
  if (!/^\d+:\d+$/.test(identity)) throw Error('Invalid remote root identity');
  const entries = new Map<string, string>();
  if (o.watch_file) { if (content !== 'MISSING') entries.set(target, 'f:' + content); }
  else {
    const fields = content.split('\0');
    if (fields.pop() !== '' && content) throw Error('Truncated directory snapshot');
    if (fields.length % 2 || fields.length > 8192) throw Error('Directory snapshot exceeds 4096 entries or is malformed; narrow the watched directory');
    for (let i = 0; i < fields.length; i += 2) {
      const relative = fields[i];
      if (!relative || relative.startsWith('/') || relative.split('/').includes('..') || !/^[fd]:\d+:\d+:\d+:/.test(fields[i + 1])) throw Error('Invalid remote directory record');
      if (!o.pattern || path.posix.matchesGlob(relative, o.pattern) || path.posix.matchesGlob(path.posix.basename(relative), o.pattern)) entries.set(path.posix.join(target, relative), fields[i + 1]);
    }
  }
  return { identity, entries };
}
export async function processSample(session: SshSession, pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid remote PID');
  const data = (await query(session, `boot=$(cat /proc/sys/kernel/random/boot_id) || exit 10; if record=$(cat /proc/${pid}/stat); then printf '%s\\n%s' "$boot" "$record"; elif test ! -d /proc/${pid}; then printf MISSING; else exit 11; fi`)).toString();
  if (data === 'MISSING') return null;
  const newline = data.indexOf('\n'), boot = data.slice(0, newline), stat = data.slice(newline + 1);
  const close = stat.lastIndexOf(')'), values = stat.slice(close + 2).trim().split(/\s+/);
  if (!/^[\da-f-]{36}$/.test(boot) || !stat.startsWith(`${pid} (`) || close < 0 || !/^\d+$/.test(values[19] || '')) throw Error('Invalid remote process identity');
  return { identity: `${boot}:${pid}:${values[19]}`, state: values[0] };
}
export async function gpuSample(session: SshSession, o: Json) {
  const output = (await query(session, `${o.cwd ? `cd ${quote(o.cwd)} && ` : ''}${quote(o.nvidia_smi || 'nvidia-smi')} --query-gpu=index,uuid,pci.bus_id,utilization.gpu --format=csv,noheader,nounits`)).toString();
  // parseGpu validates selection presence; restrict values to that selection.
  const values = parseGpu(output, o.gpu_id);
  if (o.gpu_id === 'all') return values;
  const selected = new Set(o.gpu_id.toLowerCase().split(',').map((s: string) => s.trim()));
  const identities = output.trim().split(/\r?\n/).map(row => row.split(',').map(s => s.trim().toLowerCase()))
    .filter(parts => parts.slice(0, 3).some(p => selected.has(p) || /^\d+$/.test(p) && [...selected].some(s => /^\d+$/.test(String(s)) && Number(s) === Number(p)) || p.includes(':') && [...selected].some(s => String(s).padStart(16, '0') === p.padStart(16, '0')))).map(p => p[1]);
  return Object.fromEntries(Object.entries(values).filter(([key]) => identities.includes(key)));
}
export async function probeSsh(kind: string, o: Json, transport: Json) {
  const session = new SshSession(transport);
  try {
    await session.open(); await checkRemote(session, kind, o);
    if (o.watch_file || o.watch_directory) await fileSample(session, o);
    if (o.pid) {
      const sample = await processSample(session, o.pid);
      if (!sample || ['Z', 'X'].includes(sample.state)) throw Error('Remote PID is not running');
    }
    if (o.gpu_util_below != null) await gpuSample(session, o);
  } finally { await session.close(); }
}
