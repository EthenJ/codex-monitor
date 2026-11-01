import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeMonitor, validateRequest } from '../../codex-monitor/runtime/validation.js';
import { Recovery } from '../../codex-monitor/runtime/recovery.js';
import { Manager } from '../../codex-monitor/runtime/manager.js';
import { owned } from '../../codex-monitor/runtime/processes.js';
import { rpc, ensureBroker } from '../../codex-monitor/runtime/service.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-validation-'));
  const work = path.join(root, 'work'); await mkdir(work);
  t.after(() => rm(root, { recursive: true, force: true }));
  const thread = randomUUID(), directory = path.join(root, 'state', thread);
  const config = { name: 'fixture', instructions: 'Inspect evidence', options: { cwd: work, watch_file: 'metrics' } };
  const validate = (value = config, host = false, connect) => validateRequest(thread, directory, { operation: 'start', config: value }, host, connect);
  return { root, work, thread, directory, config, validate };
}
test('minimal monitor configuration infers kind, preserves paths and shares effective defaults', async t => {
  const f = await fixture(t);
  const report = await f.validate(); assert.equal(report.valid, true);
  assert.equal(report.normalized.kind, 'watchdog');
  assert.equal(report.normalized.options.watch_file, path.join(f.work, 'metrics'));
  assert.equal(report.normalized.options.timeout_ms, 1800000);
  assert.equal(report.checks.find(x => x.name === 'host').status, 'skipped');
  assert.equal(existsSync(f.directory), false);
  const command = ' echo "spaces matter" ';
  const normalized = normalizeMonitor({ ...f.config, options: { cwd: f.work, command } }, f.directory);
  assert.equal(normalized.kind, 'command'); assert.equal(normalized.options.command, command);
  assert.equal(new RegExp(normalized.options.match).test('anything'), false);
  assert.deepEqual(normalizeMonitor(normalized, f.directory), normalized);
  assert.deepEqual(normalizeMonitor(report.normalized, f.directory), report.normalized);
  const polling = await f.validate({ ...f.config, options: { ...f.config.options, file_backend: 'polling' } });
  assert.equal(polling.valid, true);
  assert.match(polling.warnings.join(' '), /Polling samples filesystem metadata/);
});
test('invalid fields, mutually exclusive sources and impossible health rules are rejected', async t => {
  const f = await fixture(t);
  for (const options of [
    { cwd: f.work, watch_file: 'a', watch_directory: 'b' }, { cwd: f.work },
    { cwd: 'relative', watch_file: 'a' }, { cwd: f.work, watch_file: 'a', recursive: 'true' },
    { cwd: f.work, watch_file: 'a', timout_ms: 10 }, { cwd: f.work, watch_file: 'a', timeout_ms: -1 },
    { cwd: f.work, watch_file: 'a', gpu_util_below: 20, gpu_recover_above: 10 },
    { cwd: f.work, stalled_for_ms: 1000, pid: process.pid },
    { cwd: f.work, watch_file: 'a', gpu_recover_above: 20 },
    { cwd: f.work, watch_file: 'a', report_recovery: true },
    { cwd: f.work, watch_file: 'a', warmup_ms: 100, timeout_ms: 50 },
    { cwd: f.work, command: 'echo example', match: '[' },
    { cwd: f.work, command: 'echo example', encoding: 'unknown-encoding' },
  ]) {
    const r = await f.validate({ ...f.config, options });
    assert.equal(r.valid, false, JSON.stringify(options)); assert.ok(r.errors.length);
  }
  assert.equal((await f.validate({ ...f.config, kind: 'command' })).valid, false);
  assert.equal(existsSync(f.directory), false);
});
test('read-only validation never executes a workload, starts observers or modifies recovery', async t => {
  const f = await fixture(t), marker = path.join(f.work, 'must-not-exist');
  const script = path.join(f.work, 'side-effect.cjs'); await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'oops')`);
  const r = await f.validate({ ...f.config, options: { cwd: f.work, command: `"${process.execPath}" "${script}"` } });
  assert.equal(r.valid, true); assert.equal(existsSync(marker), false); assert.equal(existsSync(f.directory), false);
  assert.match(r.warnings.join(' '), /not executed/);
  const recovery = await validateRequest(f.thread, f.directory, { operation: 'recovery', config: { enabled: true, authorization: 'Fixture only' } }, false);
  assert.equal(recovery.valid, true); assert.equal(recovery.normalized.retry_interval_ms, 300000);
  assert.equal(recovery.normalized.max_elapsed_ms, 10800000); assert.equal(existsSync(f.directory), false);
  assert.equal(recovery.normalized.authorization, undefined);
});
test('filesystem checks handle missing files and reject bad roots, symlinks and state aliases', async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  const alias = path.join(f.root, 'state-alias'); await symlink(path.dirname(f.directory), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const options of [
    { cwd: f.work, watch_file: 'absent-parent/metrics' }, { cwd: f.work, watch_file: f.work },
    { cwd: f.work, watch_directory: alias }, { cwd: f.work, watch_file: path.join(alias, f.thread, 'state.json') },
  ]) assert.equal((await f.validate({ ...f.config, options })).valid, false, JSON.stringify(options));
  assert.equal((await f.validate()).valid, true);
});
test('preflight reports vanished PIDs and unavailable GPU providers before creating a monitor', async t => {
  const f = await fixture(t);
  const child = await owned(process.execPath, ['-e', 'setInterval(()=>{},1000)']); t.after(() => child.stop());
  assert.equal((await f.validate({ ...f.config, options: { cwd: f.work, pid: child.pid } })).valid, true);
  await child.stop();
  assert.equal((await f.validate({ ...f.config, options: { cwd: f.work, pid: child.pid } })).valid, false);
  const gpu = await f.validate({ ...f.config, options: { cwd: f.work, gpu_util_below: 10, nvidia_smi: path.join(f.work, 'absent-smi') } });
  assert.equal(gpu.valid, false); assert.equal(gpu.errors[0].code, 'GPU_FAILED');
});
test('host checks only read the exact loaded thread and close on success and failure', async t => {
  const f = await fixture(t);
  for (const available of [true, false]) {
    const methods = []; let closed = false;
    const host = { rpc: async method => { methods.push(method); return { data: available ? [f.thread] : [] }; }, close: async () => { closed = true; } };
    const r = await f.validate(f.config, true, async () => host);
    assert.equal(r.valid, available); assert.deepEqual(methods, ['thread/loaded/list']); assert.equal(closed, true);
  }
  const r = await f.validate(f.config, true, async () => { throw Error('Daemon unavailable'); });
  assert.equal(r.valid, false); assert.equal(r.errors[0].code, 'HOST_FAILED');
});
test('GPU preflight verifies provider output and exact selectors', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), provider = path.join(f.work, 'gpu-provider');
  const config = { ...f.config, options: { cwd: f.work, gpu_util_below: 10, nvidia_smi: provider, gpu_id: '0' } };
  await writeFile(provider, "#!/bin/sh\nprintf '0, GPU-fixture, 00000000:01:00.0, 42\\n'\n", { mode: 0o700 });
  assert.equal((await f.validate(config)).valid, true);
  assert.equal((await f.validate({ ...config, options: { ...config.options, gpu_id: '1' } })).valid, false);
  await writeFile(provider, "#!/bin/sh\nprintf '0, GPU-fixture, 00000000:01:00.0, N/A\\n'\n");
  assert.equal((await f.validate(config)).valid, false);
});
test('unreadable watched files fail before registration', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t), file = path.join(f.work, 'metrics');
  await writeFile(file, 'private'); await chmod(file, 0);
  try { const r = await f.validate(); assert.equal(r.valid, false); assert.equal(r.errors[0].code, 'FILESYSTEM_FAILED'); }
  finally { await chmod(file, 0o600); }
});
test('recovery preflight checks goal and malformed reconfiguration preserves a live policy', async t => {
  const f = await fixture(t);
  const host = { rpc: async method => method === 'thread/loaded/list' ? { data: [f.thread] }
    : method === 'thread/goal/get' ? { goal: { status: 'paused' } } : { data: [] }, close: async () => {} };
  const recovery = new Recovery(f.thread, async () => host, () => {}, () => false); t.after(() => recovery.close());
  await recovery.configure({ enabled: true, authorization: 'Fixture authorization' });
  const before = recovery.snapshot();
  for (const config of [{ enabled: true }, { enabled: 'false' }, { enabled: true, authorization: 'Fixture', retry_rate_limits: 'false' },
    { enabled: true, authorization: 'Fixture', retry_intervl_ms: 300000 },
    { enabled: true, authorization: 'Fixture', base_delay_ms: 2000, retry_interval_ms: 1000 }]) {
    await assert.rejects(recovery.configure(config)); assert.deepEqual(recovery.snapshot(), before);
    const r = await validateRequest(f.thread, f.directory, { operation: 'recovery', config }, false);
    assert.equal(r.valid, false);
  }
  const paused = await validateRequest(f.thread, f.directory, { operation: 'recovery', config: { enabled: true, authorization: 'Fixture' } }, true, async () => host);
  assert.equal(paused.valid, false); assert.equal(paused.errors[0].code, 'HOST_FAILED');
});
test('failed automatic preflight creates no monitor or event and does not execute the command', async t => {
  const f = await fixture(t), manager = new Manager(f.directory, f.thread); t.after(() => manager.close());
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  await assert.rejects(manager.start({ ...f.config, options: { cwd: path.join(f.work, 'missing'), command: 'echo should-not-run' } }), /ENOENT/);
  assert.equal(manager.jobs.size, 0); assert.equal(Object.keys(manager.records).length, 0);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before);
});
test('real MCP publishes typed schemas, rejects typos, previews without service and returns structured failures', { timeout: 20000 }, async t => {
  const f = await fixture(t), state = path.dirname(f.directory), client = new Client({ name: 'schema-fixture', version: '1' });
  let broker;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../codex-monitor/runtime/server.js', import.meta.url))], env: { ...process.env, CODEX_MONITOR_HOME: state } }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 9);
    const startSchema = tools.find(x => x.name === 'monitor_start').inputSchema;
    const variants = startSchema.properties.options.anyOf;
    assert.ok(variants.some(x => x.properties.command)); assert.ok(variants.some(x => x.properties.gpu_util_below?.maximum === 100));
    assert.ok(variants.every(x => x.additionalProperties === false));
    assert.ok(tools.find(x => x.name === 'monitor_validate').outputSchema.properties.errors);
    const call = (name, args) => client.callTool({ name, arguments: { thread_id: f.thread, ...args } });
    const valid = await call('monitor_validate', { request: { operation: 'start', config: f.config }, check_host: false });
    assert.equal(valid.structuredContent.valid, true); assert.equal(existsSync(f.directory), false);
    const report = await call('monitor_report');
    assert.equal(report.structuredContent.type, 'monitor_report'); assert.equal(report.structuredContent.source, 'empty');
    assert.equal(existsSync(f.directory), false);
    const typo = await call('monitor_start', { ...f.config, options: { ...f.config.options, stalled_for: 100 } });
    assert.equal(typo.isError, true); assert.equal(existsSync(f.directory), false);
    broker = await ensureBroker(state);
    const bad = await call('monitor_start', { ...f.config, options: { cwd: f.work, watch_file: 'a', watch_directory: f.work } });
    assert.equal(bad.isError, true); assert.equal(bad.structuredContent.validation.valid, false);
    const started = await call('monitor_start', { ...f.config, notify_on: ['monitor_expired'] });
    assert.equal(started.structuredContent.state, 'armed'); assert.equal(started.structuredContent.kind, 'watchdog');
    const stopped = await call('monitor_stop', { monitor_id: started.structuredContent.id }); assert.equal(stopped.structuredContent.state, 'stopped');
    const status = await call('monitor_status'); assert.equal(status.structuredContent.events.length, 0);
  } finally {
    await client.close();
    for (const dir of [f.directory, broker].filter(Boolean)) { try { await rpc(dir, 'shutdown'); } catch {} }
  }
});
