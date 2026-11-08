import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,appendFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Manager} from '../../codex-monitor/runtime/manager.js';
import {ancestry} from '../../codex-monitor/runtime/ancestry.js';
import {readStatus,compactReport,summarize} from '../../codex-monitor/runtime/report.js';
import {validateRequest} from '../../codex-monitor/runtime/validation.js';

import {fixture} from './fixtures/subagents.mjs';

test('host ancestry identifies nested children, ignores forks and rejects cycles/conflicting metadata',async t=>{
 const f=await fixture(t);
 assert.deepEqual((await ancestry(f.host,f.grand)).ancestors,[f.a,f.parent]);
 const rpc=f.host.rpc;
 f.host.rpc=async(method,p)=>method==='thread/read'?{thread:{id:p.threadId,source:'cli',forkedFromId:f.parent,sessionId:f.parent}}:rpc(method,p);
 assert.equal((await ancestry(f.host,f.other)).owner,f.other);
 f.host.rpc=async()=>({thread:{id:f.a,parentThreadId:f.parent,source:{subAgent:{thread_spawn:{parent_thread_id:f.other}}}}});
 await assert.rejects(ancestry(f.host,f.a),/Conflicting/);
 f.host.rpc=rpc;f.meta.set(f.parent,f.a);await assert.rejects(ancestry(f.host,f.a),/Cyclic/);
});

test('same-name siblings are separate, equivalent caller registration reuses; root shares capacity and sees provenance',async t=>{
 const f=await fixture(t),a=await f.start(f.a),b=await f.start(f.b);
 assert.notEqual(a.id,b.id);assert.equal((await f.start(f.a)).id,a.id);
 assert.equal(a.owner_thread_id,f.parent);assert.equal(a.creator_thread_id,f.a);
 assert.equal(f.m.snapshot().capacity.used,2);
 assert.equal(f.m.snapshot().monitors.length,2);assert.equal(f.m.snapshot(undefined,false,f.a).monitors.length,1);
 assert.throws(()=>f.m.delegation.monitor(f.a,b.id),/caller scope/);
 await assert.rejects(f.start(f.other),/does not belong/);
});

test('nested scope includes descendants but excludes siblings and root monitors',async t=>{
 const f=await fixture(t),a=await f.start(f.a),g=await f.start(f.grand),b=await f.start(f.b),r=await f.start();
 assert.deepEqual(f.m.snapshot(undefined,false,f.a).monitors.map(x=>x.id),[a.id,g.id]);
 for(const id of [b.id,r.id])assert.throws(()=>f.m.snapshot(id,true,f.a),/caller scope/);
 assert.equal(f.m.snapshot(g.id,true,f.a).monitors[0].creator_thread_id,f.grand);
});

test('two child waits consume only their own events; root receives no duplicate and goals are untouched',async t=>{
 const f=await fixture(t),a=await f.start(f.a),b=await f.start(f.b);
 const pa=f.poll(f.a),pb=f.poll(f.b);await Promise.all([f.armed(f.a),f.armed(f.b)]);
 assert.match(compactReport(summarize(f.m.snapshot(),'live')),/2 subagents waiting/);
 f.emit(a);const ra=await pa;assert.equal(ra.events[0].monitor_id,a.id);assert.equal(f.m.delegation.waits[f.b].state,'waiting');
 f.emit(b);const rb=await pb;await f.m.flush();assert.equal(rb.events[0].monitor_id,b.id);assert.equal(f.host.submissions.length,0);
 assert.equal(ra.events[0].timing.wait_id,ra.id);assert.equal(ra.events[0].delivery_thread_id,f.a);
 assert.throws(()=>f.m.delegation.event(f.b,ra.event_ids[0],true),/caller scope/);
 assert.ok(!f.host.reads.some(r=>r.method==='thread/goal/set'));
});

test('parent and child may wait together: child claims first, unrelated parent event still wakes parent',async t=>{
 const f=await fixture(t),a=await f.start(f.a),r=await f.start();
 const pa=f.poll(f.a);await f.armed(f.a);const pr=f.m.blockWait({timeout_ms:5000,input_poll_ms:50});await f.armed(f.parent);
 f.emit(a);await pa;assert.equal(f.m.wait.state,'waiting');f.emit(r);const result=await pr;
 assert.deepEqual(result.events.map(e=>e.monitor_id),[r.id]);assert.equal(f.host.submissions.length,0);
});

