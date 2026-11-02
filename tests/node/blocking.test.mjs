import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,appendFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Manager} from '../../codex-monitor/runtime/manager.js';
import {watchInputHistory} from '../../codex-monitor/runtime/input-history.js';
import {summarize} from '../../codex-monitor/runtime/report.js';

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'monitor-block-')),thread=randomUUID(),history=path.join(root,'history.jsonl');
  await writeFile(history,JSON.stringify({session_id:thread,text:'Old prompt'})+'\n');
  const host=new EventEmitter();host.goal={threadId:thread,createdAt:1,updatedAt:1,objective:'Train',status:'active',tokenBudget:10000,tokensUsed:1};
  host.submissions=[];host.mutations=[];
  host.rpc=async(method,params)=>{
    if(method==='thread/loaded/list')return {data:[thread]};
    if(method==='thread/resume')return {thread:{id:thread}};
    if(method==='config/read')return {config:{history:{persistence:'save-all'}}};
    if(method==='thread/goal/get')return {goal:structuredClone(host.goal)};
    if(method==='thread/turns/list')return {data:[{id:'caller',status:'inProgress'}]};
    if(method==='thread/read')return {thread:{status:{type:'active'}}};
    if(method==='thread/goal/set'){host.mutations.push(params);throw Error('Blocking must not mutate goals');}
    if(method==='turn/start'){host.submissions.push(params);return {turn:{id:'callback'}};}
    throw Error(method);
  };host.close=async()=>{};
  const manager=new Manager(path.join(root,'state'),thread,{connect:async()=>host,historyFile:history});
  t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const start=(name='fixture')=>manager.start({name,instructions:'Inspect the result',options:{cwd:root,watch_file:name,timeout_ms:20000}});
  const monitor=await start();
  const armed=async()=>{while(manager.wait?.state!=='waiting')await manager.changes.wait(manager.changes.revision,1000);};
  const block=(params={},signal)=>manager.blockWait({timeout_ms:5000,input_poll_ms:50,...params},signal);
  return {root,history,thread,host,manager,monitor,start,armed,block};
}

test('blocking event returns evidence in the existing call without goal mutation or a callback turn',async t=>{
  const f=await fixture(t),pending=f.block();await f.armed();
  assert.equal((await f.manager.beginWait({})).state,'wait_active');
  f.manager.event(f.monitor.id,{event_type:'process_exit',returncode:0});
  const result=await pending;await f.manager.flush();
  assert.equal(result.mode,'blocking');assert.equal(result.state,'released');assert.equal(result.reason,'monitor_event');
  assert.equal(result.events[0].evidence.returncode,0);assert.equal(result.events[0].instructions,'Inspect the result');
  assert.equal(result.events[0].state,'returned');assert.equal(f.host.goal.status,'active');
  assert.deepEqual(f.host.mutations,[]);assert.deepEqual(f.host.submissions,[]);
  assert.equal((await f.block()).state,'ready','Returned events still require reconciliation');
  await f.manager.reviewEvent({event_ids:result.event_ids,resolution:'Result inspected'});
  assert.equal(f.manager.events[result.event_ids[0]].state,'acknowledged');
});

test('blocking detects only new same-thread CLI input, including split Unicode records',async t=>{
  const f=await fixture(t);let returned=false;
  const pending=f.block().then(r=>{returned=true;return r;});await f.armed();
  await appendFile(f.history,JSON.stringify({session_id:randomUUID(),text:'Other conversation'})+'\n');
  const data=Buffer.from(JSON.stringify({session_id:f.thread.toUpperCase(),text:'用户输入'})+'\n');
  const split=data.indexOf(Buffer.from('用户'))+1;
  await appendFile(f.history,data.subarray(0,split));await new Promise(r=>setTimeout(r,120));
  assert.equal(returned,false,'Old, other-thread and incomplete records must not release the call');
  await appendFile(f.history,data.subarray(split));
  const result=await pending;assert.equal(result.reason,'user_input');assert.equal(result.events.length,0);
  assert.ok(!JSON.stringify(result).includes('用户输入'),'Input text must never be replayed by the plugin');
  assert.equal(f.manager.records[f.monitor.id].state,'armed');assert.ok(!f.manager.records[f.monitor.id].muted);
  assert.deepEqual(f.host.submissions,[]);assert.deepEqual(f.host.mutations,[]);
});

