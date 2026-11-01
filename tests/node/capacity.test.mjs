import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Manager } from '../../codex-monitor/runtime/manager.js';
import { monitorCapacity, CAPACITY_ERROR } from '../../codex-monitor/runtime/capacity.js';
import { summarize } from '../../codex-monitor/runtime/report.js';
import { toolResult } from '../../codex-monitor/runtime/presentation.js';
import { ensureBroker, rpc } from '../../codex-monitor/runtime/service.js';

test('capacity thresholds count reserved live slots, reuse at full and release only after cleanup', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-capacity-')), thread = randomUUID();
  const work = path.join(root, 'work'); await mkdir(work);
  let connections = 0;
  const manager = new Manager(path.join(root, 'state'), thread, { connect: async () => { connections++; throw Error('Unexpected callback'); } });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const config = i => ({ name: `observer-${i}`, options: { cwd: work, watch_file: 'metrics', timeout_ms: 60000 }, instructions: 'Inspect', notify_on: ['monitor_error', 'monitor_expired'] });
  const records = [];
  for (let i = 0; i < 23; i++) records.push(await manager.start(config(i)));
  assert.equal(records.at(-1).capacity.state, 'normal');
  const warned = await manager.start(config(23)); records.push(warned);
  assert.deepEqual(warned.capacity, monitorCapacity(24));
  assert.match(toolResult('monitor_start', warned).content[0].text, /24\/32 slots.*overlapping monitors/);
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => manager.start(config(i + 24))));
  records.push(...attempts.filter(x => x.status === 'fulfilled').map(x => x.value));
  assert.equal(records.length, 32); assert.equal(manager.jobs.size, 32);
  assert.equal(attempts.filter(x => x.status === 'rejected').length, 2);
  assert.ok(attempts.filter(x => x.status === 'rejected').every(x => x.reason.code === CAPACITY_ERROR));
  assert.equal((await manager.start(config(0))).id, records[0].id);
  manager.records[records[0].id].muted = true;
  manager.records.old = { id: 'old', name: 'history', state: 'stopped' };
  const filtered = manager.snapshot(records[0].id);
  assert.equal(filtered.monitors.length, 1); assert.equal(filtered.capacity.used, 32);
  assert.equal(summarize(filtered, 'live').capacity.used, 32);
  assert.equal(summarize(filtered, 'saved').capacity, null);
  assert.equal(summarize({ monitors: filtered.monitors }, 'live').capacity, null, 'Legacy records cannot establish slot reservations');
  const sensor = manager.jobs.get(records[1].id), stop = sensor.stop.bind(sensor);
  let release; const gate = new Promise(r => { release = r; });
  sensor.stop = async reason => { await gate; return stop(reason); };
  const stopping = manager.stop(records[1].id);
  assert.equal(manager.records[records[1].id].state, 'stopping');
  assert.equal(manager.snapshot().capacity.used, 32);
  await assert.rejects(manager.start(config(99)), error => error.code === CAPACITY_ERROR);
  release(); await stopping;
  assert.equal(manager.snapshot().capacity.used, 31);
  await manager.start(config(99)); assert.equal(manager.jobs.size, 32);
  assert.equal(Object.keys(manager.events).length, 0); assert.equal(connections, 0, 'Capacity feedback never wakes or calls the host');
});

test('MCP preserves actionable capacity errors and exposes active-only readable details', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-capacity-mcp-')), thread = randomUUID(), directory = path.join(root, thread);
  const work = path.join(root, 'work'); await mkdir(work);
  const broker = await ensureBroker(root), client = new Client({ name: 'capacity-test', version: '1' });
  const ids = [];
  t.after(async () => {
    for (const id of ids) try { await rpc(directory, 'stop', { monitor_id: id }); } catch {}
    await client.close();
    for (const dir of [directory, broker]) try { await rpc(dir, 'shutdown'); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('codex-monitor/runtime/server.js')], env: { ...process.env, CODEX_MONITOR_HOME: root } }));
  const call = (name, args = {}) => client.callTool({ name, arguments: { thread_id: thread, ...args } });
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.find(x => x.name === 'monitor_wait').inputSchema.required.includes('resume_instructions'));
  assert.deepEqual(tools.find(x => x.name === 'monitor_report').inputSchema.properties.details.enum, ['summary', 'active']);
  for (let i = 0; i < 32; i++) {
    const started = await call('monitor_start', { name: `live-${i}`, options: { cwd: work, watch_file: 'metrics', timeout_ms: 60000 }, instructions: 'Inspect' });
    assert.equal(started.isError, undefined); ids.push(started.structuredContent.id);
    if (i === 23) assert.match(started.content[0].text, /24\/32 slots/);
  }
  const rejected = await call('monitor_start', { name: 'overflow', options: { cwd: work, watch_file: 'other' }, instructions: 'Inspect' });
  assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.error.code, CAPACITY_ERROR);
  assert.equal(rejected.structuredContent.capacity.used, 32);
  assert.match(rejected.content[0].text, /limit reached \(32\/32\).*consolidate/);
  assert.match(rejected.structuredContent.guidance.join(' '), /Stopping an owned command kills/);
  const filtered = await call('monitor_status', { monitor_id: ids[0] });
  assert.equal(filtered.structuredContent.capacity.used, 32);
  await call('monitor_stop', { monitor_id: ids[0] });
  const summary = await call('monitor_report');
  assert.equal(summary.content[0].text.split('\n').length, 1);
  const details = await call('monitor_report', { details: 'active' });
  assert.equal(details.content[0].text.split('\n').length, 32);
  assert.ok(!details.content[0].text.includes('live-0 ·'));
  assert.ok(details.content[0].text.includes(ids[1]));
  assert.match(details.content[0].text, /live-1 · running · watchdog/);
  await call('monitor_display', { mode: 'verbose' });
  assert.match((await call('monitor_report')).content[0].text, /live-1 · running/);
  assert.equal((await call('monitor_report', { details: 'summary' })).content[0].text.split('\n').length, 1);
});

test('active details sanitize labels, bound output and never present saved observers as running', () => {
  const monitors = [{ id: 'live-id', name: '\u001b[31m<private>\u202e\n', kind: 'watchdog', state: 'armed', muted: true },
    { id: 'old-id', name: 'obsolete-monitor', state: 'stopped' }];
  const data = { ...summarize({ monitors }, 'live'), details: 'active' };
  const text = toolResult('monitor_report', data).content[0].text;
  assert.ok(!/[\u001b\u202e<>]/.test(text)); assert.ok(!text.includes('obsolete-monitor'));
  assert.match(text, /notifications muted/); assert.match(text, /live-id/);
  assert.equal(toolResult('monitor_report', { ...summarize({ monitors }, 'saved'), details: 'active' }).content[0].text, 'Monitor · live status unavailable');
  const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: 'active', state: 'armed', kind: 'command' }));
  const bounded = toolResult('monitor_report', { ...summarize({ monitors: many }, 'live'), details: 'active' }).content[0].text;
  assert.match(bounded, /\+8 more active monitors/);
});