test('child completion hands unacknowledged evidence back to the parent with uncertain-processing metadata',async t=>{
 const f=await fixture(t),a=await f.start(f.a),pending=f.poll();await f.armed(f.a);f.emit(a);const result=await pending;
 f.host.emit('notification','turn/completed',{threadId:f.a,turn:{id:`turn-${f.a}`,status:'completed'}});
 await f.m.flush();assert.equal(f.host.submissions.length,1);assert.equal(f.host.submissions[0].threadId,f.parent);
 const event=f.m.events[result.event_ids[0]];assert.equal(event.state,'submitted');assert.equal(event.handoff.previous_delivery,'unconfirmed');
 assert.equal(event.handoff.from_thread_id,f.a);assert.equal(f.m.jobs.size,1);
 assert.throws(()=>f.m.delegation.event(f.a,event.id,true),/another agent/);
});

test('acknowledged child evidence is never handed back or reexecuted',async t=>{
 const f=await fixture(t),a=await f.start(f.a),pending=f.poll();await f.armed(f.a);f.emit(a);const result=await pending;
 await f.m.reviewEvent({event_ids:result.event_ids,resolution:'Handled by child'});
 f.host.emit('notification','thread/closed',{threadId:f.a});await f.m.flush();assert.equal(f.host.submissions.length,0);
 assert.equal(f.m.jobs.size,1);
});

test('closed child leaves root-owned observation running and subsequent events target root',async t=>{
 const f=await fixture(t),a=await f.start(f.a),pending=f.poll();await f.armed(f.a);
 f.host.emit('notification','thread/closed',{threadId:f.a});assert.equal((await pending).reason,'agent_closed');
 f.meta.delete(f.a);f.emit(a);await f.m.flush();assert.equal(f.host.submissions[0].threadId,f.parent);
 assert.equal(f.m.records[a.id].state,'armed');
 await assert.rejects(f.start(f.a,'new-after-close'),/Missing thread/);
});

test('child timeout, client cancellation and explicit stop preserve sensors; stop mutes only selected child sources',async t=>{
 const f=await fixture(t),a=await f.start(f.a),b=await f.start(f.b);
 assert.equal((await f.poll(f.a,{timeout_ms:100})).reason,'timeout');
 const controller=new AbortController(),p=f.poll(f.a,{},controller.signal);await f.armed(f.a);controller.abort();assert.equal((await p).reason,'client_disconnected');
 const again=f.poll(f.a);await f.armed(f.a);f.m.delegation.cancel(f.a);assert.equal((await again).state,'cancelled');
 assert.equal(f.m.records[a.id].muted,true);assert.ok(!f.m.records[b.id].muted);assert.equal(f.m.jobs.size,2);
});

test('ancestor CLI input releases child waits; unrelated history cannot wake or leak prompt text',async t=>{
 const f=await fixture(t);await f.start(f.grand);const pending=f.poll(f.grand);await f.armed(f.grand);
 await appendFile(f.history,JSON.stringify({session_id:f.other,text:'Unrelated private message'})+'\n');
 await appendFile(f.history,JSON.stringify({session_id:f.a,text:'Parent private message'})+'\n');
 const result=await pending;assert.equal(result.reason,'user_input');assert.ok(!JSON.stringify(result).includes('private message'));
});

test('host queue and collaboration notifications wake child without replaying message text',async t=>{
 const f=await fixture(t);await f.start(f.a);
 for(const tool of ['sendInput','sendMessage','followupTask']){
  const p=f.poll();await f.armed(f.a);
  f.host.emit('notification','item/completed',{threadId:f.parent,item:{type:'collabAgentToolCall',tool,receiverThreadIds:[f.a],prompt:'private'}});
  assert.equal((await p).reason,'agent_input');
 }
 const p=f.poll();await f.armed(f.a);f.host.emit('notification','thread/queue/changed',{threadId:f.a});assert.equal((await p).reason,'agent_input');
});

test('overlapping nested waits rejected; same-child duplicate cannot replace pending wait',async t=>{
 const f=await fixture(t);await f.start(f.a);await f.start(f.grand);const p=f.poll(f.a);await f.armed(f.a);
 assert.equal((await f.poll(f.a)).state,'wait_active');assert.equal((await f.poll(f.grand)).state,'wait_active');
 f.m.delegation.cancel(f.a);await p;
});