test('blocking timeout returns once with live observers and goal unchanged',async t=>{
  const f=await fixture(t),result=await f.block({timeout_ms:100});
  assert.equal(result.state,'timed_out');assert.equal(result.reason,'timeout');assert.equal(f.host.goal.status,'active');
  assert.ok(!f.manager.records[f.monitor.id].muted);assert.equal(f.manager.jobs.size,1);assert.deepEqual(f.host.submissions,[]);
});

test('stopping an active selected wait releases the call and mutes only its notifications without stopping observers or goal',async t=>{
  const f=await fixture(t),other=await f.start('unrelated');
  const pending=f.block({wake_scope:'selected',monitor_ids:[f.monitor.id]});await f.armed();
  const stopped=await f.manager.cancelWait(),result=await pending;
  assert.equal(stopped.target,'wait');assert.equal(stopped.state,'cancelled');
  assert.equal(result.state,'cancelled');assert.equal(result.reason,'cancelled');
  assert.deepEqual(result.events,[]);assert.equal(result.goal_control,'unchanged');
  assert.equal(f.manager.records[f.monitor.id].muted,true);assert.ok(!f.manager.records[other.id].muted);
  assert.equal(f.manager.records[f.monitor.id].state,'armed');assert.equal(f.manager.jobs.size,2);
  assert.equal(f.host.goal.status,'active');assert.deepEqual(f.host.mutations,[]);
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'after-cancellation'});await f.manager.flush();
  assert.deepEqual(f.host.submissions,[]);
});

test('stopping waiting during host verification prevents late attachment',async t=>{
  const f=await fixture(t),rpc=f.host.rpc;
  let verify,release;const verifying=new Promise(r=>{verify=r;}),gate=new Promise(r=>{release=r;});
  f.host.rpc=async(method,params)=>{if(method==='config/read'){verify();await gate;}return rpc(method,params);};
  const pending=f.block({timeout_ms:100});await verifying;
  await f.manager.cancelWait();release();
  const result=await pending;assert.equal(result.state,'cancelled');assert.equal(result.reason,'cancelled');
  assert.equal(f.manager.wait,null);assert.equal(f.manager.jobs.size,1);
  assert.ok(!f.manager.records[f.monitor.id].muted);assert.deepEqual(f.host.mutations,[]);
});

test('a burst of events stays local until the evidence returned by blocking is reconciled',async t=>{
  const f=await fixture(t),pending=f.block();await f.armed();
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'first'});
  const result=await pending;
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'second'});
  await f.manager.flush();assert.equal(f.host.submissions.length,0);
  assert.equal(Object.values(f.manager.events).filter(e=>e.state==='pending').length,1);
  await f.manager.acknowledge({event_ids:result.event_ids,resolution:'First result inspected'});
  await f.manager.flush();assert.equal(f.host.submissions.length,1);
});

test('blocking releases and suppresses obsolete task notifications on an explicit goal edit',async t=>{
  const f=await fixture(t),pending=f.block();await f.armed();
  f.host.goal.objective='A different task';
  f.host.emit('notification','thread/goal/updated',{threadId:f.thread,turnId:null,goal:structuredClone(f.host.goal)});
  const result=await pending;assert.equal(result.reason,'goal_changed');assert.equal(result.state,'cancelled');
  assert.equal(f.manager.records[f.monitor.id].muted,true);assert.equal(f.manager.jobs.size,1);
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'obsolete'});await f.manager.flush();
  assert.equal(f.host.submissions.length,0);assert.deepEqual(f.host.mutations,[]);
});

test('reasserting the same active goal preserves the blocking wait and live observers',async t=>{
  const f=await fixture(t),pending=f.block();await f.armed();f.host.goal.updatedAt++;
  f.host.emit('notification','thread/goal/updated',{threadId:f.thread,turnId:null,goal:structuredClone(f.host.goal)});
  assert.equal(f.manager.wait.state,'waiting');assert.ok(!f.manager.records[f.monitor.id].muted);
  f.manager.event(f.monitor.id,{event_type:'process_exit'});assert.equal((await pending).reason,'monitor_event');
});

