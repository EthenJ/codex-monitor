// Read-only hardware probe: values come from the real nvidia-smi subprocess.
// A diagnostic threshold crossing is not evidence that training has stalled.
import { parseArgs } from 'node:util';
import { startSensor, validateOptions } from '../codex-monitor/runtime/sensors.js';
import { Health } from '../codex-monitor/runtime/health.js';

const { values } = parseArgs({ options: {
  'gpu-id': { type: 'string', default: 'all' },
  'gpu-match': { type: 'string', default: 'any' },
  below: { type: 'string', default: '10' },
  recover: { type: 'string', default: '20' },
  'dwell-ms': { type: 'string', default: '1000' },
  'sample-ms': { type: 'string', default: '200' },
  'timeout-ms': { type: 'string', default: '60000' },
} });
const options = validateOptions('watchdog', {
  cwd: process.cwd(), gpu_id: values['gpu-id'], gpu_match: values['gpu-match'],
  gpu_util_below: Number(values.below), gpu_recover_above: Number(values.recover),
  gpu_below_for_ms: Number(values['dwell-ms']), gpu_sample_ms: Number(values['sample-ms']),
  timeout_ms: Number(values['timeout-ms']), warmup_ms: 300, report_recovery: true,
  ...(process.env.CODEX_MONITOR_NVIDIA_SMI ? { nvidia_smi: process.env.CODEX_MONITOR_NVIDIA_SMI } : {}),
}, process.cwd());
if (options.timeout_ms > 120000 || options.gpu_sample_ms < 50) throw Error('Probe limits: timeout <= 120000 ms, sampling >= 50 ms');
const events = [], start = performance.now(); let samples = 0;
const record = value => console.log(JSON.stringify({ elapsed_ms: performance.now() - start, ...value }));
const original = Health.prototype.gpu;
Health.prototype.gpu = function(at, utilization) {
  samples++; record({ type: 'sample', utilization });
  return original.call(this, at, utilization);
};
let ended; const done = new Promise(resolve => { ended = resolve; });
const sensor = startSensor('watchdog', options, event => {
  events.push(event); record({ type: 'event', event });
  if (event.event_type === 'watchdog_recovered' && events.some(e => e.event_type === 'watchdog_stalled')) {
    setImmediate(() => void sensor.stop('cycle_observed'));
  }
}, ended);
const interrupt = () => { void sensor.stop('cancelled'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await sensor.ready;
  record({ type: 'armed', options, note: 'Read-only diagnostic probe. No workload is started or signalled.' });
  const outcome = await done;
  const cycle = events.some(e => e.event_type === 'watchdog_stalled') && events.some(e => e.event_type === 'watchdog_recovered');
  const failed = events.some(e => e.event_type === 'monitor_error');
  const state = failed ? 'failed' : cycle ? 'passed' : 'inconclusive';
  record({ type: 'result', state, outcome, sample_count: samples, events,
    note: 'A threshold cycle does not prove a real training stall. No observed cycle is inconclusive, not a pass.' });
  process.exitCode = failed ? 1 : cycle ? 0 : 2;
} finally {
  await sensor.stop(); Health.prototype.gpu = original;
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