test('late descendant registration joins its ancestor wait without replaying an active goal snapshot',async t=>{
 const f=await fixture(t);
 f.host.goals.set(f.a,{threadId:f.a,objective:'Work',status:'active',createdAt:1,updatedAt:1,tokensUsed:0});
 await f.start(f.a);const p=f.poll();await f.armed(f.a);const later=await f.start(f.grand,'later');
 assert.equal(f.m.delegation.waits[f.a].state,'waiting');
 assert.ok(f.m.delegation.waits[f.a].monitor_ids.includes(later.id));f.emit(later);assert.equal((await p).events[0].monitor_id,later.id);
});

test('shared connection incidents partition by creator',async t=>{
 const f=await fixture(t),a=await f.start(f.a),b=await f.start(f.b);
 f.m.records[a.id].notify_on.push('connection_lost');f.m.records[b.id].notify_on.push('connection_lost');
 f.m.connectionEvent([a.id,b.id],{event_type:'connection_lost',connection_id:'shared',incident_id:'one'});
 const incidents=Object.values(f.m.events).filter(e=>e.event_type==='connection_lost');assert.equal(incidents.length,2);
 assert.deepEqual(incidents.map(e=>e.affected_monitor_ids),[[a.id],[b.id]]);
});

test('read-only child reports follow saved root route, filter evidence, and never claim saved state is live',async t=>{
 const f=await fixture(t),a=await f.start(f.a);await f.start(f.b);await f.routing.resolve(f.a);
 const before=await readFile(path.join(f.root,f.parent,'state.json'),'utf8');
 const report=await readStatus(f.a,{details:'full'},f.root);assert.equal(report.source,'saved');assert.equal(report.verified,false);
 assert.equal(report.owner_thread_id,f.parent);assert.deepEqual(report.monitors.map(r=>r.id),[a.id]);
 assert.equal(report.recovery.state,'managed_by_owner');assert.equal(await readFile(path.join(f.root,f.parent,'state.json'),'utf8'),before);
 assert.deepEqual((await readStatus(f.a.toUpperCase(),{details:'full'},f.root)).monitors.map(x=>x.id),[a.id]);
});

test('service restart does not rearm observers or reuse an outstanding child delivery lease',async t=>{
 const f=await fixture(t),a=await f.start(f.a),p=f.poll();await f.armed(f.a);f.emit(a);const r=await p;
 await f.m.close();const restored=new Manager(f.m.directory,f.parent,{connect:async()=>f.host,historyFile:f.history});
 try{assert.equal(restored.jobs.size,0);assert.equal(restored.events[r.event_ids[0]].state,'unknown');await restored.flush();assert.equal(f.host.submissions.length,0);}finally{await restored.close();}
});

test('routing refuses legacy active child state rather than orphaning it, and fails closed on changed ancestry',async t=>{
 const f=await fixture(t);const fs=await import('node:fs/promises');await fs.mkdir(path.join(f.root,f.a));
 await writeFile(path.join(f.root,f.a,'state.json'),JSON.stringify({monitors:{old:{state:'armed'}}}));
 await assert.rejects(f.routing.resolve(f.a),/Legacy child/);
 await writeFile(path.join(f.root,f.a,'state.json'),JSON.stringify({monitors:{old:{state:'stopped'}}}));
 assert.equal((await f.routing.resolve(f.a)).owner,f.parent);
 f.meta.set(f.a,f.other);f.host.emit('disconnected','test');await assert.rejects(f.routing.resolve(f.a),/ancestry changed/);
});

test('manual parent interruption releases child waits and prevents later callbacks from reviving the task',async t=>{
 const f=await fixture(t),a=await f.start(f.a),p=f.poll();await f.armed(f.a);
 f.host.emit('notification','turn/completed',{threadId:f.parent,turn:{id:'parent-turn',status:'interrupted'}});
 assert.equal((await p).reason,'parent_stopped');f.emit(a);await f.m.flush();assert.equal(f.host.submissions.length,0);
 assert.match(f.m.snapshot().callback_hold,/Parent conversation interrupted/);assert.equal(f.m.records[a.id].state,'armed');
 assert.equal((await f.poll()).state,'parent_stopped');
});

