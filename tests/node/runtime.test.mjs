import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Manager } from '../../codex-monitor/runtime/manager.js';
import { Recovery, retryable } from '../../codex-monitor/runtime/recovery.js';
import { Health, parseGpu } from '../../codex-monitor/runtime/health.js';
import { owned, capture } from '../../codex-monitor/runtime/processes.js';
import { sameGoal, RpcError } from '../../codex-monitor/runtime/bridge.js';
import { startSensor, validateOptions } from '../../codex-monitor/runtime/sensors.js';

class Host extends EventEmitter {
  goal = { threadId: 't', createdAt: 1, updatedAt: 1, objective: 'Train', status: 'active', tokenBudget: 10000, tokensUsed: 1, timeUsedSeconds: 1 };
  turn = { id: 'original', rootTurnId: 'original', status: 'completed', error: null };
  submissions = []; changes = []; thread; status = 'idle'; beforeSubmit; connectError;
  async rpc(method, params) {
    if (method === 'thread/loaded/list') return { data: [this.thread] };
    if (method === 'thread/resume') return { thread: { id: this.thread } };
    if (method === 'thread/goal/get') return { goal: structuredClone(this.goal) };
    if (method === 'thread/turns/list') return { data: [structuredClone(this.turn)] };
    if (method === 'thread/read') return { thread: { status: { type: this.status } } };
    if (method === 'thread/goal/set') {
      this.changes.push(params); this.goal.status = params.status; this.goal.updatedAt++;
      this.emit('notification', 'thread/goal/updated', { threadId: this.thread, goal: structuredClone(this.goal) });
      return { goal: structuredClone(this.goal) };
    }
    if (method === 'turn/start') {
      await this.beforeSubmit?.(); this.submissions.push(params);
      this.turn = { id: randomUUID(), rootTurnId: params.rootTurnId || randomUUID(), status: 'inProgress' };
      return { turn: structuredClone(this.turn) };
    }
    throw Error(method);
  }
  async close() {}
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-node-'));
  const work = path.join(root, 'work'); await mkdir(work);
  const host = new Host(); host.thread = randomUUID();
  const manager = new Manager(path.join(root, 'state'), host.thread, { connect: async () => host });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const start = (extra = {}) => manager.start({ name: 'training', kind: 'watchdog', instructions: 'Inspect result',
    options: { cwd: work, watch_file: path.join(work, 'metrics'), timeout_ms: 10000, ...extra } });
  return { root, work, host, manager, start };
}
async function eventually(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('condition timed out'); await new Promise(r => setTimeout(r, 10)); }
}
test('registration reuse, native file result, structured native delivery and acknowledgement', async t => {
  const f = await fixture(t), first = await f.start({ max_events: 1 });
  assert.equal(first.state, 'armed'); assert.equal((await f.start({ max_events: 1 })).id, first.id);
  await writeFile(path.join(f.work, 'metrics'), 'done');
  await eventually(() => f.host.submissions.length === 1);
  const submission = f.host.submissions[0]; assert.deepEqual(submission.input, []); assert.equal(submission.toolOutput.name, 'monitor_event');
  const event = Object.values(f.manager.events)[0]; assert.equal(event.state, 'submitted');
  await f.manager.acknowledge({ event_ids: [event.id], resolution: 'Inspected artifact' });
  assert.equal(event.state, 'acknowledged'); assert.equal(f.manager.jobs.size, 0);
});
test('acknowledgement before dispatch suppresses stale event', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  manager.event(r.id, { event_type: 'file_change', path: 'a' });
  await manager.acknowledge({ event_ids: Object.keys(manager.events), resolution: 'Already handled' });
  await manager.flush(); assert.equal(host.submissions.length, 0);
});
test('event deduplication, supersession and expiration', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  manager.event(r.id, { event_type: 'file_change', event_id: 'same', path: 'a' });
  manager.event(r.id, { event_type: 'file_change', event_id: 'same', path: 'a' });
  assert.equal(Object.keys(manager.events).length, 1);
  manager.event(r.id, { event_type: 'file_change', event_id: 'new', path: 'a' });
  assert.equal(Object.values(manager.events)[0].state, 'superseded');
  Object.values(manager.events)[1].expires_at = 0;
  await manager.flush(); assert.equal(host.submissions.length, 0); assert.equal(Object.values(manager.events)[1].state, 'expired');
});
test('native goal wait preserves budget, resumes after submission', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  const result = await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Evaluate', goal_authorization: 'Pause while waiting and resume on event' });
  assert.equal(result.state, 'waiting'); assert.equal(host.goal.status, 'paused');
  manager.event(r.id, { event_type: 'process_exit', returncode: 0 }); await manager.flush();
  assert.equal(host.goal.status, 'active'); assert.equal(host.goal.tokensUsed, 1);
  assert.deepEqual(host.changes.map(x => Object.keys(x).sort()), [['origin', 'status', 'threadId'], ['origin', 'status', 'threadId']]);
});
test('later goal edit suppresses wake', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Evaluate', goal_authorization: 'Pause and resume' });
  host.goal.objective = 'User changed task'; manager.event(r.id, { event_type: 'process_exit' }); await manager.flush();
  assert.equal(host.submissions.length, 0); assert.equal(manager.wait.state, 'cancelled');
});
test('cancellation during submission never resumes goal', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Evaluate', goal_authorization: 'Pause and resume' });
  host.beforeSubmit = () => manager.cancelWait(); manager.event(r.id, { event_type: 'process_exit' }); await manager.flush();
  assert.equal(host.goal.status, 'paused'); assert.equal(manager.wait.state, 'cancelled');
});
test('quiet training progress triggers only sustained stall', async t => {
  const { manager, host, start, work } = await fixture(t);
  await start({ watchdog_only: true, stalled_for_ms: 200, max_events: 1 });
  await writeFile(path.join(work, 'metrics'), 'step');
  await eventually(() => host.submissions.length === 1);
  assert.deepEqual(Object.values(manager.events).map(e => e.event_type), ['watchdog_stalled']);
});
test('watch root replacement reports failure', async t => {
  const { manager, start, work } = await fixture(t); await start();
  await rename(work, work + '-old'); await mkdir(work);
  await eventually(() => Object.values(manager.events).some(e => e.event_type === 'monitor_error'));
});
test('stop cancels watcher without touching existing process', async t => {
  const child = await owned(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => child.stop());
  const { manager, start } = await fixture(t), r = await start({ pid: child.pid });
  await manager.stop(r.id); assert.doesNotThrow(() => process.kill(child.pid, 0));
});
test('owned command exit delivers even with no matching output', async t => {
  const { manager, host, work } = await fixture(t);
  await manager.start({ name: 'build', kind: 'command', options: { cwd: work, command: `"${process.execPath}" -e "console.log(123)"`, match: 'NEVER', timeout_ms: 5000 }, instructions: 'Inspect exit' });
  await eventually(() => host.submissions.length === 1);
  assert.equal(Object.values(manager.events)[0].event_type, 'command_exit');
});
test('service restart does not rearm monitors, deliveries or recovery', async t => {
  const f = await fixture(t); const r = await f.start(); f.manager.event(r.id, { event_type: 'file_change' });
  const other = path.join(f.root, 'restored'); await mkdir(other); await writeFile(path.join(other, 'state.json'), await readFile(path.join(f.root, 'state', 'state.json')));
  const recovered = new Manager(other, f.host.thread, { connect: async () => f.host });
  try { assert.equal(recovered.records[r.id].state, 'unknown'); assert.equal(Object.values(recovered.events)[0].state, 'unknown'); assert.equal(recovered.jobs.size, 0); }
  finally { await recovered.close(); }
});
test('health thresholds preserve same-card dwell and unknown sensors', () => {
  const h = new Health({ gpu_util_below: 10, gpu_recover_above: 20, gpu_below_for_ms: 100, gpu_match: 'any', dead_if: 'all' }, 0);
  h.gpu(0, { a: 0, b: 100 }); h.gpu(90, { a: 100, b: 0 }); h.gpu(110, { a: 100, b: 0 }); assert.equal(h.tick(110), undefined);
  h.gpu(200, { a: 100, b: 0 }); assert.equal(h.tick(200).event_type, 'watchdog_stalled');
  h.gpuUnknown(); assert.equal(h.tick(300), undefined);
  h.gpu(400, { a: 100, b: 100 }); assert.equal(h.tick(400).event_type, 'watchdog_recovered');
  assert.throws(() => parseGpu('0, GPU-a, 00000000:01:00.0, N/A', '0'));
  assert.throws(() => parseGpu('0, GPU-a, 00000000:01:00.0, 10', '0,1'));
});
test('retry classification excludes permanent, policy, budget and unknown errors', () => {
  for (const code of ['unauthorized', 'usageLimitExceeded', 'sessionBudgetExceeded', 'contextWindowExceeded', 'badRequest', 'other', 'misalignmentPolicyViolation']) assert.equal(retryable({ codexErrorInfo: code }), false);
  assert.equal(retryable({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }), false);
  assert.equal(retryable({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }), true);
  assert.equal(retryable({ codexErrorInfo: 'rateLimitExceeded' }), false);
});
test('only the observed provider-busy other error is eligible for recovery', () => {
  const message = 'stream disconnected before completion: Our servers are currently busy. Please try again in a moment.';
  assert.equal(retryable({ codexErrorInfo: 'other', message }), true);
  assert.equal(retryable({ codexErrorInfo: 'serverOverloaded' }), true);
  for (const code of [undefined, 'unauthorized', 'usageLimitExceeded', 'misalignmentPolicyViolation']) {
    assert.equal(retryable({ codexErrorInfo: code, message }), false);
  }
  for (const other of ['Our servers are currently busy.', message + ' Account blocked.', 'Quoted error: ' + message, 'stream disconnected before completion: Unknown error.']) {
    assert.equal(retryable({ codexErrorInfo: 'other', message: other }), false);
  }
});
async function recoveryFixture(t, config = {}, error = { codexErrorInfo: 'serverOverloaded' }, waiting = () => false) {
  const host = new Host(); host.thread = randomUUID(); host.turn = { id: 'failed', rootTurnId: 'failed', status: 'failed', error };
  const recovery = new Recovery(host.thread, async () => host, () => {}, waiting);
  host.on('notification', (m,p) => recovery.notice(m,p));
  t.after(() => recovery.close());
  await recovery.configure({ enabled: true, authorization: 'Fixture: retry failed turns under the selected policy, never manual interruptions', retry_interval_ms: 1000, check_interval_ms: 1000, max_attempts: 2, ...config });
  await recovery.check(); return { recovery, host };
}
test('recovery submits native tool output only after backoff and verified failed turn', async t => {
  const { recovery, host } = await recoveryFixture(t);
  assert.equal(host.submissions.length, 0); recovery.state.next_retry_at = 0; await recovery.check();
  assert.equal(host.submissions.length, 1); assert.deepEqual(host.submissions[0].input, []); assert.equal(recovery.state.attempts, 1);
});

