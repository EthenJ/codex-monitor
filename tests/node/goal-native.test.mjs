import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge, getGoal, latestTurn } from '../../codex-monitor/runtime/bridge.js';
import { Manager } from '../../codex-monitor/runtime/manager.js';

const native = { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 25000 };
function notice(bridge, method, predicate = () => true, label = '') {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); bridge.off('notification', listener); };
    const listener = (m, p) => { if (m === method && predicate(p)) { cleanup(); resolve(p); } };
    const timer = setTimeout(() => { cleanup(); reject(Error(`Missing ${method} ${label}`)); }, 8000);
    bridge.on('notification', listener);
  });
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-goal-'));
  let bridge, manager, nextRequest;
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* Consume the fixture request. */ }
    const id = `fixture_${requests.length + 1}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } })}\n\n`);
    const request = { finish() {
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
    } };
    requests.push(request); nextRequest?.(request); nextRequest = undefined;
  });
  t.after(async () => {
    await manager?.close(); await bridge?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(root, 'config.toml'), `model_provider="fixture"\nmodel="fixture"\n[model_providers.fixture]\nname="Offline goal fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  bridge = await Bridge.connect({ args: ['app-server', '--stdio'], jsonl: true, env: { ...process.env, CODEX_HOME: root } });
  const thread = (await bridge.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
  await bridge.rpc('thread/goal/set', { threadId: thread, objective: 'Isolated goal lifecycle fixture', status: 'active', tokenBudget: 10000, origin: 'user' });
  manager = new Manager(path.join(root, 'state'), thread, { connect: async () => bridge });
  const monitor = await manager.start({ name: 'fixture', options: { cwd: root, watch_file: 'done', timeout_ms: 20000 }, instructions: 'Inspect fixture event' });
  return { bridge, manager, monitor, thread, requests,
    async startTurn() {
      const ready = new Promise(resolve => { nextRequest = resolve; });
      const { turn } = await bridge.rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Local fixture.' }] });
      const request = await ready;
      return { turn, async finish() { const done = notice(bridge, 'turn/completed', p => p.turn.id === turn.id, `after provider completion for ${turn.id}`); request.finish(); await done; } };
    },
    wait: () => manager.beginWait({ monitor_ids: [monitor.id], resume_instructions: 'Inspect fixture result', goal_authorization: 'Pause the fixture goal while waiting and resume on its event' }),
    async interrupt(turn) {
      const done = notice(bridge, 'turn/completed', p => p.turn.id === turn.id, `after interrupt of ${turn.id}`);
      await bridge.rpc('turn/interrupt', { threadId: thread, turnId: turn.id }); await done;
    },
  };
}

test('native Manager pauses continuation, leaves current turn running, and resumes on a selected event', native, async t => {
  const f = await fixture(t), original = await f.startTurn();
  const waiting = await f.wait();
  assert.equal(waiting.goal_control, 'paused'); assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused');
  assert.equal((await latestTurn(f.bridge, f.thread)).status, 'inProgress');
  await original.finish();
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused'); assert.equal(f.requests.length, 1);
  f.manager.event(f.monitor.id, { event_type: 'process_exit', returncode: 0 }); await f.manager.flush();
  const goal = await getGoal(f.bridge, f.thread);
  assert.equal(goal.status, 'active'); assert.equal(goal.objective, 'Isolated goal lifecycle fixture'); assert.equal(goal.tokenBudget, 10000);
  assert.equal(f.manager.wait.state, 'delivered'); assert.equal(f.manager.wait.goal_control, 'resumed');
  const event = Object.values(f.manager.events)[0];
  assert.equal(event.state, 'submitted'); assert.notEqual(event.submitted_turn, original.turn.id);
  // The history read can briefly lag turn/start acceptance. Interrupt the
  // accepted callback ID, never the previous completed turn from that snapshot.
  await f.interrupt({ id: event.submitted_turn });
});

test('native manual pause holds callbacks and resume releases them without changing the goal', native, async t => {
  const f = await fixture(t), original = await f.startTurn();
  await f.manager.connect();
  await f.bridge.rpc('thread/goal/set', { threadId: f.thread, status: 'paused', origin: 'user' }); await original.finish();
  f.manager.event(f.monitor.id, { event_type: 'process_exit', returncode: 0 }); await f.manager.flush();
  const event = Object.values(f.manager.events)[0];
  assert.equal(event.state, 'pending'); assert.equal(event.deferred_reason, 'Goal is paused');
  assert.equal((await latestTurn(f.bridge, f.thread)).id, original.turn.id);
  const started = notice(f.bridge, 'turn/started', p => p.turn.id !== original.turn.id);
  await f.bridge.rpc('thread/goal/set', { threadId: f.thread, status: 'active', origin: 'user' });
  const wake = await started;
  // Wait for the manager's accepted-delivery state, using its revision signal.
  while (event.state === 'pending' || event.state === 'sending') await f.manager.changes.wait(f.manager.changes.revision, 5000);
  assert.equal(event.state, 'submitted'); assert.equal(event.submitted_turn, wake.turn.id);
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'active');
  await f.interrupt(wake.turn);
});

test('native manual interruption cancels a waiting goal without an event-driven restart', native, async t => {
  const f = await fixture(t), original = await f.startTurn(); await f.wait();
  await f.interrupt(original.turn);
  assert.equal(f.manager.wait.state, 'cancelled'); assert.equal(f.manager.records[f.monitor.id].muted, true);
  f.manager.event(f.monitor.id, { event_type: 'process_exit' }); await f.manager.flush();
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused');
  assert.equal((await latestTurn(f.bridge, f.thread)).id, original.turn.id);
  assert.equal(Object.keys(f.manager.events).length, 0);
});

test('native repeated manual pause revokes the earlier conditional resume', native, async t => {
  const f = await fixture(t), original = await f.startTurn(); await f.wait();
  const changed = notice(f.bridge, 'thread/goal/updated', p => p.goal.status === 'paused');
  await f.bridge.rpc('thread/goal/set', { threadId: f.thread, status: 'paused', origin: 'user' });
  await changed;
  assert.equal(f.manager.wait.state, 'cancelled');
  f.manager.event(f.monitor.id, { event_type: 'process_exit' }); await f.manager.flush();
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused');
  assert.equal(Object.keys(f.manager.events).length, 0);
  await f.interrupt(original.turn);
});
