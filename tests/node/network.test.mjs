import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge, latestTurn } from '../../codex-monitor/runtime/bridge.js';
import { Recovery } from '../../codex-monitor/runtime/recovery.js';

function recoveryRequests(f) {
  return f.state.requests.filter(request => {
    const input = JSON.parse(request.body).input;
    return Array.isArray(input) && input.some(item =>
      ['custom_tool_call_output', 'function_call_output'].includes(item.type) &&
      JSON.stringify(item).includes('Recovery ID:'));
  });
}

async function until(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw Error('Network fixture condition timed out'); await new Promise(r => setTimeout(r, 30)); }
}
function successfulStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture done.', annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture done.' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'Fixture done.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  events.forEach((e, i) => res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`)); res.end();
}
async function fixture(t, config = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-network-'));
  const state = { mode: 'error', calls: 0, requests: [], sockets: new Set() };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    state.calls++; state.requests.push({ path: req.url, body });
    if (state.mode === 'error') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'server_error', message: 'Injected temporary outage', code: 'server_error' } })); }
    else if (state.mode === 'disconnect') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"cut","status":"in_progress","output":[]}}\n\n');
      setTimeout(() => res.destroy(), 30);
    } else if (state.mode === 'busy' || state.mode === 'unknown') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = { type: 'response.failed', response: { id: 'busy', status: 'failed', output: [],
        error: { code: 'server_error', message: state.mode === 'busy' ? 'Our servers are currently busy. Please try again in a moment.' : 'Unlisted fixture provider failure XYZ.' } } };
      res.end(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
    } else if (state.mode === 'hang') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n');
    } else successfulStream(res);
  });
  server.on('connection', socket => { state.sockets.add(socket); socket.on('close', () => state.sockets.delete(socket)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await writeFile(path.join(root, 'config.toml'), `model_provider="fixture"\nmodel="fixture"\n[model_providers.fixture]\nname="Local fault injection"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\nstream_idle_timeout_ms=2000\n`);
  const bridge = await Bridge.connect({ args: ['app-server', '--stdio'], jsonl: true, env: { ...process.env, CODEX_HOME: root } });
  const threadId = (await bridge.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
  const recovery = new Recovery(threadId, async () => bridge, () => {}, () => false);
  bridge.on('notification', (m, p) => recovery.notice(m, p));
  t.after(async () => {
    recovery.close(); await bridge.close();
    for (const socket of state.sockets) socket.destroy();
    await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true });
  });
  await recovery.configure({ enabled: true, authorization: 'Fixture: retry transient errors, stop on manual interruption',
    max_attempts: 2, retry_interval_ms: 1000, check_interval_ms: 1000, max_elapsed_ms: 10000, ...config });
  return { state, bridge, recovery, threadId };
}
test('real provider HTTP 503 recovers through native tool output', { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.bridge.rpc('turn/start', { threadId: f.threadId, input: [{ type: 'text', text: 'Fixture: answer once.' }] });
  await until(() => f.recovery.state.state === 'backoff');
  assert.equal((await latestTurn(f.bridge, f.threadId)).status, 'failed');
  f.state.mode = 'success';
  await until(() => f.recovery.state.last_submission_at);
  await until(async () => (await latestTurn(f.bridge, f.threadId)).status === 'completed');
  assert.ok(f.state.calls >= 2);
  assert.equal(recoveryRequests(f).length, 1);
  assert.ok(recoveryRequests(f)[0].body.includes(f.recovery.state.retry_id));
});
test('real provider stream disconnect recovers after terminal failure', { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 }, async t => {
  const f = await fixture(t); f.state.mode = 'disconnect';
  await f.bridge.rpc('turn/start', { threadId: f.threadId, input: [{ type: 'text', text: 'Fixture: answer once.' }] });
  try { await until(() => f.recovery.state.state === 'backoff'); }
  catch (e) { throw Error(`${e}: ${JSON.stringify({ recovery: f.recovery.snapshot(), turn: await latestTurn(f.bridge, f.threadId), calls: f.state.calls })}`); }
  f.state.mode = 'success';
  await until(() => f.recovery.state.last_submission_at);
  await until(async () => (await latestTurn(f.bridge, f.threadId)).status === 'completed');
});
for (const retry_mode of ['transient', 'all_failed']) test(`manual interrupt of real waiting provider never triggers recovery (${retry_mode})`, { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 }, async t => {
  const f = await fixture(t, { retry_mode }); f.state.mode = 'hang';
  const result = await f.bridge.rpc('turn/start', { threadId: f.threadId, input: [{ type: 'text', text: 'Fixture: answer once.' }] });
  await until(() => f.state.calls > 0);
  await f.bridge.rpc('turn/interrupt', { threadId: f.threadId, turnId: result.turn.id });
  await until(() => f.recovery.state.state === 'cancelled');
  f.state.mode = 'success'; await f.recovery.check();
  assert.equal(f.recovery.state.attempts, 0); assert.equal(f.recovery.state.enabled, false);
  assert.equal(recoveryRequests(f).length, 0);
});

test('unlisted real provider failure retries only under all_failed mode', { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 }, async t => {
  const f = await fixture(t); f.state.mode = 'unknown';
  await f.bridge.rpc('turn/start', { threadId: f.threadId, input: [{ type: 'text', text: 'Fixture: answer once.' }] });
  await until(() => f.recovery.state.state === 'not_retryable');
  const failed = await latestTurn(f.bridge, f.threadId);
  assert.equal(failed.error.codexErrorInfo, 'other'); assert.equal(f.recovery.state.attempts, 0);
  await f.recovery.configure({ enabled: true, authorization: 'Fixture: retry all failed turns except host stops and manual interruption',
    retry_mode: 'all_failed', retry_interval_ms: 1000, max_elapsed_ms: 10000, check_interval_ms: 1000 });
  await until(() => f.recovery.state.state === 'backoff'); f.state.mode = 'success';
  await until(() => f.recovery.state.last_submission_at);
  await until(async () => (await latestTurn(f.bridge, f.threadId)).status === 'completed');
  assert.equal(recoveryRequests(f).length, 1);
  assert.equal((await latestTurn(f.bridge, f.threadId)).rootTurnId, failed.rootTurnId || failed.id);
});

test('real provider busy stream error recovers despite Codex classifying it as other', { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 }, async t => {
  const f = await fixture(t); f.state.mode = 'busy';
  await f.bridge.rpc('turn/start', { threadId: f.threadId, input: [{ type: 'text', text: 'Fixture: answer once.' }] });
  await until(() => ['backoff', 'not_retryable'].includes(f.recovery.state.state));
  const failed = await latestTurn(f.bridge, f.threadId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.codexErrorInfo, 'other', JSON.stringify(failed.error));
  assert.equal(failed.error.message, 'stream disconnected before completion: Our servers are currently busy. Please try again in a moment.');
  await until(() => f.recovery.state.state === 'backoff');
  assert.equal(f.recovery.state.attempts, 0);
  f.state.mode = 'success';
  await until(() => f.recovery.state.last_submission_at);
  await until(async () => (await latestTurn(f.bridge, f.threadId)).status === 'completed');
  // Completion resets the incident counter; count actual provider requests
  // instead of racing that bookkeeping on faster hosts.
  assert.equal(recoveryRequests(f).length, 1);
  assert.equal((await latestTurn(f.bridge, f.threadId)).id, f.recovery.state.submitted_turn);
});
