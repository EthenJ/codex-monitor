import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capture } from '../../codex-monitor/runtime/processes.js';
import { Health, parseGpu } from '../../codex-monitor/runtime/health.js';
import { startSensor, validateOptions } from '../../codex-monitor/runtime/sensors.js';

test('live NVIDIA selection and quiet monitoring preserve existing workloads', {
  skip: process.env.CODEX_MONITOR_TEST_GPU !== '1', timeout: 20000,
}, async t => {
  const provider = process.env.CODEX_MONITOR_NVIDIA_SMI || 'nvidia-smi';
  const args = ['--query-gpu=index,uuid,pci.bus_id,utilization.gpu', '--format=csv,noheader,nounits'];
  const output = await capture(provider, args), all = parseGpu(output, 'all');
  const rows = output.trim().split(/\r?\n/).map(row => row.split(',').map(value => value.trim()));
  t.diagnostic(`Read ${rows.length} NVIDIA device(s); utilization ${Object.values(all).join(', ')}%. No workload started or signalled.`);
  for (const row of rows) {
    for (const selector of row.slice(0, 3)) {
      const selected = parseGpu(await capture(provider, [...args, `--id=${selector}`]), selector);
      assert.deepEqual(Object.keys(selected), [row[1].toLowerCase()]);
    }
  }
  const selectors = rows.map(row => row[0]).join(',');
  assert.deepEqual(Object.keys(parseGpu(await capture(provider, [...args, `--id=${selectors}`]), selectors)).sort(), Object.keys(all).sort());
  await assert.rejects(capture(provider, [...args, '--id=GPU-00000000-0000-0000-0000-000000000000']));

  const root = await mkdtemp(path.join(tmpdir(), 'monitor-live-gpu-')), events = [], samples = [];
  const original = Health.prototype.gpu;
  t.mock.method(Health.prototype, 'gpu', function(at, values) { samples.push(values); return original.call(this, at, values); });
  let ended; const done = new Promise(resolve => { ended = resolve; });
  const sensor = startSensor('watchdog', validateOptions('watchdog', {
    cwd: root, nvidia_smi: provider, gpu_id: 'all', gpu_util_below: 0,
    gpu_below_for_ms: 100, gpu_sample_ms: 100, timeout_ms: 1800, report_recovery: true,
  }, path.join(root, 'state')), event => events.push(event), ended);
  try {
    await sensor.ready;
    const outcome = await done;
    assert.equal(outcome.reason, 'deadline'); assert.ok(samples.length >= 2, 'multiple successful real samples required');
    assert.deepEqual(events.map(e => e.event_type), ['monitor_expired']);
    for (const sample of samples) assert.deepEqual(Object.keys(sample).sort(), Object.keys(all).sort());
    t.diagnostic(`${samples.length} successful GPU samples, no false stall/recovery or sensor errors, finite expiry.`);
  } finally { await sensor.stop(); await rm(root, { recursive: true, force: true }); }
});
