import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {normalizeMonitor,validateRequest} from '../../codex-monitor/runtime/validation.js';
import {validateOptions} from '../../codex-monitor/runtime/sensors.js';
import {SshSession,SshFailure,sshReadinessMs} from '../../codex-monitor/runtime/ssh-session.js';
import {SshPool} from '../../codex-monitor/runtime/ssh-monitor.js';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Manager} from '../../codex-monitor/runtime/manager.js';

test('remote directory normalization never compares remote roots with local state on Linux',()=>{
  const result=normalizeMonitor({name:'root',transport:{type:'ssh',host:'fixture'},options:{cwd:'/',watch_directory:'/'},instructions:'Inspect'},'/local/state');
  assert.equal(result.options.watch_directory,'/');
  // Local protection remains in force on both platforms.
  assert.throws(()=>validateOptions('watchdog',{cwd:process.cwd(),watch_directory:process.cwd()},path.join(process.cwd(),'state')),/State must be outside/);
});

test('remote preflight rejects zombie and dead process states as registration does',async t=>{
  t.mock.method(SshSession.prototype,'open',async()=>{});
  t.mock.method(SshSession.prototype,'close',async()=>{});
  let processState='Z';
  t.mock.method(SshSession.prototype,'request',async function(script){
    const fields=[processState,...Array(18).fill('0'),'1234'];
    return {code:0,data:Buffer.from(script.includes('/proc/42/stat')?`${randomUUID()}\n42 (job) ${fields.join(' ')}\n`:'')};
  });
  for(const value of ['Z','X','S']){
    processState=value;
    const result=await validateRequest(randomUUID(),'/local/state',{operation:'start',config:{name:'pid',transport:{type:'ssh',host:'fixture'},options:{cwd:'/work',pid:42},instructions:'Inspect'}},false);
    assert.equal(result.valid,value==='S',JSON.stringify(result));
  }
});

test('loss during shared registration promptly rejects only the unready subscription', {timeout:5000},async t=>{
  const sessions=[],incidents=[],ended=[],states=[];
  t.mock.method(SshSession.prototype,'open',async function(){sessions.push(this);this.lastResponseAt=performance.now();});
  let entered,release;
  const querying=new Promise(r=>entered=r),blocked=new Promise((_,reject)=>release=reject);
  t.mock.method(SshSession.prototype,'request',async function(script){
    if(script.startsWith('test -d')){entered();return blocked;}
    this.lastResponseAt=performance.now();return {code:0,data:Buffer.from('alive')};
  });
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const pool=new SshPool((ids,e)=>incidents.push({ids,...e}));t.after(()=>pool.close());
  const first=pool.start('established','connection',{timeout_ms:30000},transport,()=>{},e=>ended.push(e),s=>states.push(s));
  await first.ready;
  const second=pool.start('pending','watchdog',{cwd:'/work',watch_file:'/work/file',timeout_ms:30000,poll_ms:1000},transport,()=>{},()=>{},()=>{});
  const result=second.ready.then(()=>({ok:true}),error=>({error}));
  await querying;
  const loss=new SshFailure('Test connection loss');sessions[0].emit('lost',loss);release(loss);
  assert.match(String((await result).error),/before readiness/);
  assert.equal(ended.length,0);assert.equal(states.at(-1).state,'reconnecting');
  assert.equal(incidents.length,1);assert.deepEqual(incidents[0].ids,['established']);
  assert.throws(()=>pool.start('late','connection',{timeout_ms:1000},transport,()=>{},()=>{},()=>{}),/reconnecting/);
});

