import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, rename, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureService, rpc } from '../../codex-monitor/runtime/service.js';
import { startSensor, validateOptions } from '../../codex-monitor/runtime/sensors.js';
import { Health, parseGpu } from '../../codex-monitor/runtime/health.js';
import { capture } from '../../codex-monitor/runtime/processes.js';
import { FileObservations } from '../../codex-monitor/runtime/file-observations.js';

async function eventually(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) assert.fail('condition timed out'); await delay(20); }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-edges-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, cleanups };
}

test('local RPC preserves Unicode split across HTTP chunks', { timeout: 10000 }, async t => {
  const { root, cleanups } = await fixture(t), directory = await ensureService(randomUUID(), path.join(root, 'state'));
  cleanups.push(async () => {
    const status = await rpc(directory, 'status');
    for (const monitor of status.monitors) await rpc(directory, 'stop', { monitor_id: monitor.id });
    await rpc(directory, 'shutdown');
    await eventually(() => !existsSync(path.join(directory, 'endpoint.json')));
  });
  const endpoint = JSON.parse(await readFile(path.join(directory, 'endpoint.json'), 'utf8'));
  const params = { name: '训练😀', kind: 'watchdog', instructions: '检查中文路径', notify_on: ['monitor_expired'],
    options: { cwd: root, watch_file: 'metrics', timeout_ms: 8000 } };
  const body = Buffer.from(JSON.stringify({ method: 'start', params }));
  const split = body.indexOf(Buffer.from('训')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: endpoint.port, path: '/rpc', method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' } }, res => {
      res.setEncoding('utf8'); let response = '';
      res.on('data', data => { response += data; });
      res.on('end', () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    void delay(60).then(() => { req.write(body.subarray(split, split + 1)); return delay(60); })
      .then(() => req.end(body.subarray(split + 1))).catch(reject);
  });
  assert.equal(result.error, undefined);
  assert.equal(result.result.name, params.name);
  assert.equal(result.result.instructions, params.instructions);
  assert.equal(result.result.state, 'armed');
  const url = `http://127.0.0.1:${endpoint.port}/rpc`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  const headers = { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' };
  assert.match((await (await fetch(url, { method: 'POST', headers, body: '{' })).json()).error, /JSON|property|Unexpected/i);
  const overhead = Buffer.byteLength(JSON.stringify({ method: 'status', padding: '' }));
  const padded = size => JSON.stringify({ method: 'status', padding: '中'.repeat(Math.floor((size - overhead) / 3)) + ' '.repeat((size - overhead) % 3) });
  assert.equal(Buffer.byteLength(padded(65536)), 65536);
  assert.equal((await (await fetch(url, { method: 'POST', headers, body: padded(65536) })).json()).result.thread_id, path.basename(directory));
  try {
    const oversized = await (await fetch(url, { method: 'POST', headers, body: padded(65537) })).json();
    assert.match(oversized.error, /too large/);
  } catch (error) {
    // Node may close the request socket when its async iterator rejects input.
    assert.ok(['ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code), String(error));
  }
  assert.equal((await rpc(directory, 'status')).monitors.length, 1);
});

test('command debounce retains distinct matching lines and suppresses identical repeats', async t => {
  const { root, cleanups } = await fixture(t), script = path.join(root, 'emit.cjs'), events = [];
  await writeFile(script, "console.log('MATCH first\\nMATCH first\\nMATCH second');");
  let ended; const done = new Promise(resolve => { ended = resolve; });
  const sensor = startSensor('command', validateOptions('command', {
    cwd: root, command: `"${process.execPath}" "${script}"`, match: '^MATCH', debounce_ms: 10000, timeout_ms: 5000,
  }, path.join(root, 'state')), event => events.push(event), ended);
  cleanups.push(() => sensor.stop()); await sensor.ready; await done;
  assert.deepEqual(events.filter(e => e.event_type === 'command_output').map(e => e.event), ['MATCH first', 'MATCH second']);
  assert.equal(events.at(-1).event_type, 'command_exit');
});

for (const backend of ['native', 'polling']) {
  test(`debounced ${backend} file changes still reset inactivity`, async t => {
    const { root, cleanups } = await fixture(t), file = path.join(root, 'metrics'), events = [], progress = [];
    await writeFile(file, 'initial');
    const original = Health.prototype.progress;
    t.mock.method(Health.prototype, 'progress', function(at) { progress.push(at); return original.call(this, at); });
    const sensor = startSensor('watchdog', validateOptions('watchdog', {
      cwd: root, watch_file: file, file_backend: backend, poll_ms: 20,
      debounce_ms: 10000, stalled_for_ms: 3000, timeout_ms: 8000,
    }, path.join(root, 'state')), event => events.push(event), () => {});
    cleanups.push(() => sensor.stop()); await sensor.ready;
    await writeFile(file, 'first update'); await eventually(() => progress.length >= 1);
    await delay(100); const before = progress.length;
    await writeFile(file, 'second longer update'); await eventually(() => progress.length > before, 1000);
    assert.equal(events.filter(e => e.event_type === 'file_change').length, 1);
    assert.equal(events.some(e => e.event_type === 'watchdog_stalled'), false);
  });
}

test('registration rejects a non-directory cwd and a directory watch_file', async t => {
  const { root, cleanups } = await fixture(t), file = path.join(root, 'file'), directory = path.join(root, 'folder');
  await writeFile(file, 'data'); await mkdir(directory);
  for (const options of [{ cwd: file, watch_file: path.join(root, 'metrics') }, { cwd: root, watch_file: directory }]) {
    const sensor = startSensor('watchdog', validateOptions('watchdog', { ...options, timeout_ms: 5000 }, path.join(root, 'state')), () => {}, () => {});
    try { await assert.rejects(sensor.ready, /directory|regular file/i); }
    finally { await sensor.stop(); }
  }
  const events = [];
  const sensor = startSensor('watchdog', validateOptions('watchdog', { cwd: root, watch_file: file, timeout_ms: 5000 }, path.join(root, 'state')),
    event => events.push(event), () => {});
  cleanups.push(() => sensor.stop()); await sensor.ready;
  await rm(file); await mkdir(file);
  await eventually(() => events.some(event => event.event_type === 'monitor_error' && /regular file/.test(event.error)));
});

test('concurrent service registration reuses a single observer', { timeout: 15000 }, async t => {
  const { root, cleanups } = await fixture(t), thread = randomUUID();
  const directory = path.join(root, thread);
  cleanups.push(async () => {
    if (existsSync(path.join(directory, 'endpoint.json'))) await rpc(directory, 'shutdown');
    await eventually(() => !existsSync(path.join(directory, 'endpoint.json')));
  });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => ensureService(thread, root)));
  for (const result of results) {
    assert.equal(result.status, 'fulfilled', String(result.reason)); assert.equal(result.value, directory);
  }
  assert.equal((await rpc(directory, 'status')).thread_id, thread);
});

test('capture bounds output, deadline, cancellation and failed startup', async () => {
  assert.equal(await capture(process.execPath, ['-e', "process.stdout.write('x'.repeat(64000))"]), 'x'.repeat(64000));
  await assert.rejects(capture(process.execPath, ['-e', "process.stdout.write('x'.repeat(70000))"]), /exceeded limit/);
  await assert.rejects(capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, 80), /timed out/);
  const abort = new AbortController();
  const running = capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, 3000, abort.signal);
  abort.abort(); await assert.rejects(running, /cancelled/);
  await assert.rejects(capture(path.join(tmpdir(), 'missing-monitor-executable-' + randomUUID()), []));
});

