import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/subagents.mjs';

function hold(host, method, matches = () => true) {
  const rpc = host.rpc; let reached, release;
  const entered = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
  host.rpc = async (name, args) => {
    const result = await rpc(name, args);
    if (name === method && matches(args)) { reached(); await gate; }
    return result;
  };
  return { entered, release };
}

for (const trigger of ['completed', 'disconnected']) test(`stale turn read cannot arm child poll after ${trigger}`, {timeout:5000}, async t => {
  const f=await fixture(t);await f.start(f.a);
  const gate=hold(f.host,'thread/turns/list'),p=f.poll(f.a,{timeout_ms:100});await gate.entered;
  if(trigger==='completed')f.host.emit('notification','turn/completed',{threadId:f.a,turn:{id:`turn-${f.a}`,status:'completed'}});
  else f.host.emit('disconnected','fixture lost transport');
  gate.release();const result=await p;
  assert.equal(result.reason,'agent_activity');assert.equal(f.m.delegation.waits[f.a],undefined);
});

test('stale subscription result cannot register work for a child that closed during verification', {timeout:5000}, async t => {
  const f=await fixture(t),gate=hold(f.host,'thread/resume',p=>p.threadId===f.a),pending=f.start(f.a);
  await gate.entered;f.host.emit('notification','thread/closed',{threadId:f.a});f.meta.delete(f.a);gate.release();
  await assert.rejects(pending,/activity|closed|loaded/i);assert.equal(f.m.jobs.size,0);
});

test('failed old verification cannot evict a newer subscription and interrupt its wait', {timeout:5000}, async t => {
  const f=await fixture(t);let calls=0;
  f.host.goals.set(f.a,{threadId:f.a,objective:'Work',status:'active',createdAt:1,updatedAt:1,tokensUsed:0});
  const gate=hold(f.host,'thread/resume',p=>p.threadId===f.a&&++calls===1),old=f.start(f.a);
  const rejected=assert.rejects(old,/activity changed/);await gate.entered;
  f.host.emit('notification','turn/completed',{threadId:f.a,turn:{id:'old-turn',status:'completed'}});
  const current=await f.start(f.a),waiting=f.poll();await f.armed(f.a);
  gate.release();await rejected;
  assert.equal((await f.start(f.a)).id,current.id);
  assert.equal(f.m.delegation.waits[f.a].state,'waiting');
  assert.equal(calls,2,'A stale failure must not force a third subscription');
  f.m.delegation.cancel(f.a);await waiting;
});

test('cancellation before ancestry verification returns cannot attach a late child wait', {timeout:5000}, async t => {
  const f=await fixture(t);await f.start(f.a);f.m.delegation.disconnect();
  const gate=hold(f.host,'thread/read',p=>p.threadId===f.a),p=f.poll(f.a,{timeout_ms:100});await gate.entered;
  f.m.delegation.cancel(f.a);gate.release();const result=await p;
  assert.equal(result.reason,'agent_activity');assert.notEqual(f.m.delegation.waits[f.a]?.state,'waiting');
});

test('late registration cannot make two delegated thread waits overlap', {timeout:5000}, async t => {
  const f=await fixture(t);await f.start(f.a);const existing=await f.start(f.grand);
  const pg=f.poll(f.grand);await f.armed(f.grand);
  // Ancestor selects only its own source explicitly; it must not expand later.
  const own=f.m.snapshot(undefined,false,f.a).monitors.find(m=>m.creator_thread_id===f.a);
  const pa=f.poll(f.a,{wake_scope:'selected',monitor_ids:[own.id]});await f.armed(f.a);
  const later=await f.start(f.grand,'later');f.emit(later);const g=await pg;
  assert.equal(g.events[0].monitor_id,later.id);assert.deepEqual(f.m.delegation.waits[f.a].monitor_ids,[own.id]);
  f.m.delegation.cancel(f.a);await pa;assert.equal(f.m.records[existing.id].muted,undefined);
});

test('returned child evidence prevents an ancestor from claiming its subsequent burst', {timeout:5000}, async t => {
  const f=await fixture(t);await f.start(f.a);const g=await f.start(f.grand),pg=f.poll(f.grand);await f.armed(f.grand);f.emit(g);await pg;
  const p=f.poll(f.a,{timeout_ms:100});
  // Ancestor must reconcile/defer instead of opening a competing branch lease.
  const result=await p;assert.equal(result.state,'wait_active');
  f.emit(g);await f.m.flush();assert.equal(f.host.submissions.length,0);
});