test('all_failed covers unlisted, missing, authentication and rate-limit errors but preserves host stops', () => {
  for (const error of [null, undefined, {}, { codexErrorInfo: 'brandNewFailure' }, { codexErrorInfo: 'unauthorized' },
    { codexErrorInfo: 'other', message: 'Unlisted error' }, { codexErrorInfo: 'rateLimitExceeded' },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } }]) {
    assert.equal(retryable(error, false, 'all_failed'), true);
    assert.equal(retryable(error), false);
  }
  for (const code of ['sessionBudgetExceeded', 'usageLimitExceeded', 'misalignmentPolicyViolation']) {
    for (const value of [code, { [code]: {} }]) assert.equal(retryable({ codexErrorInfo: value }, true, 'all_failed'), false);
  }
});

test('default fixed five-minute retries stop at the three-hour incident boundary', async t => {
  const start = 1800000000000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { recovery, host } = await recoveryFixture(t, { retry_mode: 'all_failed', retry_interval_ms: undefined, max_attempts: undefined }, null);
  assert.equal(recovery.state.policy.retry_interval_ms, 300000);
  assert.equal(recovery.state.policy.max_elapsed_ms, 10800000);
  assert.equal(recovery.state.policy.max_attempts, 36);
  for (let attempt = 1; attempt < 36; attempt++) {
    const due = start + attempt * 300000;
    assert.equal(recovery.state.next_retry_at, due);
    t.mock.timers.setTime(due - 1); await recovery.check();
    assert.equal(host.submissions.length, attempt - 1);
    t.mock.timers.setTime(due); await recovery.check();
    assert.equal(host.submissions.length, attempt);
    assert.equal(host.submissions.at(-1).rootTurnId, 'failed');
    assert.equal(JSON.parse(host.submissions.at(-1).toolOutput.output).retry_mode, 'all_failed');
    host.turn.status = 'failed'; host.turn.error = { codexErrorInfo: 'newUnknownError' };
    await recovery.check();
  }
  t.mock.timers.setTime(start + 10800000); await recovery.check();
  assert.equal(host.submissions.length, 35); assert.equal(recovery.state.state, 'exhausted');
  assert.equal(recovery.state.enabled, false);
});