test('missing GPU provider is unknown once and never a low-utilization event', async t => {
  const { root, cleanups } = await fixture(t), events = [];
  let ended; const done = new Promise(resolve => { ended = resolve; });
  const sensor = startSensor('watchdog', validateOptions('watchdog', {
    cwd: root, nvidia_smi: path.join(root, 'missing-nvidia-smi'), gpu_util_below: 100,
    gpu_below_for_ms: 10, gpu_sample_ms: 50, timeout_ms: 600,
  }, path.join(root, 'state')), event => events.push(event), ended);
  cleanups.push(() => sensor.stop()); await sensor.ready; await done;
  assert.deepEqual(events.map(e => e.event_type), ['monitor_error', 'monitor_expired']);
  assert.equal(events[0].sensor, 'gpu'); assert.equal(events[0].health, 'unknown');
});

test('GPU warmup, exact dwell and hysteresis survive unknown samples', () => {
  const health = new Health({ gpu_util_below: 10, gpu_recover_above: 20, gpu_below_for_ms: 100, warmup_ms: 100 }, 0);
  health.gpu(99, { a: 0 }); assert.equal(health.tick(99), undefined);
  health.gpu(100, { a: 0 }); health.gpu(199, { a: 0 }); assert.equal(health.tick(199), undefined);
  health.gpu(200, { a: 0 }); assert.equal(health.tick(200).event_type, 'watchdog_stalled');
  health.gpu(210, { a: 10 }); assert.equal(health.tick(210), undefined);
  health.gpuUnknown(); assert.equal(health.tick(220), undefined);
  health.gpu(230, { a: 19 }); assert.equal(health.tick(230), undefined);
  health.gpu(240, { a: 20 }); assert.equal(health.tick(240).event_type, 'watchdog_recovered');
  health.gpu(250, { a: 0 }); health.gpu(349, { a: 0 }); assert.equal(health.tick(349), undefined);
  health.gpu(350, { a: 0 }); assert.equal(health.tick(350).event_type, 'watchdog_stalled');
});