test('GPU snapshots are scoped by remote working directory as well as executable and selectors',{timeout:5000},async t=>{
  const requests=[];
  t.mock.method(SshSession.prototype,'open',async function(){this.lastResponseAt=performance.now();});
  t.mock.method(SshSession.prototype,'request',async function(script){
    this.lastResponseAt=performance.now();requests.push(script);
    return {code:0,data:Buffer.from(script.includes('--query-gpu')?`0, GPU-one, 00000000:01:00.0, ${script.includes("cd '/second'")?90:5}\n`:'')};
  });
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const pool=new SshPool(()=>{});t.after(()=>pool.close());
  const options={gpu_util_below:10,gpu_id:'0',gpu_sample_ms:1000,poll_ms:1000,timeout_ms:30000,nvidia_smi:'./gpu'};
  const a=pool.start('one','watchdog',{...options,cwd:'/first'},transport,()=>{},()=>{},()=>{});
  const b=pool.start('two','watchdog',{...options,cwd:'/second'},transport,()=>{},()=>{},()=>{});
  await Promise.all([a.ready,b.ready]);
  const queries=requests.filter(s=>s.includes('--query-gpu'));
  assert.equal(queries.length,2);assert.ok(queries.some(s=>s.startsWith("cd '/first' && './gpu'")));
  assert.ok(queries.some(s=>s.startsWith("cd '/second' && './gpu'")));
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('registration has its own deadline and cannot arm late after a blocked SSH handshake',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let entered,release;
  const opening=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
  t.mock.method(SshSession.prototype,'open',async function(){entered();await blocked;});
  const states=[],ended=[],events=[],pool=new SshPool(()=>{});t.after(()=>pool.close());
  const transport={host:'fixture',heartbeat_ms:1000,connect_timeout_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const sensor=pool.start('pending','connection',{timeout_ms:300000},transport,e=>events.push(e),e=>ended.push(e),s=>states.push(s));
  const rejected=assert.rejects(sensor.ready,/before readiness/);
  t.mock.timers.tick(0);await opening;
  t.mock.timers.tick(sshReadinessMs(transport));await rejected;
  release();await flush();
  assert.equal(ended.length,1);assert.equal(ended[0].reason,'monitor_error');
  assert.match(events[0].error,/registration deadline/);assert.ok(!states.some(s=>s.state==='armed'));
});

test('slow rebaseline after an observation gap does not count missing time as file inactivity',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let clock=1000,slow=false;
  t.mock.method(performance,'now',()=>clock);
  t.mock.method(SshSession.prototype,'open',async function(){this.lastResponseAt=clock;});
  t.mock.method(SshSession.prototype,'request',async function(script){
    if(slow && script.includes('stat -L'))clock+=2000;
    this.lastResponseAt=clock;
    return {code:0,data:Buffer.from(script.includes('stat -L')?'1:1\n1:2:3:unchanged':'')};
  });
  const events=[],states=[],pool=new SshPool(()=>{});t.after(()=>pool.close());
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const sensor=pool.start('file','watchdog',{cwd:'/work',watch_file:'/work/progress',poll_ms:1000,stalled_for_ms:1100,watchdog_only:true,timeout_ms:300000},transport,e=>events.push(e),()=>{},s=>states.push(s));
  t.mock.timers.tick(0);await sensor.ready;await flush();
  clock=100000;slow=true;t.mock.timers.tick(1000);await flush();
  assert.equal(states.at(-1).connection.observation_gap,true);
  assert.equal(events.length,0,'The rebaseline query itself must not establish a stall');
  slow=false;clock=104000;t.mock.timers.tick(1000);await flush();
  assert.equal(events.length,1);assert.equal(events[0].event_type,'watchdog_stalled');
});

test('reconnect deadline also bounds an in-flight handshake and refuses new registrations',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let clock=1000,attempts=0,firstSession,entered,release;
  t.mock.method(performance,'now',()=>clock);t.mock.method(Math,'random',()=>0.5);
  const opening=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
  t.mock.method(SshSession.prototype,'open',async function(){
    this.lastResponseAt=clock;
    if(++attempts===1)firstSession=this;else{entered();await blocked;}
  });
  t.mock.method(SshSession.prototype,'request',async function(){this.lastResponseAt=clock;return {code:0,data:Buffer.from('alive')};});
  const ended=[],events=[],pool=new SshPool((ids,e)=>events.push(e));t.after(()=>pool.close());
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:7000}};
  const sensor=pool.start('existing','connection',{timeout_ms:300000},transport,()=>{},e=>ended.push(e),()=>{});
  t.mock.timers.tick(0);await sensor.ready;await flush();
  firstSession.emit('lost',new SshFailure('Test disconnect'));
  clock+=5000;t.mock.timers.tick(5000);await opening;
  assert.throws(()=>pool.start('late','connection',{timeout_ms:1000},transport,()=>{},()=>{},()=>{}),/reconnecting/);
  clock+=2000;t.mock.timers.tick(2000);await flush();
  assert.equal(ended.length,1);assert.equal(ended[0].reason,'connection_failed');
  assert.ok(events.some(e=>e.reason==='reconnect_stopped'));
  release();await flush();assert.equal(attempts,2);
});

test('cancelled start requests cannot leave a new observer or launch a queued registration',{timeout:5000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ssh-start-cancel-'));
  const manager=new Manager(root,randomUUID());t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
  let entered,release;const opening=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  t.mock.method(SshSession.prototype,'open',async()=>{entered();await gate;});
  const config={name:'first',kind:'connection',transport:{type:'ssh',host:'fixture'},options:{timeout_ms:30000},instructions:'Inspect'};
  const firstController=new AbortController(),queuedController=new AbortController();
  const first=manager.start(config,firstController.signal);await opening;
  const second=manager.start({...config,name:'queued'},queuedController.signal);
  const rejected=assert.rejects(second,/registration cancelled/);
  queuedController.abort();firstController.abort();
  const stopped=await first;await rejected;
  assert.equal(stopped.state,'stopped');assert.equal(manager.jobs.size,0);
  assert.ok(!Object.values(manager.records).some(r=>r.name==='queued'));
  release();await flush();assert.equal(manager.jobs.size,0);
});

