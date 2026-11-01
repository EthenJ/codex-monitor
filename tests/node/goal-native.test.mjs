import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge, getGoal, latestTurn } from '../../codex-monitor/runtime/bridge.js';
import { Manager } from '../../codex-monitor/runtime/manager.js';

const native = { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 25000 };
async function changed(manager, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, JSON.stringify({wait:manager.wait,events:manager.snapshot().events}));
    await manager.changes.wait(manager.changes.revision, remaining);
  }
}
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
  const notices = [];
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const id = `fixture_${requests.length + 1}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } })}\n\n`);
    const metadata = JSON.parse(body).client_metadata || {};
    const request = { turnId: metadata.turn_id, finish() {
      // Return a complete synthetic assistant response, including streamed output.
      const text = 'Fixture response complete.';
      const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
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
  bridge.on('notification', (method, p) => {
    if (['turn/started', 'turn/completed', 'thread/goal/updated', 'error'].includes(method)) {
      notices.push({ method, turn: p.turn, goal: p.goal, error: p.error });
    }
  });
  const thread = (await bridge.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
  // An active goal on an idle thread can start a turn before the fixture's
  // turn/start, which then steers/replaces that model request. Activate only
  // once the explicit test turn is running so we finish the correct stream.
  await bridge.rpc('thread/goal/set', { threadId: thread, objective: 'Isolated goal lifecycle fixture', status: 'paused', tokenBudget: 10000, origin: 'user' });
  manager = new Manager(path.join(root, 'state'), thread, { connect: async () => bridge });
  const monitor = await manager.start({ name: 'fixture', options: { cwd: root, watch_file: 'done', timeout_ms: 20000 }, instructions: 'Inspect fixture event' });
  return { bridge, manager, monitor, thread, requests,
    async startTurn(activateGoal = true) {
      const ready = new Promise(resolve => { nextRequest = resolve; });
      const { turn } = await bridge.rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Local fixture.' }] });
      const request = await ready;
      assert.equal(request.turnId, turn.id);
      if (activateGoal) await bridge.rpc('thread/goal/set', { threadId: thread, status: 'active', origin: 'user' });
      return { turn, async finish() {
        const done = notice(bridge, 'turn/completed', p => p.turn.id === turn.id, `after provider completion for ${turn.id}`);
        request.finish();
        try { await done; } catch (e) { throw Error(`${e.message}: ${JSON.stringify({ requestTurns: requests.map(r => r.turnId), latest: await latestTurn(bridge, thread), notices })}`); }
      } };
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
  await changed(f.manager,()=>f.manager.wait.state==='delivered');
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

test('native monitor first connection after pause does not restore the goal', native, async t => {
  const f = await fixture(t), original = await f.startTurn();
  await f.bridge.rpc('thread/goal/set', { threadId: f.thread, status: 'paused', origin: 'user' });
  await original.finish();
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused');
  await f.manager.connect();
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused');
  f.manager.event(f.monitor.id, { event_type: 'process_exit', returncode: 0 }); await f.manager.flush();
  assert.equal((await getGoal(f.bridge, f.thread)).status, 'paused');
  assert.equal(Object.values(f.manager.events)[0].state, 'pending');
});

test('native quiet authorized wait stays paused after the original turn ends', native, async t => {
  const f = await fixture(t), original = await f.startTurn(); await f.wait();
  await f.manager.configureRecovery({enabled:true,authorization:'Fixture: recover failures, never paused goals',retry_interval_ms:1000,check_interval_ms:1000});
  const resumed=[];
  f.bridge.on('notification',(method,p)=>{if(method==='thread/goal/updated'&&p.goal.status==='active')resumed.push(p.goal);});
  await original.finish();
  // A bounded negative-observation window, not an agent-side polling loop.
  await new Promise(resolve=>setTimeout(resolve,4000));
  assert.equal((await getGoal(f.bridge,f.thread)).status,'paused');
  assert.equal(resumed.length,0);assert.equal(f.requests.length,1);
  assert.equal(f.manager.wait.state,'waiting');assert.equal(f.manager.recovery.state.attempts,0);
});

test('native active goal refuses false waiting and can reuse existing conditional authorization', native, async t => {
  const f = await fixture(t), original = await f.startTurn();
  const rejected=await f.manager.beginWait({monitor_ids:[f.monitor.id],resume_instructions:'Inspect fixture result'});
  assert.equal(rejected.state,'goal_pause_required');assert.equal(f.manager.wait,null);
  assert.equal((await getGoal(f.bridge,f.thread)).status,'active');
  const accepted=await f.wait();assert.equal(accepted.goal_control,'paused');
  await original.finish();
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal((await getGoal(f.bridge,f.thread)).status,'paused');assert.equal(f.requests.length,1);
  f.manager.event(f.monitor.id,{event_type:'process_exit',returncode:0});await f.manager.flush();
  await changed(f.manager,()=>f.manager.wait.state==='delivered');
  assert.equal((await getGoal(f.bridge,f.thread)).status,'active');assert.equal(f.manager.wait.goal_control,'resumed');
  await f.interrupt({id:Object.values(f.manager.events)[0].submitted_turn});
});

test('native thread wait holds another monitor event until the calling turn actually ends',native,async t=>{
  const f=await fixture(t),original=await f.startTurn();
  const other=await f.manager.start({name:'other',options:{cwd:path.dirname(f.manager.directory),watch_file:'other',timeout_ms:20000},instructions:'Inspect the other result'});
  const waiting=await f.wait();assert.equal(waiting.pause_barrier,'draining');
  assert.equal(waiting.wake_scope,'thread');assert.ok(waiting.monitor_ids.includes(other.id));
  f.manager.event(other.id,{event_type:'process_exit',returncode:0});await f.manager.flush();
  assert.equal((await getGoal(f.bridge,f.thread)).status,'paused');
  assert.equal(Object.values(f.manager.events)[0].state,'pending');
  assert.equal(f.requests.length,1);assert.equal((await latestTurn(f.bridge,f.thread)).id,original.turn.id);
  await original.finish();
  await changed(f.manager,()=>f.manager.wait.state==='delivered');
  assert.equal((await getGoal(f.bridge,f.thread)).status,'active');
  const event=Object.values(f.manager.events)[0];assert.equal(event.state,'submitted');
  assert.notEqual(event.submitted_turn,original.turn.id);
  await f.interrupt({id:event.submitted_turn});
});

test('native follow-up message can refresh an automatically paused wait and wake after the new turn ends',native,async t=>{
  const f=await fixture(t),original=await f.startTurn();await f.wait();await original.finish();
  await changed(f.manager,()=>f.manager.wait.pause_barrier==='ready');
  const followup=await f.startTurn(false);
  assert.equal((await getGoal(f.bridge,f.thread)).status,'paused');
  const result=await f.manager.beginWait({resume_instructions:'Apply the follow-up after inspecting the event'});
  assert.equal(result.state,'waiting');assert.equal(result.goal_control,'paused');assert.equal(result.pause_owner,'plugin');
  assert.equal(result.pause_barrier,'draining');
  f.manager.event(f.monitor.id,{event_type:'process_exit',returncode:0});await f.manager.flush();
  assert.equal(Object.values(f.manager.events)[0].state,'pending');assert.equal(f.requests.length,2);
  assert.equal((await getGoal(f.bridge,f.thread)).status,'paused');
  await followup.finish();await changed(f.manager,()=>f.manager.wait.state==='delivered');
  assert.equal((await getGoal(f.bridge,f.thread)).status,'active');
  await f.interrupt({id:Object.values(f.manager.events)[0].submitted_turn});
});

test('native manual re-pause after cancelling a plugin wait cannot be adopted by a later message',native,async t=>{
  const f=await fixture(t),original=await f.startTurn();await f.wait();await f.manager.cancelWait();
  const paused=notice(f.bridge,'thread/goal/updated',p=>p.goal.status==='paused');
  await f.bridge.rpc('thread/goal/set',{threadId:f.thread,status:'paused',origin:'user'});await paused;
  const monitor=await f.manager.start({name:'replacement',options:{cwd:path.dirname(f.manager.directory),watch_file:'replacement',timeout_ms:20000},instructions:'Inspect'});
  const result=await f.manager.beginWait({resume_instructions:'Inspect',goal_authorization:'Earlier conditional pause and resume instruction'});
  assert.equal(result.state,'goal_paused');assert.equal(result.pause_owner,'external');assert.equal(result.goal_control,'unchanged');
  f.manager.event(monitor.id,{event_type:'process_exit'});await f.manager.flush();
  assert.equal(Object.values(f.manager.events)[0].state,'pending');assert.equal(f.requests.length,1);
  await original.finish();assert.equal((await getGoal(f.bridge,f.thread)).status,'paused');
});