test('file/GPU and per-card aggregation distinguish all from any', () => {
  for (const dead_if of ['all', 'any']) {
    for (const gpu_match of ['all', 'any']) {
      const health = new Health({ stalled_for_ms: 100, gpu_util_below: 10, gpu_recover_above: 20, gpu_below_for_ms: 100, dead_if, gpu_match }, 0);
      health.gpu(0, { a: 0, b: 100 }); health.gpu(100, { a: 0, b: 100 });
      const expected = dead_if === 'any' || gpu_match === 'any';
      assert.equal(health.tick(100)?.event_type, expected ? 'watchdog_stalled' : undefined);
      health.progress(101);
      const recovered = expected && (dead_if === 'all' || gpu_match === 'all');
      assert.equal(health.tick(101)?.event_type, recovered ? 'watchdog_recovered' : undefined);
    }
  }
});

test('GPU CSV rejects empty, unavailable, duplicate, missing and out-of-range samples', () => {
  const row = value => `0, GPU-a, 00000000:01:00.0, ${value}`;
  for (const value of ['', 'N/A', 'NaN', 'Infinity', '-1', '101']) assert.throws(() => parseGpu(row(value), 'all'));
  for (const output of ['', row(0) + '\n' + row(0), row(0) + '\n1, GPU-a, 00000000:02:00.0, 0', '0, GPU-a, 0']) {
    assert.throws(() => parseGpu(output, 'all'));
  }
  for (const selector of ['0', '00', 'GPU-A', '0000:01:00.0', '00000000:01:00.0', 'all']) {
    assert.deepEqual(parseGpu(row(100), selector), { 'gpu-a': 100 });
  }
  assert.throws(() => parseGpu(row(0), '0,1'), /missing/);
});

for (const backend of ['native', 'polling']) {
  for (const recursive of [false, true]) {
    test(`${backend} directory watch respects recursion, pattern and initial files (${recursive})`, async t => {
      const { root, cleanups } = await fixture(t), work = path.join(root, 'work'), events = [];
      await mkdir(path.join(work, 'nested'), { recursive: true }); await writeFile(path.join(work, 'existing.ckpt'), 'old');
      const sensor = startSensor('watchdog', validateOptions('watchdog', {
        cwd: root, watch_directory: work, recursive, pattern: '*.ckpt', file_backend: backend,
        poll_ms: 20, timeout_ms: 5000, debounce_ms: 0,
      }, path.join(root, 'state')), event => events.push(event), () => {});
      cleanups.push(() => sensor.stop()); await sensor.ready;
      assert.equal(events.length, 0);
      await writeFile(path.join(work, 'nested', 'deep.ckpt'), 'deep');
      await writeFile(path.join(work, 'ignored.txt'), 'ignored');
      await writeFile(path.join(work, 'top.ckpt'), 'top');
      await eventually(() => events.some(e => e.path === path.join(work, 'top.ckpt')));
      if (recursive) await eventually(() => events.some(e => e.path === path.join(work, 'nested', 'deep.ckpt')));
      else await delay(120);
      assert.equal(events.some(e => e.path?.endsWith('deep.ckpt')), recursive);
      assert.equal(events.some(e => e.path?.endsWith('ignored.txt') || e.path?.endsWith('existing.ckpt')), false, JSON.stringify(events));
      assert.equal(events.some(e => e.event_type === 'monitor_error'), false);
    });
  }
}