test('shared incidents preserve distinct notification lifetimes',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ssh-event-ttl-'));
  const manager=new Manager(root,randomUUID());t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  ids.forEach((id,i)=>manager.records[id]={id,name:'ttl'+i,state:'armed',notify_on:['connection_lost'],event_ttl_ms:i===0?1000:60000,event_count:0,instructions:'Inspect'});
  const raw={event_type:'connection_lost',connection_id:randomUUID(),incident_id:randomUUID()};
  manager.connectionEvent(ids,raw);
  const events=Object.values(manager.events);assert.equal(events.length,2);
  const short=events.find(e=>e.affected_monitor_ids.includes(ids[0])),long=events.find(e=>e.affected_monitor_ids.includes(ids[1]));
  assert.deepEqual(short.affected_monitor_ids,[ids[0]]);assert.deepEqual(long.affected_monitor_ids,ids.slice(1));
  assert.equal(short.expires_at-short.occurred_at,1000);assert.equal(long.expires_at-long.occurred_at,60000);
  manager.connectionEvent(ids,raw);assert.equal(Object.keys(manager.events).length,2);
  short.expires_at=0;manager.expire();assert.equal(short.state,'expired');assert.equal(long.state,'pending');
});

test('shared evidence withdraws cancelled monitor instructions but retains the other recipient',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ssh-cancel-actions-'));
  const manager=new Manager(root,randomUUID());t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
  const ids=[randomUUID(),randomUUID()];
  ids.forEach((id,i)=>manager.records[id]={id,name:'source'+i,state:'armed',notify_on:['connection_lost'],event_ttl_ms:60000,event_count:0,instructions:'Action '+i});
  manager.connectionEvent(ids,{event_type:'connection_lost',connection_id:randomUUID(),incident_id:randomUUID()});
  const event=Object.values(manager.events)[0];
  manager.wait={state:'waiting',mode:'pause',monitor_ids:ids};
  await manager.stop(ids[0]);
  assert.ok(!manager.records[ids[1]].muted);
  const result=(await manager.reviewEvent({event_ids:[event.id]})).events[0];
  assert.equal(result.actionable,true);assert.equal(result.instructions,undefined);
  assert.equal(result.affected_monitors[0].instructions,undefined);assert.equal(result.affected_monitors[0].actionable,false);
  assert.equal(result.affected_monitors[1].instructions,'Action 1');assert.equal(result.affected_monitors[1].actionable,true);
});

test('a slow GPU interval cannot hide an interruption in fast file sampling',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let clock=1000;
  t.mock.method(performance,'now',()=>clock);
  t.mock.method(SshSession.prototype,'open',async function(){this.lastResponseAt=clock;});
  t.mock.method(SshSession.prototype,'request',async function(script){
    this.lastResponseAt=clock;
    return {code:0,data:Buffer.from(script.includes('stat -L')?'1:1\n1:2:3:unchanged':script.includes('--query-gpu')?'0, GPU-one, 00000000:01:00.0, 90\n':'')};
  });
  const events=[],states=[],pool=new SshPool(()=>{});t.after(()=>pool.close());
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const sensor=pool.start('mixed','watchdog',{cwd:'/work',watch_file:'/work/progress',poll_ms:1000,stalled_for_ms:1100,watchdog_only:true,dead_if:'any',gpu_util_below:10,gpu_id:'0',gpu_sample_ms:600000,timeout_ms:300000},transport,e=>events.push(e),()=>{},s=>states.push(s));
  t.mock.timers.tick(0);await sensor.ready;await flush();
  clock=100000;t.mock.timers.tick(1000);await flush();
  assert.equal(events.length,0,'Unobserved time must not be interpreted as file inactivity');
  assert.equal(states.at(-1).connection.observation_gap,true);
});