test('a manual pause arriving during native turn verification prevents attachment',async t=>{
  const f=await fixture(t),rpc=f.host.rpc;
  f.host.rpc=async(method,params)=>{
    if(method==='thread/turns/list'){
      f.host.goal.status='paused';
      f.host.emit('notification','thread/goal/updated',{threadId:f.thread,turnId:null,goal:structuredClone(f.host.goal)});
    }
    return rpc(method,params);
  };
  const result=await f.block();assert.equal(result.state,'ready');assert.equal(f.manager.wait,null);
  assert.equal(f.host.goal.status,'paused');assert.deepEqual(f.host.mutations,[]);
});

test('normal goal usage accounting during turn verification still allows blocking',async t=>{
  const f=await fixture(t),rpc=f.host.rpc;
  f.host.rpc=async(method,params)=>{
    if(method==='thread/turns/list'){
      f.host.goal.tokensUsed++;
      f.host.emit('notification','thread/goal/updated',{threadId:f.thread,turnId:'caller',goal:structuredClone(f.host.goal)});
    }
    return rpc(method,params);
  };
  const pending=f.block();await f.armed();f.manager.event(f.monitor.id,{event_type:'process_exit'});
  assert.equal((await pending).reason,'monitor_event');assert.deepEqual(f.host.mutations,[]);
});

test('a failed caller turn releases blocking without muting observers needed after recovery',async t=>{
  const f=await fixture(t);await f.manager.activateDefaults();const pending=f.block();await f.armed();
  f.host.emit('notification','turn/completed',{threadId:f.thread,turn:{id:'caller',status:'failed'}});
  assert.equal((await pending).reason,'turn_failed');assert.equal(f.manager.recovery.state.enabled,true);
  assert.ok(!f.manager.records[f.monitor.id].muted);assert.equal(f.manager.jobs.size,1);
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'finished'});await f.manager.flush();
  assert.equal(f.host.submissions.length,0);assert.equal(Object.values(f.manager.events)[0].state,'pending');
});

test('disabled CLI persistence refuses blocking even when an old history file exists',async t=>{
  const f=await fixture(t),rpc=f.host.rpc;
  f.host.rpc=async(method,params)=>method==='config/read'?{config:{history:{persistence:'none'}}}:rpc(method,params);
  const result=await f.block();assert.equal(result.state,'input_unavailable');assert.match(result.reason,/persistence is disabled/);
  assert.equal(f.manager.wait,null);assert.deepEqual(f.host.mutations,[]);
});

test('omitted blocking timeout records an explicit one-hour deadline',async t=>{
  const f=await fixture(t),before=Date.now(),pending=f.manager.blockWait({input_poll_ms:50});await f.armed();
  const deadline=f.manager.wait.deadline;
  assert.ok(deadline>=before+3600000&&deadline<=Date.now()+3600000);
  f.manager.event(f.monitor.id,{event_type:'process_exit'});await pending;
});

test('blocking event timing freezes poll and monitor elapsed time independently of source timestamps and later reads',async t=>{
  const f=await fixture(t),registered=f.manager.records[f.monitor.id].registered_at;
  t.mock.timers.enable({apis:['Date'],now:registered+1000});
  const pending=f.block();await f.armed();const started=f.manager.wait.started_at;
  t.mock.timers.setTime(started+2500);
  f.manager.event(f.monitor.id,{event_type:'process_exit',timestamp:1,timing:{wait_elapsed_ms:9999999}});
  const result=await pending,event=result.events[0];
  assert.equal(result.elapsed_ms,2500);assert.equal(result.released_at,started+2500);
  assert.deepEqual(event.timing,{wait_basis:'poll',wait_started_at:started,wait_elapsed_ms:2500,
    monitor_registered_at:registered,monitor_elapsed_ms:3500,wait_id:result.id,wait_mode:'blocking'});
  t.mock.timers.setTime(started+5000);
  const inspected=await f.manager.reviewEvent({event_ids:result.event_ids});
  assert.deepEqual(inspected.events[0].timing,event.timing);
  assert.deepEqual(f.manager.snapshot().events[0].timing,event.timing);
  assert.deepEqual(summarize(f.manager.snapshot(),'live').events[0].timing,event.timing);
});