test('the same file in bigint and number stats is not a new observation', async t => {
  const { root } = await fixture(t), file = path.join(root, 'metrics');
  await writeFile(file, 'old');
  const observations = new FileObservations();
  observations.remember(file, await stat(file, { bigint: true }));
  assert.equal(observations.accept('change', file, await stat(file)), false);
  assert.equal(observations.accept('add', file, await stat(file, { bigint: true })), false);
  // Replacing an entry is observable even with equal size and preserved mtime.
  const original = await stat(file), replacement = path.join(root, 'replacement');
  await writeFile(replacement, 'new');
  await utimes(replacement, original.atime, original.mtime);
  await rename(replacement, file);
  assert.equal(observations.accept('change', file, await stat(file)), true);
  assert.equal(observations.accept('change', file, await stat(file, { bigint: true })), false);
});

for (const backend of ['native', 'polling']) {
  test(`${backend} startup echoes never reset training inactivity`, async t => {
    const { root, cleanups } = await fixture(t), file = path.join(root, 'metrics'), events = [], progress = [];
    await writeFile(file, 'old');
    const original = Health.prototype.progress;
    t.mock.method(Health.prototype, 'progress', function(at) { progress.push(at); return original.call(this, at); });
    const sensor = startSensor('watchdog', validateOptions('watchdog', {
      cwd: root, watch_file: file, file_backend: backend, poll_ms: 20, timeout_ms: 5000,
      stalled_for_ms: 200, debounce_ms: 0,
    }, path.join(root, 'state')), event => events.push(event), () => {});
    cleanups.push(() => sensor.stop()); await sensor.ready;
    await eventually(() => events.some(e => e.event_type === 'watchdog_stalled'));
    assert.deepEqual(progress, [], JSON.stringify(events));
    assert.equal(events.some(e => e.event_type === 'file_change'), false, JSON.stringify(events));
    // Equal-length writes still count as progress and reach the user.
    await writeFile(file, 'new');
    await eventually(() => progress.length > 0 && events.some(e => e.event_type === 'file_change'));
  });

  test(`${backend} ready accepts immediate nested creates, rewrites and replacements`, async t => {
    const { root, cleanups } = await fixture(t);
    let trace = [];
    const originalRemember = FileObservations.prototype.remember;
    t.mock.method(FileObservations.prototype, 'remember', function(file, stats) {
      trace.push({ initial: file, stats });
      return originalRemember.call(this, file, stats);
    });
    // Exercise the first subscription tick, which previously raced a directory rescan.
    for (let attempt = 0; attempt < (backend === 'polling' ? 200 : 6); attempt++) {
      const work = path.join(root, String(attempt)), nested = path.join(work, 'nested'), events = [];
      await mkdir(nested, { recursive: true });
      const existing = path.join(work, 'existing.ckpt'), created = path.join(nested, 'new.ckpt');
      await writeFile(existing, 'old');
      const before = await stat(nested);
      trace = [];
      const sensor = startSensor('watchdog', validateOptions('watchdog', {
        cwd: root, watch_directory: work, recursive: true, pattern: '*.ckpt', file_backend: backend,
        poll_ms: 20, timeout_ms: 10000, debounce_ms: 0,
      }, path.join(root, 'state')), event => events.push(event), () => {});
      cleanups.push(() => sensor.stop()); await sensor.ready;
      await writeFile(created, 'created');
      await writeFile(existing, 'new');
      const after = await stat(nested);
      try {
        await eventually(() => [created, existing].every(file => events.some(e => e.path === file)));
        events.length = 0;
        const replacement = path.join(work, 'replacement');
        await writeFile(replacement, 'replacement'); await rename(replacement, existing);
        await eventually(() => events.some(e => e.path === existing && ['created', 'modified'].includes(e.change)));
        events.length = 0;
        await rm(existing);
        await eventually(() => events.some(e => e.path === existing && e.change === 'deleted'));
        events.length = 0;
        await writeFile(existing, 'new');
        await eventually(() => events.some(e => e.path === existing && e.change === 'created'));
      } catch (error) { t.diagnostic(JSON.stringify({ attempt, events, before, after, trace, current: await stat(existing).catch(() => null) }, (_key, value) => typeof value === 'bigint' ? String(value) : value)); throw error; }
      finally { await sensor.stop(); }
    }
  });
}