test('closing an intermediate ancestor releases descendant waits and subsequent events target root', {timeout:5000}, async t => {
  const f=await fixture(t),g=await f.start(f.grand),pg=f.poll(f.grand);await f.armed(f.grand);
  f.host.emit('notification','thread/closed',{threadId:f.a});assert.equal((await pg).reason,'ancestor_stopped');
  f.emit(g);await f.m.flush();assert.equal(f.host.submissions[0].threadId,f.parent);
});

test('disconnect during child handling exposes uncertain evidence to the root without replay', {timeout:5000}, async t => {
  const f=await fixture(t),a=await f.start(f.a),p=f.poll();await f.armed(f.a);f.emit(a);const result=await p;
  f.host.emit('disconnected','fixture');const event=f.m.events[result.event_ids[0]];
  assert.equal(event.state,'unknown');assert.equal(event.handoff.reason,'host_disconnected');
  await f.m.flush();assert.equal(f.host.submissions.length,0);
  const ready=await f.m.blockWait({timeout_ms:100});assert.equal(ready.state,'ready');assert.ok(ready.event_ids.includes(event.id));
});

test('service is not idle while delegated verification is in flight without a sensor yet', {timeout:5000}, async t => {
  const f=await fixture(t),gate=hold(f.host,'thread/read',p=>p.threadId===f.a),p=f.start(f.a);await gate.entered;
  assert.equal(f.m.isIdle(),false);gate.release();await p;
});

test('child closure during queued registration prevents a late sensor launch', {timeout:5000}, async t => {
  const f=await fixture(t);let release,entered;
  const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const occupied=f.m.operations(async()=>{entered();await gate;});await started;
  const p=f.start(f.a);p.catch(()=>{});
  while(!f.m.delegation.members[f.a])await f.m.changes.wait(f.m.changes.revision,100);
  f.host.emit('notification','thread/closed',{threadId:f.a});release();await occupied;
  await assert.rejects(p,/activity changed/);assert.equal(f.m.jobs.size,0);
});

for (const change of ['accounting','objective']) test(`goal ${change} during final child turn read is reconciled`, {timeout:5000}, async t => {
  const f=await fixture(t);await f.start(f.a);
  f.host.goal={threadId:f.parent,objective:'work',status:'active',createdAt:1,updatedAt:1,tokenBudget:1000,tokensUsed:1,timeUsedSeconds:1};
  const gate=hold(f.host,'thread/turns/list'),p=f.poll(f.a,{timeout_ms:100});await gate.entered;
  f.host.emit('notification','thread/goal/updated',{threadId:f.parent,turnId:'running-parent-turn',goal:{...f.host.goal,tokensUsed:2,updatedAt:2,...(change==='objective'?{objective:'changed'}:{})}});
  gate.release();const result=await p;assert.equal(result.reason,change==='objective'?'agent_activity':'timeout');
});

test('task-wide child wait includes registrations made while its host verification is pending', {timeout:5000}, async t => {
  const f=await fixture(t);await f.start(f.a);const gate=hold(f.host,'thread/turns/list'),p=f.poll();await gate.entered;
  const later=await f.start(f.a,'during-preparation');gate.release();await f.armed(f.a);
  assert.ok(f.m.delegation.waits[f.a].monitor_ids.includes(later.id));f.emit(later);assert.equal((await p).events[0].monitor_id,later.id);
});

test('pending child poll resolves if persistence fails at event handoff', {timeout:5000}, async t => {
  const f=await fixture(t),monitor=await f.start(f.a),p=f.poll();await f.armed(f.a);
  // Inject evidence before the handoff save, without failing an earlier sensor save.
  const event={id:'persistence-event',monitor_id:monitor.id,state:'pending',event_type:'file_change',
    occurred_at:Date.now(),expires_at:Date.now()+60000,evidence:{path:'progress.log'}};
  f.m.events[event.id]=event;
  const save=f.m.save.bind(f.m);f.m.save=()=>{throw Error('disk full');};
  try {
    f.m.delegation.release(f.a,'monitor_event');const result=await p;
    assert.equal(result.state,'interrupted');assert.match(result.error,/disk full/);
    assert.deepEqual(result.event_ids,[event.id]);assert.equal(event.state,'unknown');
    assert.equal(result.events[0].state,'unknown');assert.ok(f.m.callbacksHeld());
    await f.m.flush();assert.equal(f.host.submissions.length,0);
  }
  finally { f.m.save=save; }
});