test('events without an applicable poll report monitor registration duration instead of a stale wait duration',async t=>{
  const f=await fixture(t),registered=f.manager.records[f.monitor.id].registered_at;
  t.mock.timers.enable({apis:['Date'],now:registered+1200});
  f.manager.wait={id:'previous-wait',state:'released',started_at:registered+100,monitor_ids:[f.monitor.id]};
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'done'});
  const event=Object.values(f.manager.events)[0];
  assert.deepEqual(event.timing,{wait_basis:'monitor',wait_started_at:registered,wait_elapsed_ms:1200,
    monitor_registered_at:registered,monitor_elapsed_ms:1200});
  assert.equal(event.occurred_at,registered+1200);
});

test('legacy pause waiting records an applicable start time for structured event timing',async t=>{
  const f=await fixture(t);f.host.goal=null;
  const wait=await f.manager.beginWait({});assert.equal(wait.state,'waiting');assert.ok(Number.isFinite(wait.started_at));
  t.mock.timers.enable({apis:['Date'],now:wait.started_at+800});
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'done'});
  const event=Object.values(f.manager.events)[0];assert.equal(event.timing.wait_elapsed_ms,800);
  assert.equal(event.timing.wait_basis,'poll');assert.equal(event.timing.wait_mode,'pause');
});

test('first operational use enables bounded recovery by default and respects manual interruption',async t=>{
  const f=await fixture(t);await f.manager.activateDefaults();
  const state=f.manager.recovery.snapshot();assert.equal(state.enabled,true);assert.equal(state.policy.retry_mode,'all_failed');
  assert.equal(state.policy.retry_interval_ms,300000);assert.equal(state.policy.max_elapsed_ms,10800000);
  assert.equal(state.policy.max_attempts,36);assert.equal(state.policy.lifetime_ms,86400000);
  f.host.emit('notification','turn/completed',{threadId:f.thread,turn:{id:'caller',status:'interrupted'}});
  assert.equal(f.manager.recovery.state.enabled,false);await f.manager.activateDefaults();
  assert.equal(f.manager.recovery.state.enabled,false,'Defaults cannot undo a user interruption');
});

test('explicit recovery opt-out takes effect immediately while default activation is checking the host',async t=>{
  const f=await fixture(t),rpc=f.host.rpc;let reached,release;
  const verifying=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});
  f.host.rpc=async(method,params)=>{if(method==='thread/turns/list'){reached();await gate;}return rpc(method,params);};
  const activating=f.manager.activateDefaults();await verifying;
  const disabling=f.manager.configureRecovery({enabled:false});
  try{
    await new Promise(r=>setImmediate(r));
    assert.equal(f.manager.recovery.state.state,'disabled');
  }finally{release();await Promise.all([activating,disabling]);}
  assert.equal(f.manager.recovery.state.enabled,false);await f.manager.activateDefaults();
  assert.equal(f.manager.recovery.state.enabled,false);
});

test('installation and per-thread recovery opt-outs survive subsequent monitor operations',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'settings.json'),JSON.stringify({recovery_enabled:false}));
  await f.manager.activateDefaults();assert.equal(f.manager.recovery.state.enabled,false);
  await writeFile(path.join(f.root,'settings.json'),JSON.stringify({recovery_enabled:true}));
  await f.manager.activateDefaults();assert.equal(f.manager.recovery.state.enabled,false);
  await f.manager.configureRecovery({enabled:false});await f.manager.activateDefaults();assert.equal(f.manager.recovery.state.enabled,false);
});

test('restart preserves explicit recovery opt-outs and never restores a previous running supervisor',async t=>{
  const f=await fixture(t);await f.manager.activateDefaults();assert.equal(f.manager.recovery.state.enabled,true);
  await f.manager.close();
  const restarted=new Manager(f.manager.directory,f.thread,{connect:async()=>f.host,historyFile:f.history});
  try{await restarted.activateDefaults();assert.equal(restarted.recovery.state.enabled,false);assert.equal(restarted.recovery.state.state,'interrupted');}
  finally{await restarted.close();}
});