test('manual parent pause releases child wait and blocks a new delegated wait without goal mutation',async t=>{
 const f=await fixture(t);await f.start(f.a);const p=f.poll();await f.armed(f.a);
 f.host.goal={status:'paused'};f.host.emit('notification','thread/goal/updated',{threadId:f.parent,turnId:null,goal:f.host.goal});
 assert.equal((await p).reason,'parent_stopped');assert.equal((await f.poll()).state,'goal_paused');
});

test('parent interruption during delegated preparation cannot attach a late wait',async t=>{
 const f=await fixture(t);await f.start(f.a);const rpc=f.host.rpc;let reached,release;
 const reachedP=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});
 f.host.rpc=async(method,p)=>{if(method==='thread/turns/list'){reached();await gate;}return rpc(method,p);};
 const pending=f.poll();await reachedP;
 f.host.emit('notification','turn/completed',{threadId:f.parent,turn:{id:'parent-turn',status:'interrupted'}});release();
 assert.equal((await pending).reason,'agent_activity');assert.equal(f.m.delegation.waits[f.a],undefined);
});

test('delayed old turn completion cannot release a new child wait',async t=>{
 const f=await fixture(t);await f.start(f.a);const p=f.poll();await f.armed(f.a);
 f.host.emit('notification','turn/completed',{threadId:f.a,turn:{id:'older-turn',status:'completed'}});
 assert.equal(f.m.delegation.waits[f.a].state,'waiting');f.m.delegation.cancel(f.a);await p;
});

test('stopping a child monitor releases its wait while retaining siblings and observed workloads',async t=>{
 const f=await fixture(t),a=await f.start(f.a),b=await f.start(f.b),p=f.poll();await f.armed(f.a);
 await f.m.stop(a.id);assert.equal((await p).reason,'monitor_stopped');assert.equal(f.m.records[b.id].state,'armed');assert.equal(f.m.jobs.size,1);
});

test('missing guards cannot block and adding an unguarded source releases an existing scoped wait',async t=>{
 const f=await fixture(t);await f.start(f.a);const p=f.poll();await f.armed(f.a);
 await f.m.start({name:'unguarded',instructions:'Inspect',options:{cwd:f.root,watch_file:'u',timeout_ms:20000},notify_on:['file_change']},undefined,f.a);
 assert.equal((await p).reason,'guard_changed');assert.equal((await f.poll()).state,'guard_required');
});

test('all task members share the 32-observer ceiling and warn at 24, without cross-branch deduplication',async t=>{
 const f=await fixture(t);for(let n=0;n<32;n++)await f.start(n%2?f.a:f.b,'work-'+n);
 assert.equal(f.m.snapshot().capacity.state,'full');assert.equal(f.m.snapshot(undefined,false,f.a).capacity.used,32);
 await assert.rejects(f.start(f.a,'overflow'),error=>error.code==='MONITOR_CAPACITY_EXCEEDED');
});

test('descendant routing persists ancestor read scopes and offline fallback never changes an established child owner',async t=>{
 const f=await fixture(t),g=await f.start(f.grand);await f.routing.resolve(f.grand);
 const report=await readStatus(f.a,{details:'full'},f.root);assert.deepEqual(report.monitors.map(x=>x.id),[g.id]);assert.equal(report.owner_thread_id,f.parent);
 f.host.emit('disconnected','fixture');f.host.rpc=async()=>{throw Error('unavailable');};
 await assert.rejects(f.routing.resolve(f.grand));
 const fallback=await f.routing.resolve(f.other);assert.equal(fallback.owner,f.other);assert.match(fallback.warning,/unverified/);
});

test('child burst stays reserved until acknowledgement while unrelated branches continue',async t=>{
 const f=await fixture(t),a=await f.start(f.a),b=await f.start(f.b),p=f.poll();await f.armed(f.a);f.emit(a);const first=await p;
 f.emit(a);f.emit(b);await f.m.flush();assert.equal(f.host.submissions.length,1);
 assert.equal(Object.values(f.m.events).filter(e=>e.monitor_id===a.id&&e.state==='pending').length,1);
 await f.m.reviewEvent({event_ids:first.event_ids,resolution:'Inspected first event'});await f.m.flush();assert.equal(f.host.submissions.length,2);
});