test('custom interval and elapsed limit work without an early legacy attempt cap', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const { recovery, host } = await recoveryFixture(t, { retry_interval_ms: 7000, max_elapsed_ms: 15000, max_attempts: undefined });
  assert.equal(recovery.state.policy.max_attempts, 3);
  for (let i = 0; i < 2; i++) {
    t.mock.timers.setTime(Date.now() + 7000); await recovery.check();
    host.turn.status = 'failed'; host.turn.error = { codexErrorInfo: 'serverOverloaded' }; await recovery.check();
  }
  assert.equal(host.submissions.length, 2);
  t.mock.timers.setTime(Date.now() + 1000); await recovery.check();
  assert.equal(recovery.state.state, 'exhausted'); assert.equal(host.submissions.length, 2);
});

test('invalid retry configuration preserves the current supervisor and legacy delay is a fixed alias', async t => {
  const { recovery } = await recoveryFixture(t);
  for (const config of [{ retry_mode: 'anything' }, { retry_interval_ms: 0 }, { max_elapsed_ms: -1 },
    { max_attempts: 0 }, { retry_interval_ms: 1000, base_delay_ms: 2000 }, { retry_interval_ms: 2000, max_delay_ms: 1000 }]) {
    const before = recovery.snapshot();
    await assert.rejects(recovery.configure({ enabled: true, authorization: 'Fixture', ...config }));
    assert.deepEqual(recovery.snapshot(), before);
  }
  await recovery.configure({ enabled: true, authorization: 'Legacy fixture', base_delay_ms: 2000, max_delay_ms: 4000 });
  assert.equal(recovery.state.policy.retry_interval_ms, 2000);
  assert.equal(recovery.state.policy.retry_mode, 'transient');
});