test('blocking MCP disconnect holds callbacks while preserving observation and queued evidence',async t=>{
  const f=await fixture(t),controller=new AbortController(),pending=f.block({},controller.signal);await f.armed();controller.abort();
  assert.equal((await pending).state,'interrupted');assert.equal(f.manager.jobs.size,1);
  assert.ok(!f.manager.records[f.monitor.id].muted);assert.equal(f.host.goal.status,'active');
  f.manager.event(f.monitor.id,{event_type:'process_exit'});await f.manager.flush();assert.deepEqual(f.host.submissions,[]);
  const event=Object.values(f.manager.events)[0];assert.equal(event.state,'pending');
  assert.equal((await f.block()).state,'ready');
  await f.manager.reviewEvent({event_ids:[event.id],resolution:'Inspected after reconnect'});
  const attached=f.block();await f.armed();assert.equal(f.manager.snapshot().callback_hold,undefined);
  f.manager.event(f.monitor.id,{event_type:'file_change',path:'new'});assert.equal((await attached).reason,'monitor_event');
});

test('thread-wide blocking includes monitors registered while the caller is waiting',async t=>{
  const f=await fixture(t),pending=f.block();await f.armed();const other=await f.start('later');
  f.manager.event(other.id,{event_type:'process_exit'});
  const result=await pending;assert.equal(result.reason,'monitor_event');assert.equal(result.events[0].monitor_id,other.id);
  assert.deepEqual(f.host.submissions,[]);
});

test('blocking refuses unresolved results, missing guards, manual pauses and unreadable CLI history',async t=>{
  const f=await fixture(t);f.manager.records[f.monitor.id].notify_on=['file_change'];
  assert.equal((await f.block()).state,'guard_required');
  f.manager.records[f.monitor.id].notify_on.push('monitor_error','monitor_expired');
  f.host.goal.status='paused';assert.equal((await f.block()).state,'goal_paused');assert.equal(f.manager.wait,null);
  f.host.goal.status='active';await rm(f.history);assert.equal((await f.block()).state,'input_unavailable');
  assert.equal(f.manager.wait,null);assert.deepEqual(f.host.mutations,[]);
});

test('history replacement during blocking releases the tool instead of leaving it stuck',async t=>{
  const f=await fixture(t),pending=f.block();await f.armed();await rename(f.history,f.history+'.old');await writeFile(f.history,'');
  assert.equal((await pending).reason,'input_unavailable');assert.ok(!f.manager.records[f.monitor.id].muted);
});

test('input tail ignores existing incomplete records and closes without late wakes',async t=>{
  const f=await fixture(t);await appendFile(f.history,JSON.stringify({session_id:f.thread,text:'Pre-existing partial'}));
  const wakes=[],observer=await watchInputHistory(f.history,f.thread,r=>wakes.push(r),50);
  await appendFile(f.history,'\n'+JSON.stringify({session_id:randomUUID(),text:'Other'})+'\n');
  await new Promise(r=>setTimeout(r,120));assert.deepEqual(wakes,[]);
  observer.close();await appendFile(f.history,JSON.stringify({session_id:f.thread,text:'After close'})+'\n');
  await new Promise(r=>setTimeout(r,120));assert.deepEqual(wakes,[]);
});

test('input tail drains a large other-thread backlog without requiring another file write',async t=>{
  const f=await fixture(t);let observer;
  const wake=new Promise(resolve=>{watchInputHistory(f.history,f.thread,resolve,50).then(value=>{observer=value;});});
  while(!observer)await new Promise(resolve=>setImmediate(resolve));
  try{
    const other=JSON.stringify({session_id:randomUUID(),text:'x'.repeat(1000)})+'\n';
    await appendFile(f.history,other.repeat(2200)+JSON.stringify({session_id:f.thread,text:'New input'})+'\n');
    assert.equal(await wake,'user_input');
  }finally{observer.close();}
});