test('the final SSH observer retains its occupied slot until connection cleanup completes',{timeout:5000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ssh-stop-drain-')),manager=new Manager(root,randomUUID());
  let entered,release;const closing=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  t.after(async()=>{release();await manager.close();await rm(root,{recursive:true,force:true});});
  t.mock.method(SshSession.prototype,'open',async function(){this.lastResponseAt=performance.now();});
  t.mock.method(SshSession.prototype,'request',async function(){this.lastResponseAt=performance.now();return {code:0,data:Buffer.from('alive')};});
  t.mock.method(SshSession.prototype,'close',async()=>{entered();await gate;});
  const monitor=await manager.start({name:'last',kind:'connection',transport:{type:'ssh',host:'fixture'},options:{timeout_ms:30000},instructions:'Inspect'});
  const stopping=manager.stop(monitor.id);await closing;
  let repeatedFinished=false;const repeated=manager.stop(monitor.id).then(()=>{repeatedFinished=true;});await flush();
  assert.equal(manager.jobs.size,1,'Cleanup still owns an SSH process and must count against capacity');
  assert.equal(manager.records[monitor.id].state,'stopping');
  assert.equal(repeatedFinished,false,'Repeated stop must await the same cleanup');
  release();await Promise.all([stopping,repeated]);assert.equal(manager.jobs.size,0);assert.equal(manager.records[monitor.id].state,'stopped');
});

for(const delayedSource of ['file','gpu'])test(`an observation gap during an in-flight ${delayedSource} sample cannot establish a stall`,{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let clock=1000,delayed=false;
  t.mock.method(performance,'now',()=>clock);
  t.mock.method(SshSession.prototype,'open',async function(){this.lastResponseAt=clock;});
  t.mock.method(SshSession.prototype,'request',async function(script){
    if(delayed && script.includes(delayedSource==='file'?'stat -L':'--query-gpu'))clock+=10000;
    this.lastResponseAt=clock;
    return {code:0,data:Buffer.from(script.includes('stat -L')?'1:1\n1:2:3:unchanged':script.includes('--query-gpu')?'0, GPU-one, 00000000:01:00.0, 5\n':'')};
  });
  const events=[],states=[],pool=new SshPool(()=>{});t.after(()=>pool.close());
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const options={cwd:'/work',watch_file:'/work/progress',poll_ms:1000,stalled_for_ms:1500,watchdog_only:true,timeout_ms:300000,
    ...(delayedSource==='gpu'?{gpu_util_below:10,gpu_recover_above:10,gpu_id:'0',gpu_sample_ms:1000,gpu_below_for_ms:1500,dead_if:'any'}:{})};
  const sensor=pool.start('gap','watchdog',options,transport,e=>events.push(e),()=>{},s=>states.push(s));
  t.mock.timers.tick(0);await sensor.ready;await flush();
  delayed=true;clock=2000;t.mock.timers.tick(1000);await flush();
  assert.equal(events.length,0,'A delayed reply cannot prove continuous file inactivity or GPU underutilization');
  assert.equal(states.at(-1).connection.observation_gap,true);
  delayed=false;clock+=1000;t.mock.timers.tick(1000);await flush();assert.equal(events.length,0);
  clock+=1000;t.mock.timers.tick(1000);await flush();
  assert.equal(events.length,1);assert.equal(events[0].event_type,'watchdog_stalled');
});

test('SSH file debounce suppresses repeated notifications while preserving progress and delete/recreate events',{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let clock=1000,version='initial';
  t.mock.method(performance,'now',()=>clock);
  t.mock.method(SshSession.prototype,'open',async function(){this.lastResponseAt=clock;});
  t.mock.method(SshSession.prototype,'request',async function(script){
    this.lastResponseAt=clock;
    return {code:0,data:Buffer.from(script.includes('stat -L')?`1:1\n${version==='missing'?'MISSING':'1:2:3:'+version}`:'')};
  });
  const events=[],pool=new SshPool(()=>{});t.after(()=>pool.close());
  const transport={host:'fixture',heartbeat_ms:1000,query_timeout_ms:1000,reconnect:{enabled:true,max_elapsed_ms:30000}};
  const sensor=pool.start('debounced','watchdog',{cwd:'/work',watch_file:'/work/progress',poll_ms:1000,debounce_ms:10000,stalled_for_ms:1500,timeout_ms:300000},transport,e=>events.push(e),()=>{},()=>{});
  t.mock.timers.tick(0);await sensor.ready;await flush();
  for(const next of ['one','two','three']){version=next;clock+=1000;t.mock.timers.tick(1000);await flush();}
  assert.equal(events.length,1,'Later writes within debounce_ms must not create extra sensor events');
  assert.equal(events[0].event_type,'file_change');
  clock+=1000;t.mock.timers.tick(1000);await flush();
  assert.equal(events.length,1,'Debounced writes must still reset inactivity');
  version='missing';clock+=1000;t.mock.timers.tick(1000);await flush();
  assert.ok(events.some(e=>e.change==='deleted'));assert.ok(events.some(e=>e.event_type==='watchdog_stalled'),'Deletion does not establish progress');
  version='recreated';clock+=1000;t.mock.timers.tick(1000);await flush();
  assert.ok(events.some(e=>e.change==='created'),'Deletion clears debounce for the recreated path');
});