test('all_failed respects terminal status, manual stop, goal edits, budgets, waits and ambiguous writes', async t => {
  for (const status of ['completed', 'inProgress', 'interrupted']) {
    const { recovery, host } = await recoveryFixture(t, { retry_mode: 'all_failed' }, null);
    host.turn.status = status; recovery.state.next_retry_at = 0; await recovery.check();
    assert.equal(host.submissions.length, 0);
    if (status === 'interrupted') assert.equal(recovery.state.enabled, false);
  }
  for (const change of [{ status: 'paused' }, { tokensUsed: 10000 }, { objective: 'New user task' }]) {
    const { recovery, host } = await recoveryFixture(t, { retry_mode: 'all_failed' }, null);
    Object.assign(host.goal, change); recovery.state.next_retry_at = 0; await recovery.check();
    assert.equal(host.submissions.length, 0); assert.equal(recovery.state.enabled, false);
  }
  const waiting = await recoveryFixture(t, { retry_mode: 'all_failed' }, null, () => true);
  assert.equal(waiting.recovery.state.state, 'waiting'); assert.equal(waiting.host.submissions.length, 0);
  const ambiguous = await recoveryFixture(t, { retry_mode: 'all_failed' }, null);
  let attempts = 0;
  ambiguous.host.beforeSubmit = () => { attempts++; throw new RpcError('Lost write response', true); };
  ambiguous.recovery.state.next_retry_at = 0; await ambiguous.recovery.check(); await ambiguous.recovery.check();
  assert.equal(attempts, 1); assert.equal(ambiguous.recovery.state.state, 'unknown');
});

test('pre-submit verification rechecks error policy and elapsed deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  for (const race of ['policy', 'deadline']) {
    const { recovery, host } = await recoveryFixture(t, { retry_mode: 'all_failed' }, null);
    const rpc = host.rpc.bind(host); let reads = 0;
    host.rpc = async (method, params) => {
      if (method === 'thread/turns/list' && ++reads === 2) {
        if (race === 'policy') host.turn.error = { codexErrorInfo: 'sessionBudgetExceeded' };
        else t.mock.timers.setTime(recovery.state.incident_started_at + recovery.state.policy.max_elapsed_ms);
      }
      return rpc(method, params);
    };
    recovery.state.next_retry_at = 0; await recovery.check();
    assert.equal(host.submissions.length, 0);
    assert.equal(recovery.state.state, race === 'policy' ? 'not_retryable' : 'exhausted');
  }
});