test('cancelling a released child wait suppresses later notifications without replay on child closure',async t=>{
 const f=await fixture(t),a=await f.start(f.a),p=f.poll();await f.armed(f.a);f.emit(a);await p;f.emit(a);
 assert.equal(f.m.delegation.cancel(f.a).state,'cancelled');f.host.emit('notification','thread/closed',{threadId:f.a});await f.m.flush();
 assert.equal(f.host.submissions.length,0);assert.ok(Object.values(f.m.events).every(e=>e.state==='suppressed'));assert.equal(f.m.jobs.size,1);
});

test('read-only validation reports verified task routing and rejects child recovery before mutation',async t=>{
 const f=await fixture(t);
 const result=await validateRequest(f.a,path.join(f.root,f.a),{operation:'start',config:{name:'validate',instructions:'Inspect',options:{cwd:f.root,watch_file:'progress'}}},true,async()=>f.host);
 assert.equal(result.valid,true);assert.equal(result.routing.owner_thread_id,f.parent);assert.equal(f.m.jobs.size,0);
 assert.ok(!f.host.reads.some(x=>['thread/resume','thread/goal/set','turn/start'].includes(x.method)));
 const denied=await validateRequest(f.a,path.join(f.root,f.a),{operation:'recovery',config:{enabled:false}},true,async()=>f.host);
 assert.equal(denied.valid,false);assert.match(denied.errors[0].message,/root agent/);
});

test('child goal changes and exhausted budgets release or refuse waiting without touching the parent goal',async t=>{
 const f=await fixture(t);await f.start(f.a);const p=f.poll();await f.armed(f.a);
 f.host.emit('notification','thread/goal/updated',{threadId:f.a,turnId:null,goal:{status:'paused'}});
 assert.equal((await p).reason,'goal_changed');const rpc=f.host.rpc;
 f.host.rpc=async(method,args)=>method==='thread/goal/get'&&args.threadId===f.a?{goal:{status:'active',tokenBudget:10,tokensUsed:10}}:rpc(method,args);
 assert.equal((await f.poll()).state,'goal_paused');assert.equal(f.host.goal,null);
});

test('ordinary goal accounting keeps child blocked, while an explicit active parent goal edit releases it',async t=>{
 const f=await fixture(t);
 f.host.goal={threadId:f.parent,objective:'Work',status:'active',createdAt:1,updatedAt:1,tokenBudget:1000,tokensUsed:1,timeUsedSeconds:1};
 f.host.goals.set(f.a,{...f.host.goal,threadId:f.a});
 // Subscription publishes the initial active goal before registration finishes.
 await f.start(f.a);
 const p=f.poll();await f.armed(f.a);
 const progress={...f.host.goal,tokensUsed:5,timeUsedSeconds:2,updatedAt:2};
 f.host.emit('notification','thread/goal/updated',{threadId:f.parent,turnId:'root-turn',goal:progress});
 f.host.emit('notification','thread/goal/updated',{threadId:f.a,turnId:'child-turn',goal:{...progress,threadId:f.a}});
 assert.equal(f.m.delegation.waits[f.a].state,'waiting');
 f.host.emit('notification','thread/goal/updated',{threadId:f.parent,turnId:null,goal:{...progress,objective:'Changed task'}});
 assert.equal((await p).reason,'parent_stopped');
});

test('inactive member reclamation preserves monitor provenance and admits subsequent child tasks',async t=>{
 const f=await fixture(t),a=await f.start(f.a);await f.m.stop(a.id);
 for(let i=0;i<130;i++){const child=randomUUID();f.meta.set(child,f.parent);await f.m.delegation.verify(child);}
 assert.ok(Object.keys(f.m.delegation.members).length<128);assert.equal(f.m.records[a.id].creator_thread_id,f.a);
 assert.equal(f.m.snapshot(a.id,true,f.a).monitors[0].creator_thread_id,f.a);
});

test('concurrent child registration is not pruned while subscribing before its monitor record exists',async t=>{
 const f=await fixture(t),rpc=f.host.rpc;let reached,release;
 const reachedP=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});
 f.host.rpc=async(method,p)=>{if(method==='thread/resume'&&p.threadId===f.a){reached();await gate;}return rpc(method,p);};
 const pending=f.start(f.a);await reachedP;await f.start(f.b);
 assert.ok(f.m.delegation.members[f.a]);release();const a=await pending;
 assert.deepEqual(a.creator_ancestors,[f.parent]);assert.equal(a.creator_nickname,'Alice');
});
