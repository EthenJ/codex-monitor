import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { summarize, readReport, reportSchema } from '../../codex-monitor/runtime/report.js';
import { stopReport } from '../../codex-monitor/runtime/stop-report.js';
import { ensureBroker, ensureService, rpc } from '../../codex-monitor/runtime/service.js';
import { owned } from '../../codex-monitor/runtime/processes.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-report-')), thread = randomUUID();
  t.after(() => rm(root, { recursive: true, force: true })); return { root, thread, directory: path.join(root, thread) };
}
test('report has bounded structured fields and omits instructions, evidence and authorization', () => {
  const snapshot = { thread_id: randomUUID(), monitors: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: 'test', state: i === 99 ? 'armed' : 'stopped', instructions: 'SECRET' })),
    events: Array.from({ length: 20 }, (_, i) => ({ id: String(i), state: 'submitted', event_type: 'file_change', evidence: 'SECRET' })),
    wait: { state: 'waiting', authorization: 'SECRET', instructions: 'SECRET' },
    recovery: { enabled: true, state: 'observing', authorization: 'SECRET', policy: { retry_interval_ms: 300000 } } };
  const r = summarize(snapshot, 'live'); reportSchema.parse(r);
  assert.equal(r.monitors.length, 32); assert.equal(r.monitors[0].id, '99');
  assert.equal(r.summary.active, 1); assert.equal(r.summary.unhandled_events, 20);
  assert.equal(r.events.length, 8); assert.equal(r.omitted.events, 12);
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.equal(r.recovery.stop.enabled, false);
});
test('report with no service never creates state, hooks never block or continue a turn', async t => {
  const f = await fixture(t);
  for (const event of ['Stop', 'Interrupt']) {
    const output = await stopReport({ session_id: f.thread, hook_event_name: event, turn_id: 'fixture' }, f.root);
    assert.deepEqual(Object.keys(output), ['systemMessage']);
    const payload = JSON.parse(output.systemMessage); assert.equal(payload.tool, 'monitor_report');
    assert.equal(payload.result.source, 'empty'); assert.equal(payload.result.summary.active, 0);
    assert.equal(existsSync(f.directory), false);
  }
  await assert.rejects(stopReport({ session_id: '../other', hook_event_name: 'Stop' }, f.root));
});
test('stale service snapshots are unverified; corrupt or wrong-session state is unavailable', async t => {
  const f = await fixture(t); await mkdir(f.directory);
  const file = path.join(f.directory, 'state.json');
  const state = { thread_id: f.thread, monitors: { m: { name: 'old', state: 'armed' } }, recovery: { enabled: true, state: 'observing' } };
  await writeFile(file, JSON.stringify(state));
  const before = await readFile(file, 'utf8'); const r = await readReport(f.thread, f.root);
  assert.equal(r.verified, false); assert.equal(r.source, 'saved'); assert.ok(r.warnings.length);
  assert.equal(await readFile(file, 'utf8'), before); assert.equal(existsSync(path.join(f.directory, 'endpoint.json')), false);
  await writeFile(file, '{bad'); assert.equal((await readReport(f.thread, f.root)).source, 'unavailable');
  await writeFile(file, JSON.stringify({ ...state, thread_id: randomUUID() }));
  assert.equal((await readReport(f.thread, f.root)).source, 'unavailable');
});
test('live report reflects service without launching commands, events or recovery', async t => {
  const f = await fixture(t), broker = await ensureBroker(f.root);
  try {
    await ensureService(f.thread, f.root);
    const r = await readReport(f.thread, f.root); reportSchema.parse(r);
    assert.equal(r.source, 'live'); assert.equal(r.verified, true); assert.equal(r.recovery.enabled, false);
    assert.equal(r.summary.active, 0); assert.equal(r.summary.unhandled_events, 0);
  } finally {
    await rpc(f.directory, 'shutdown'); await rpc(broker, 'shutdown');
  }
});
test('standalone hook outputs valid informational JSON for supported and malformed input', async t => {
  const f = await fixture(t);
  for (const input of [JSON.stringify({ session_id: f.thread, hook_event_name: 'Stop', turn_id: 'fixture' }), 'not JSON']) {
    const child = await owned(process.execPath, [fileURLToPath(new URL('../../codex-monitor/runtime/stop-report.js', import.meta.url))], { env: { ...process.env, CODEX_MONITOR_HOME: f.root } });
    let output = ''; child.process.stdout.on('data', chunk => { output += chunk; }); child.process.stderr.resume();
    child.process.stdin.end(input); assert.equal((await child.done).code, 0);
    const json = JSON.parse(output); assert.deepEqual(Object.keys(json), ['systemMessage']);
    assert.ok(!output.includes('decision')); assert.equal(existsSync(f.directory), false);
  }
});