test('incident limit expires during daemon loss and supervisor lifetime remains independent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  for (const lifetime of [1000, 86400000]) {
    const { recovery, host } = await recoveryFixture(t, { lifetime_ms: lifetime, max_elapsed_ms: 2000 });
    host.rpc = async () => { throw Error('Offline'); };
    await recovery.check(); assert.equal(recovery.state.state, 'connection_unavailable');
    t.mock.timers.setTime(Date.now() + Math.min(lifetime, 2000)); await recovery.check();
    assert.equal(recovery.state.state, lifetime === 1000 ? 'expired' : 'exhausted');
    assert.equal(host.submissions.length, 0);
  }
});
test('manual interruption cancels armed retry', async t => {
  const { recovery, host } = await recoveryFixture(t);
  recovery.notice('turn/completed', { threadId: host.thread, turn: { status: 'interrupted' } });
  await recovery.check(); assert.equal(host.submissions.length, 0); assert.equal(recovery.state.enabled, false);
});
test('manual pause and budget exhaustion prevent recovery', async t => {
  for (const change of [{ status: 'paused' }, { tokensUsed: 10000 }]) {
    const { recovery, host } = await recoveryFixture(t); Object.assign(host.goal, change);
    recovery.state.next_retry_at = 0; await recovery.check(); assert.equal(host.submissions.length, 0); assert.equal(recovery.state.enabled, false);
  }
});
test('new user turn during backoff prevents retry of previous failure', async t => {
  const { recovery, host } = await recoveryFixture(t);
  host.turn = { id: 'user', status: 'inProgress' }; host.status = 'active'; recovery.state.next_retry_at = 0;
  await recovery.check(); assert.equal(host.submissions.length, 0);
});
test('recovery has finite retry budget', async t => {
  const { recovery, host } = await recoveryFixture(t);
  recovery.state.attempts = 2; recovery.state.next_retry_at = 0; await recovery.check();
  assert.equal(host.submissions.length, 0); assert.equal(recovery.state.state, 'exhausted');
});
test('post-turn accounting allowed but objective or budget edits rejected', () => {
  const goal = new Host().goal;
  assert.equal(sameGoal(goal, { ...goal, tokensUsed: 10, updatedAt: 2 }), true);
  assert.equal(sameGoal(goal, { ...goal, objective: 'changed' }), false);
});
test('owned capture preserves unicode and exit status', async () => {
  assert.equal((await capture(process.execPath, ['-e', 'console.log("中文")'])).trim(), '中文');
  await assert.rejects(capture(process.execPath, ['-e', 'process.exit(3)']));
});

function gate() { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; }

test('cancel during wait preparation never reinstates waiting or resumes goal', async t => {
  for (const method of ['thread/goal/get', 'thread/goal/set']) {
    const { manager, host, start } = await fixture(t), r = await start(), blocked = gate(), reached = gate();
    const rpc = host.rpc.bind(host);
    host.rpc = async (name, params) => {
      const result = await rpc(name, params);
      if (name === method) { reached.release(); await blocked.promise; }
      return result;
    };
    const pending = manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Evaluate', goal_authorization: 'Pause and resume' });
    await reached.promise; await manager.cancelWait(); blocked.release();
    assert.equal((await pending).state, 'cancelled');
    assert.equal(host.changes.length, method === 'thread/goal/get' ? 0 : 1);
    manager.event(r.id, { event_type: 'process_exit' }); await manager.flush();
    assert.equal(host.submissions.length, 0);
  }
});

test('manual interrupt cancels goal wait and mutes later workload events', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Evaluate', goal_authorization: 'Pause and resume' });
  host.emit('notification', 'turn/completed', { threadId: host.thread, turn: { id: 'user', status: 'interrupted' } });
  manager.event(r.id, { event_type: 'process_exit' }); await manager.flush();
  assert.equal(manager.wait.state, 'cancelled'); assert.equal(host.submissions.length, 0);
});

