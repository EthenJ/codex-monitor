import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureBroker, ensureService, rpc } from '../../codex-monitor/runtime/service.js';
import { Bridge, codexExecutable, submit } from '../../codex-monitor/runtime/bridge.js';
import { owned, capture } from '../../codex-monitor/runtime/processes.js';

async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) assert.fail('condition timed out'); await new Promise(r => setTimeout(r, 30)); }
}
test('MCP disconnect/reconnect retains observer and launcher identity', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-mcp-')), state = path.join(root, 'state');
  const thread = randomUUID(), directory = path.join(state, thread); let client;
  async function open() {
    client = new Client({ name: 'fixture', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../../codex-monitor/runtime/server.js', import.meta.url))],
      env: { ...process.env, CODEX_MONITOR_HOME: state } }));
    return client;
  }
  try {
    const broker = await ensureBroker(state), original = await rpc(broker, 'status');
    assert.equal(await ensureBroker(state), broker); assert.equal((await rpc(broker, 'status')).service_pid, original.service_pid);
    await open(); const tools = await client.listTools(); assert.equal(tools.tools.length, 7);
    const result = await client.callTool({ name: 'monitor_start', arguments: { thread_id: thread, name: 'survival', kind: 'watchdog',
      options: { cwd: root, watch_file: path.join(root, 'metrics'), timeout_ms: 15000 }, instructions: 'Fixture', notify_on: ['monitor_expired'] } });
    assert.equal(result.isError, undefined, JSON.stringify(result)); const monitor = result.structuredContent; assert.equal(monitor.state, 'armed');
    await client.close(); await open();
    const status = await client.callTool({ name: 'monitor_status', arguments: { thread_id: thread } });
    assert.equal(status.structuredContent.monitors[0].id, monitor.id); assert.equal(status.structuredContent.monitors[0].state, 'armed');
    const stop = await client.callTool({ name: 'monitor_stop', arguments: { thread_id: thread, monitor_id: monitor.id } });
    assert.equal(stop.structuredContent.state, 'stopped');
    await client.close(); client = undefined;
    await rpc(directory, 'shutdown'); await rpc(broker, 'shutdown');
    await eventually(() => !existsSync(path.join(directory, 'endpoint.json')) && !existsSync(path.join(broker, 'endpoint.json')));
  } finally {
    await client?.close();
    for (const dir of [directory, path.join(state, 'broker')]) { try { await rpc(dir, 'shutdown'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
test('forced owned guardian termination cleans its command descendants', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-owned-'));
  const output = path.join(root, 'pid');
  const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(output)},String(p.pid));setInterval(()=>{},1000);`;
  const p = await owned(process.execPath, ['-e', source]);
  try {
    await eventually(() => existsSync(output));
    const pid = Number(await readFile(output, 'utf8'));
    // On POSIX the guardian's graceful signal handler owns group cleanup. SIGKILL
    // cannot execute cleanup; Windows kernel Job Objects additionally cover that.
    p.process.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM'); await p.done;
    await eventually(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
  } finally { await p.stop(); await rm(root, { recursive: true, force: true }); }
});
test('native App Server accepts tool output and preserves goal lifecycle', { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-native-'));
  await writeFile(path.join(root, 'config.toml'), 'model_provider="probe"\nmodel="probe"\n[model_providers.probe]\nname="Offline fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
  const bridge = await Bridge.connect({ command: codexExecutable(), args: ['app-server', '--stdio'], jsonl: true, env: { ...process.env, CODEX_HOME: root } });
  try {
    const thread = (await bridge.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
    await bridge.rpc('thread/goal/set', { threadId: thread, objective: 'Fixture only', tokenBudget: 1000, status: 'active', origin: 'user' });
    const paused = (await bridge.rpc('thread/goal/set', { threadId: thread, status: 'paused', origin: 'user' })).goal;
    assert.equal(paused.status, 'paused'); assert.equal(paused.tokenBudget, 1000);
    const result = await submit(bridge, thread, { event_id: randomUUID(), type: 'monitor_events', evidence: 'Fixture only' });
    assert.equal(result.turn.status, 'inProgress');
    await bridge.rpc('turn/interrupt', { threadId: thread, turnId: result.turn.id });
    await bridge.rpc('thread/goal/clear', { threadId: thread });
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test('observer survives forced cleanup of a strict Windows MCP host job', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-strict-job-')), state = path.join(root, 'state');
  const thread = randomUUID(), directory = path.join(state, thread), broker = await ensureBroker(state);
  try {
    const output = await capture(process.execPath, [fileURLToPath(new URL('./fixtures/job-client.mjs', import.meta.url)),
      fileURLToPath(new URL('../../codex-monitor/runtime/server.js', import.meta.url)), thread, root],
      { env: { ...process.env, CODEX_MONITOR_HOME: state } });
    const result = JSON.parse(output); assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.state, 'armed');
    const snapshot = await rpc(directory, 'status'); assert.equal(snapshot.monitors[0].state, 'armed');
    assert.equal(snapshot.monitors[0].id, result.structuredContent.id);
    await rpc(directory, 'stop', { monitor_id: snapshot.monitors[0].id });
  } finally {
    for (const dir of [directory, broker]) { try { await rpc(dir, 'shutdown'); } catch {} }
    await eventually(() => !existsSync(path.join(directory, 'endpoint.json')) && !existsSync(path.join(broker, 'endpoint.json')));
    await rm(root, { recursive: true, force: true });
  }
});

test('external Windows broker launches observers without a second job breakaway', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-job-broker-')), state = path.join(root, 'state');
  const thread = randomUUID(), directory = path.join(state, thread), broker = path.join(state, 'broker');
  const launcher = await owned(process.execPath, [fileURLToPath(new URL('./fixtures/job-broker.mjs', import.meta.url)), broker]);
  try {
    await eventually(() => existsSync(path.join(broker, 'endpoint.json')));
    assert.equal(await ensureService(thread, state), directory);
    assert.equal((await rpc(directory, 'status')).thread_id, thread);
  } finally {
    for (const dir of [directory, broker]) { try { await rpc(dir, 'shutdown'); } catch {} }
    await launcher.stop(); await rm(root, { recursive: true, force: true });
  }
});

test('malformed proxy output stops the abandoned transport process', { timeout: 10000 }, async () => {
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='break'){console.log('invalid-json');return;}if(m.id)console.log(JSON.stringify({id:m.id,result:{pid:process.pid}}));});setInterval(()=>{},1000);`;
  const bridge = await Bridge.connect({ command: process.execPath, args: ['-e', script], jsonl: true });
  try {
    const { pid } = await bridge.rpc('pid', {});
    await assert.rejects(bridge.rpc('break', {}), /Invalid Codex JSON/);
    await eventually(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
  } finally { await bridge.close(); }
});
