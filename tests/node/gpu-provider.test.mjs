import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startSensor, validateOptions } from '../../codex-monitor/runtime/sensors.js';

const posix = { skip: process.platform === 'win32', timeout: 15000 };
async function eventually(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) assert.fail('condition timed out'); await delay(20); }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-gpu-provider-')), sensors = [];
  const provider = path.join(root, 'nvidia-smi-fixture');
  await writeFile(provider, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(process.argv[1]), mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
fs.appendFileSync(path.join(root, 'queries'), JSON.stringify({mode, pid:process.pid, args:process.argv.slice(2)})+'\\n');
const row = value => '0, GPU-fixture, 00000000:01:00.0, '+value;
if (mode === 'hang') setInterval(()=>{},1000);
else if (mode === 'exit') { console.error('simulated driver failure'); process.exitCode = 7; }
else if (mode === 'malformed') console.log('not,csv');
else if (mode === 'duplicate') console.log(row(0)+'\\n'+row(0));
else console.log(row(({low:0,mid:15,high:80,unavailable:'N/A',missing:0})[mode]));
`, { mode: 0o755 });
  const set = async mode => { await writeFile(path.join(root, 'mode.new'), mode); await rename(path.join(root, 'mode.new'), path.join(root, 'mode')); };
  const queries = async () => { try { return (await readFile(path.join(root, 'queries'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const start = async (extra = {}) => {
    const events = []; let ended;
    const done = new Promise(resolve => { ended = resolve; });
    const sensor = startSensor('watchdog', validateOptions('watchdog', { cwd: root, nvidia_smi: provider,
      gpu_util_below: 10, gpu_recover_above: 20, gpu_below_for_ms: 150, gpu_sample_ms: 50,
      report_recovery: true, timeout_ms: 10000, ...extra }, path.join(root, 'state')), event => events.push(event), ended);
    sensors.push(sensor); await sensor.ready; return { sensor, events, done };
  };
  t.after(async () => { for (const sensor of sensors) await sensor.stop(); await rm(root, { recursive: true, force: true }); });
  return { set, queries, start };
}

test('GPU provider pipeline deduplicates stalls, preserves unknown state and rearms after recovery', posix, async t => {
  const { set, queries, start } = await fixture(t);
  await set('low'); const { events, sensor } = await start();
  const count = type => events.filter(e => e.event_type === type).length;
  await eventually(() => count('watchdog_stalled') === 1);
  assert.ok(events[0].conditions.gpu_low.duration_ms >= 150);
  await set('mid'); await eventually(async () => (await queries()).filter(q => q.mode === 'mid').length >= 3);
  assert.equal(count('watchdog_recovered'), 0); assert.equal(count('watchdog_stalled'), 1);
  await set('unavailable'); await eventually(async () => (await queries()).filter(q => q.mode === 'unavailable').length >= 3);
  assert.equal(count('monitor_error'), 1); assert.equal(events.find(e => e.event_type === 'monitor_error').health, 'unknown');
  assert.equal(count('watchdog_recovered'), 0);
  const before = (await queries()).filter(q => q.mode === 'low').length;
  await set('low'); await eventually(async () => (await queries()).filter(q => q.mode === 'low').length >= before + 4);
  assert.equal(count('watchdog_stalled'), 1); assert.equal(count('watchdog_recovered'), 0);
  await set('high'); await eventually(() => count('watchdog_recovered') === 1);
  await set('low'); await eventually(() => count('watchdog_stalled') === 2);
  await sensor.stop();
  assert.deepEqual(events.map(e => e.event_type), ['watchdog_stalled', 'monitor_error', 'watchdog_recovered', 'watchdog_stalled']);
  for (const query of await queries()) {
    assert.ok(query.args.includes('--query-gpu=index,uuid,pci.bus_id,utilization.gpu'));
    assert.ok(query.args.includes('--id=0'));
  }
});

test('malformed, duplicate, missing GPU rows and driver exit are sensor errors, never zero utilization', posix, async t => {
  const { set, start } = await fixture(t);
  for (const mode of ['malformed', 'duplicate', 'missing', 'exit']) {
    await set(mode);
    const { events, done } = await start({ max_events: 1, gpu_id: mode === 'missing' ? '0,1' : '0' });
    await done;
    assert.deepEqual(events.map(e => e.event_type), ['monitor_error'], mode);
    assert.equal(events[0].health, 'unknown', mode); assert.equal(events[0].sensor, 'gpu', mode);
  }
});

test('cancellation and monitor deadline terminate a hung GPU query promptly', posix, async t => {
  const { set, queries, start } = await fixture(t); await set('hang');
  for (const action of ['cancel', 'deadline']) {
    const before = (await queries()).length;
    const { sensor, events, done } = await start({ timeout_ms: action === 'cancel' ? 10000 : 1000 });
    await eventually(async () => (await queries()).length > before);
    const pid = (await queries()).at(-1).pid, at = performance.now();
    if (action === 'cancel') await sensor.stop();
    const result = await done;
    assert.ok(performance.now() - at < 4000, 'must not wait for the 10-second provider timeout');
    assert.equal(result.reason, action === 'cancel' ? 'cancelled' : 'deadline');
    assert.deepEqual(events.map(e => e.event_type), action === 'cancel' ? [] : ['monitor_expired']);
    await eventually(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
  }
});