test('state-directory aliases cannot bypass watched-tree containment', async t => {
  const { manager, root, work } = await fixture(t);
  const alias = path.join(root, 'state-alias');
  await symlink(path.join(root, 'state'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.start({ name: 'loop', kind: 'watchdog', instructions: 'Fixture',
    options: { cwd: work, watch_directory: alias } }), /outside watched tree/);
});

test('ambiguous event submission remains unknown and is not retried', async t => {
  const { manager, host, start } = await fixture(t), r = await start(); let attempts = 0;
  host.beforeSubmit = () => { attempts++; throw new RpcError('Transport lost after write', true); };
  manager.event(r.id, { event_type: 'process_exit' }); await manager.flush(); await manager.flush();
  assert.equal(attempts, 1); assert.equal(Object.values(manager.events)[0].state, 'unknown');
});

test('editing or clearing a goal during backoff cancels recovery', async t => {
  for (const change of ['objective', 'tokenBudget', 'clear']) {
    const { recovery, host } = await recoveryFixture(t);
    if (change === 'clear') host.goal = null;
    else if (change === 'tokenBudget') host.goal.tokenBudget++;
    else host.goal.objective = 'New user task';
    recovery.state.next_retry_at = 0; await recovery.check();
    assert.equal(host.submissions.length, 0); assert.equal(recovery.state.state, 'cancelled');
  }
});

test('ambiguous recovery submission disables retries', async t => {
  const { recovery, host } = await recoveryFixture(t); let attempts = 0;
  host.beforeSubmit = () => { attempts++; throw new RpcError('Response lost after write', true); };
  recovery.state.next_retry_at = 0; await recovery.check(); await recovery.check();
  assert.equal(attempts, 1); assert.equal(recovery.state.state, 'unknown'); assert.equal(recovery.state.enabled, false);
});

test('disabling recovery while configuration is in flight stays disabled', async t => {
  const host = new Host(), blocked = gate(), reached = gate(); host.thread = randomUUID();
  const recovery = new Recovery(host.thread, async () => { reached.release(); await blocked.promise; return host; }, () => {}, () => false);
  t.after(() => recovery.close());
  const configuring = recovery.configure({ enabled: true, authorization: 'Fixture authorization' });
  await reached.promise; await recovery.configure({ enabled: false }); blocked.release(); await configuring;
  assert.equal(recovery.state.enabled, false); assert.equal(recovery.state.state, 'disabled');
});

test('interruption during native recovery submission retains cancelled state', async t => {
  const { recovery, host } = await recoveryFixture(t);
  host.beforeSubmit = () => host.emit('notification', 'turn/completed', { threadId: host.thread, turn: { status: 'interrupted' } });
  recovery.state.next_retry_at = 0; await recovery.check();
  assert.equal(recovery.state.enabled, false); assert.equal(recovery.state.state, 'cancelled');
});

test('failed connection settles the dependent wait instead of waiting forever', async t => {
  const { manager, start } = await fixture(t), r = await start();
  await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Evaluate' });
  manager.connect = async () => { throw Error('Daemon unavailable'); };
  manager.event(r.id, { event_type: 'process_exit' }); await manager.flush();
  assert.equal(manager.wait.state, 'failed'); assert.equal(Object.values(manager.events)[0].state, 'failed');
});

test('capture decodes multibyte characters split across chunks', async () => {
  const script = 'const b=Buffer.from("中文");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),40)';
  assert.equal(await capture(process.execPath, ['-e', script]), '中文');
});

test('GPU identity changes reset dwell even when device index is reused', () => {
  const h = new Health({ gpu_util_below: 10, gpu_recover_above: 20, gpu_below_for_ms: 100, gpu_match: 'all', dead_if: 'all' }, 0);
  h.gpu(0, parseGpu('0, GPU-old, 00000000:01:00.0, 0', '0'));
  h.gpu(90, parseGpu('0, GPU-new, 00000000:01:00.0, 0', '0'));
  assert.equal(h.tick(110), undefined);
  h.gpu(200, parseGpu('0, GPU-new, 00000000:01:00.0, 0', '0'));
  assert.equal(h.tick(200).event_type, 'watchdog_stalled');
});

test('a state-file watch is rejected to prevent feedback from status writes', async t => {
  const { manager, start, root } = await fixture(t);
  await assert.rejects(start({ watch_file: path.join(root, 'state', 'state.json') }), /state files/);
});

test('deletion is observable but never resets training progress', async t => {
  const { manager, work, start } = await fixture(t), progress = [];
  const original = Health.prototype.progress;
  Health.prototype.progress = function(at) { progress.push(at); return original.call(this, at); };
  t.after(() => { Health.prototype.progress = original; });
  const file = path.join(work, 'metrics'); await writeFile(file, 'one');
  const r = await start({ debounce_ms: 0 });
  const replacement = path.join(work, 'new'); await writeFile(replacement, 'two'); await rename(replacement, file);
  await eventually(() => progress.length > 0);
  const count = progress.length; await rm(file);
  await eventually(() => Object.values(manager.events).some(e => e.evidence?.change === 'deleted'));
  assert.equal(progress.length, count); await manager.stop(r.id);
});

test('invalid pattern and executable options fail before a watcher is armed', () => {
  for (const extra of [{ pattern: 1 }, { nvidia_smi: {} }, { warmup_ms: 10000 }]) {
    assert.throws(() => validateOptions('watchdog', { cwd: process.cwd(), watch_file: 'metrics', timeout_ms: 10000, ...extra }, path.join(process.cwd(),'state')));
  }
});

test('accepted retry is not duplicated while latest-turn state lags', async t => {
  const { recovery, host } = await recoveryFixture(t);
  const failed = structuredClone(host.turn);
  recovery.state.next_retry_at = 0; await recovery.check();
  host.turn = failed;
  await recovery.check(); await recovery.check();
  assert.equal(host.submissions.length, 1); assert.equal(recovery.state.state, 'awaiting_host');
  host.turn = { ...failed, id: recovery.state.submitted_turn };
  await recovery.check(); assert.equal(recovery.state.state, 'backoff');
});

test('acknowledgement during goal verification settles the wait', async t => {
  const { manager, host, start } = await fixture(t), r = await start();
  await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Inspect', goal_authorization: 'Pause and resume' });
  manager.event(r.id, { event_type: 'process_exit' });
  const rpc = host.rpc.bind(host);
  host.rpc = async (method, params) => {
    if (method === 'thread/goal/get') await manager.acknowledge({ event_ids: Object.keys(manager.events), resolution: 'Handled independently' });
    return rpc(method, params);
  };
  await manager.flush();
  assert.equal(manager.wait.state, 'interrupted'); assert.equal(host.goal.status, 'paused'); assert.equal(host.submissions.length, 0);
});

test('expired wake and notification-free observer completion settle waits', async t => {
  const f = await fixture(t), r = await f.start();
  await f.manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Inspect' });
  f.manager.event(r.id, { event_type: 'process_exit' }); Object.values(f.manager.events)[0].expires_at = 0;
  f.manager.expire(); assert.equal(f.manager.wait.state, 'interrupted');
  const other = await fixture(t), monitor = await other.start();
  await other.manager.beginWait({ monitor_ids: [monitor.id], resume_instructions: 'Inspect' });
  await other.manager.jobs.get(monitor.id).stop('deadline'); other.manager.expire();
  assert.equal(other.manager.wait.state, 'failed');
});

test('muted monitors cannot create another wait', async t => {
  const { manager, start } = await fixture(t), r = await start();
  await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Inspect' }); await manager.cancelWait();
  assert.equal((await manager.beginWait({ monitor_ids: [r.id], resume_instructions: 'Inspect' })).state, 'ready');
});

test('history collection retains instructions for unacknowledged submitted events', async t => {
  const { manager, start } = await fixture(t);
  for (let i = 0; i < 100; i++) {
    const key = randomUUID(); manager.records[key] = { id: key, state: 'stopped', name: 'old-'+i, instructions: 'Retain evidence' };
    manager.events[key] = { id: key, monitor_id: key, state: 'submitted', expires_at: Date.now()+60000 };
  }
  await assert.rejects(start(), /history busy/);
  for (const key of Object.keys(manager.events)) assert.equal(manager.snapshot(key).monitors[0].instructions, 'Retain evidence');
});

test('unknown inherited object keys cannot be used as monitor or event IDs', async t => {
  const { manager } = await fixture(t);
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => manager.snapshot(key), /Unknown monitor/);
    await assert.rejects(manager.stop(key), /Unknown monitor/);
    await assert.rejects(manager.acknowledge({ event_ids: [key], resolution: 'Invalid input' }), /Unknown event/);
  }
  assert.equal(Object.prototype.muted, undefined);
});

test('cancellation during sensor registration does not leave a live watcher', async t => {
  const { work } = await fixture(t), outcomes = [];
  const sensor = startSensor('watchdog', validateOptions('watchdog', { cwd: work, watch_file: 'metrics', timeout_ms: 10000 }, path.join(work,'state')), () => {}, x => outcomes.push(x));
  const rejected = assert.rejects(sensor.ready, /cancelled|stopped/);
  await sensor.stop(); await rejected;
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, 'cancelled');
});
