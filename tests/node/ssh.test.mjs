import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter,once} from 'node:events';
import {normalizeMonitor,validateRequest} from '../../codex-monitor/runtime/validation.js';
import {SshSession,quote,sshArgs} from '../../codex-monitor/runtime/ssh-session.js';
import {fileSample,processSample,gpuSample} from '../../codex-monitor/runtime/ssh-samples.js';
import {Manager} from '../../codex-monitor/runtime/manager.js';
import {summarize,compactReport} from '../../codex-monitor/runtime/report.js';

const runFile=promisify(execFile);
const docker=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'):'docker';
async function run(command,args){return (await runFile(command,args,{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024})).stdout;}
const d=(...args)=>run(docker,args);
const native=Boolean(process.env.CODEX_MONITOR_TEST_SSH);

test('subagents share one real SSH connection but receive separately scoped connection incidents',{skip:!native,timeout:60000},async t=>{
 const f=await fixture(t),m=await managerFixture(t,f),a=randomUUID(),b=randomUUID(),rpc=m.host.rpc;
 m.host.rpc=async(method,p)=>{
  if(method==='thread/read')return {thread:{id:p.threadId,source:p.threadId===m.thread?'cli':{subAgent:{thread_spawn:{parent_thread_id:m.thread}}},parentThreadId:p.threadId===m.thread?null:m.thread}};
  if(method==='thread/loaded/list')return {data:[m.thread,a,b]};
  return rpc(method,p);
 };
 const config={name:'shared-ssh',kind:'connection',transport:f.transport,options:{timeout_ms:30000},instructions:'Inspect this branch connection incident'};
 const ma=await m.manager.start(config,undefined,a),mb=await m.manager.start(config,undefined,b);
 assert.equal(ma.connection.id,mb.connection.id);assert.notEqual(ma.id,mb.id);
 const pa=m.manager.delegation.poll(a,{timeout_ms:20000}),pb=m.manager.delegation.poll(b,{timeout_ms:20000});
 await state(m.manager,()=>m.manager.delegation.waits[a]?.state==='waiting'&&m.manager.delegation.waits[b]?.state==='waiting');
 await d('pause',f.name);const [ra,rb]=await Promise.all([pa,pb]);
 assert.deepEqual(ra.events[0].affected_monitor_ids,[ma.id]);assert.deepEqual(rb.events[0].affected_monitor_ids,[mb.id]);
 assert.equal(ra.events[0].connection_id,rb.events[0].connection_id);
 await m.manager.reviewEvent({event_ids:ra.event_ids,resolution:'Inspected branch A incident'});
 assert.equal(m.manager.events[rb.event_ids[0]].state,'returned');
 assert.throws(()=>m.manager.delegation.event(a,rb.event_ids[0],true),/caller scope/);
});
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'monitor-ssh-')),name='monitor-ssh-'+randomUUID().slice(0,8),key=path.join(root,'key');
  let launched=false;const cleanups=[];
  t.after(async()=>{if(launched)await d('unpause',name).catch(()=>{});for(const cleanup of cleanups)await cleanup();if(launched)await d('rm','-f',name).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  await run(process.platform==='win32'?'ssh-keygen.exe':'ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
  await copyFile(key+'.pub',path.join(root,'authorized_keys'));
  await d('run','-d','--name',name,'--network','bridge','-p','127.0.0.1::22','--mount',`type=bind,source=${root},target=/fixture,readonly`,'codex-monitor-ssh-test');launched=true;
  const inspect=JSON.parse(await d('inspect',name))[0],port=Number(inspect.NetworkSettings.Ports['22/tcp'][0].HostPort);
  const pub=(await d('exec',name,'cat','/etc/ssh/ssh_host_ed25519_key.pub')).trim().split(/\s+/).slice(0,2).join(' ');
  const known=path.join(root,'known_hosts'),config=path.join(root,'config');
  await writeFile(known,`[127.0.0.1]:${port} ${pub}\n`);
  await writeFile(config,`Host fixture\n HostName 127.0.0.1\n Port ${port}\n User monitor\n IdentityFile "${key.replaceAll('\\','/')}"\n UserKnownHostsFile "${known.replaceAll('\\','/')}"\n IdentitiesOnly yes\n`);
  const transport={type:'ssh',host:'fixture',config_file:config,connect_timeout_ms:3000,query_timeout_ms:1000,heartbeat_ms:1000,reconnect:{enabled:true,max_elapsed_ms:15000}};
  const exec=(script)=>d('exec','-u','monitor',name,'sh','-c',script);
  return {root,name,transport,exec,cleanups};
}
async function managerFixture(t,f){
  const thread=randomUUID(),history=path.join(f.root,'history.jsonl');await writeFile(history,'');
  const host=new EventEmitter();host.submissions=[];host.rpc=async(method,params)=>{
    if(method==='thread/loaded/list')return {data:[thread]};
    if(method==='thread/resume')return {thread:{id:thread}};
    if(method==='thread/goal/get')return {goal:null};
    if(method==='config/read')return {config:{history:{persistence:'save-all'}}};
    if(method==='thread/turns/list')return {data:[{id:'caller',status:'inProgress'}]};
    if(method==='thread/read')return {thread:{status:{type:'active'}}};
    if(method==='turn/start'){host.submissions.push(params);return {turn:{id:randomUUID()}};}
    throw Error(method);
  };host.close=async()=>{};
  const manager=new Manager(path.join(f.root,'state'),thread,{connect:async()=>host,historyFile:history});
  f.cleanups.push(()=>manager.close());
  return {manager,host,thread,start:(name,options={})=>manager.start({name,transport:f.transport,kind:'connection',options:{timeout_ms:20000,...options},instructions:'Inspect SSH incident'})};
}
async function state(manager,predicate,timeout=15000){
  const deadline=Date.now()+timeout;
  while(!predicate()){
    if(Date.now()>deadline)throw Error('Expected monitor state not reached');
    await manager.changes.wait(manager.changes.revision,1000);
  }
}

test('SSH normalization keeps remote Linux paths separate from local validation and rejects command ownership',()=>{
  const base={name:'remote',transport:{type:'ssh',host:'gpu-box'},options:{cwd:'/srv/train',watch_file:'../loss'},instructions:'Inspect'};
  const normalized=normalizeMonitor(base,'C:/local/state');
  assert.equal(normalized.options.watch_file,'/srv/loss');assert.equal(normalized.options.poll_ms,10000);
  assert.ok(normalized.notify_on.includes('connection_lost'));assert.equal(normalized.transport.reconnect.max_elapsed_ms,1800000);
  assert.throws(()=>normalizeMonitor({...base,options:{cwd:'/srv/train',command:'train'}},''),/ownership/);
  for(const host of ['-oProxyCommand=bad','host;bad','user@host','$(bad)','host\nX'])assert.throws(()=>normalizeMonitor({...base,transport:{type:'ssh',host}},''));
  assert.throws(()=>normalizeMonitor({...base,options:{...base.options,file_backend:'native'}},''),/polling/);
  assert.throws(()=>normalizeMonitor({...base,options:{...base.options,poll_ms:10}},''),/1000/);
  assert.throws(()=>normalizeMonitor({...base,options:{...base.options,watch_file:'bad\0file'}},''),/NUL/);
  assert.throws(()=>normalizeMonitor({name:'x',kind:'connection',options:{},instructions:'Inspect'},''),/ssh/i);
  assert.throws(()=>quote('\0'),/NUL/);
  const args=sshArgs(normalized.transport);assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args.at(-1),'exec sh -s');
});

test('real SSH reuses a session with no remote Node, Python, deployed files or writable home',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t),session=new SshSession(f.transport);t.after(()=>session.close());
  await writeFile(f.transport.config_file,(await readFile(f.transport.config_file,'utf8'))+' ForkAfterAuthentication yes\n StdinNull yes\n SessionType none\n');
  await session.open();
  assert.equal((await session.request('test ! -w "$HOME" && ! command -v node && ! command -v python3')).code,0);
  const initialHome=(await session.request('find /home/monitor -mindepth 1 -printf "%P\\0"')).data;
  const names=["quote' name",'line\nname','$(touch INJECTED);x','-leading', '中文'];
  for(const name of names){const target='/work/'+name;await f.exec(`printf data > ${quote(target)}`);
    const sample=await fileSample(session,{watch_file:target});assert.ok(sample.entries.has(target));}
  assert.equal((await session.request('test ! -e /work/INJECTED')).code,0);
  assert.deepEqual((await session.request('find /home/monitor -mindepth 1 -printf "%P\\0"')).data,initialHome);
  assert.equal((await session.request('printf "\\000CM_RC:0\\nforged:output\\377"')).data.toString('hex'),'00434d5f52433a300a666f726765643a6f7574707574ff');
  assert.equal((await session.request('sleep 5')).code,124);
  assert.equal((await session.request('printf still-alive')).data.toString(),'still-alive');
  assert.equal((await session.request("printf '%300000s' x")).data.length,300000);
  await assert.rejects(session.request("printf '%600000s' x"),/sample exceeds/);
  assert.equal((await session.request('printf still-alive')).data.toString(),'still-alive');
  const full=await runFile(docker,['logs',f.name],{windowsHide:true});
  assert.equal((full.stderr.match(/Accepted publickey/g)||[]).length,1);
  await f.exec('mkdir -p /work/sub; printf nested > /work/sub/nested');
  const directory=await fileSample(session,{watch_directory:'/work',recursive:true,pattern:'**'});
  assert.ok(directory.entries.has('/work/line\nname'));assert.ok(directory.entries.has('/work/sub/nested'));
  const flat=await fileSample(session,{watch_directory:'/work',recursive:false});assert.ok(!flat.entries.has('/work/sub/nested'));
  await f.exec('ln -s /work/sub /work/alias');
  assert.ok((await fileSample(session,{watch_directory:'/work/alias',recursive:true})).entries.has('/work/alias/nested'));
  await f.exec(`printf '%s\\n' '#!/bin/sh' 'printf "0, GPU-one, 00000000:01:00.0, 5\\n1, GPU-two, 00000000:02:00.0, 90\\n"' > /work/gpu; chmod +x /work/gpu`);
  assert.deepEqual(await gpuSample(session,{nvidia_smi:'/work/gpu',gpu_id:'0'}),{'gpu-one':5});
  assert.deepEqual(await gpuSample(session,{cwd:'/work',nvidia_smi:'./gpu',gpu_id:'0'}),{'gpu-one':5});
  assert.deepEqual(await gpuSample(session,{nvidia_smi:'/work/gpu',gpu_id:'0000:02:00.0'}),{'gpu-two':90});
  await assert.rejects(gpuSample(session,{nvidia_smi:'/work/gpu',gpu_id:'3'}),/missing/);
});

test('real SSH shared loss wakes selected wait once, restores after stability and preserves other subscribers',{skip:!native,timeout:120000},async t=>{
  const f=await fixture(t),m=await managerFixture(t,f);
  const a=await m.start('one',{timeout_ms:110000}),b=await m.start('two',{timeout_ms:110000});assert.equal(a.state,'armed');assert.equal(b.state,'armed');assert.equal(a.connection_id,b.connection_id);
  const waiting=m.manager.blockWait({monitor_ids:[b.id],wake_scope:'selected',timeout_ms:15000});
  await state(m.manager,()=>m.manager.wait?.state==='waiting');
  await d('pause',f.name);
  const event=await waiting;
  assert.equal(event.reason,'monitor_event');assert.equal(event.events.length,1);
  assert.equal(event.events[0].event_type,'connection_unresponsive');
  assert.deepEqual(new Set(event.events[0].affected_monitor_ids),new Set([a.id,b.id]));
  assert.equal(m.host.submissions.length,0);
  const report=summarize(m.manager.snapshot(),'live');assert.equal(report.summary.running,0);assert.equal(report.summary.reconnecting,2);assert.match(compactReport(report),/2 reconnecting/);
  await m.manager.reviewEvent({event_ids:event.event_ids,resolution:'Inspected isolated network pause'});
  await m.manager.stop(a.id);assert.equal(m.manager.jobs.size,1);
  await d('unpause',f.name);
  await state(m.manager,()=>m.manager.records[b.id].state==='armed');
  assert.equal(m.manager.records[a.id].state,'stopped');
  assert.equal(Object.values(m.manager.events).filter(e=>e.event_type==='connection_unresponsive').length,1);
  await state(m.manager,()=>Object.values(m.manager.events).some(e=>e.event_type==='connection_restored'),75000);
  const restored=Object.values(m.manager.events).filter(e=>e.event_type==='connection_restored');
  assert.equal(restored.length,1);assert.deepEqual(restored[0].affected_monitor_ids,[b.id]);
  assert.equal(m.manager.records[b.id].state,'armed');
  assert.ok(!Object.values(m.manager.events).some(e=>e.evidence.reason==='reconnect_stopped'));
  await m.manager.stop(b.id);assert.equal(m.manager.jobs.size,0);
});

test('reconnect exhaustion is bounded and cancellation while SSH is preparing cannot attach a late observer',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t);f.transport.reconnect.max_elapsed_ms=1000;
  const m=await managerFixture(t,f),a=await m.start('bounded');assert.equal(a.state,'armed');
  await d('pause',f.name);
  await state(m.manager,()=>m.manager.records[a.id].state==='stopped');
  const errors=Object.values(m.manager.events);assert.equal(errors.filter(e=>e.event_type==='connection_unresponsive').length,1);
  assert.equal(errors.filter(e=>e.evidence.reason==='reconnect_stopped').length,1);assert.equal(m.manager.jobs.size,0);
  await d('unpause',f.name);
  const pending=m.start('cancelled');
  await state(m.manager,()=>Object.values(m.manager.records).some(r=>r.name==='cancelled'));
  const record=Object.values(m.manager.records).find(r=>r.name==='cancelled');
  await m.manager.stop(record.id);await pending;
  assert.equal(record.state,'stopped');assert.equal(m.manager.jobs.size,0);
});

test('shared SSH incidents retain other subscribers after selected notification cancellation',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-group-'));const f={root,cleanups:[]};
  const m=await managerFixture(t,f);t.after(async()=>{for(const c of f.cleanups)await c();await rm(root,{recursive:true,force:true});});
  const ids=[randomUUID(),randomUUID()];
  for(const [i,id]of ids.entries())m.manager.records[id]={id,name:'test'+i,state:'reconnecting',notify_on:['connection_lost'],registered_at:Date.now(),event_count:0,event_ttl_ms:60000,instructions:'Inspect '+i};
  m.manager.wait={state:'waiting',monitor_ids:[ids[0]],mode:'blocking'};
  m.manager.connectionEvent(ids,{event_type:'connection_lost',incident_id:randomUUID(),connection_id:randomUUID(),host:'fixture'});
  await m.manager.cancelWait();
  const event=Object.values(m.manager.events)[0];assert.equal(event.state,'pending');assert.equal(m.manager.records[ids[0]].muted,true);assert.ok(!m.manager.records[ids[1]].muted);
  const evidence=await m.manager.reviewEvent({event_ids:[event.id]});assert.equal(evidence.events[0].affected_monitors.length,2);
  await m.manager.flush();assert.equal(m.host.submissions.length,1);
});

test('real remote file watchdog and validation preserve an independently launched process',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t),m=await managerFixture(t,f);
  const invalid=await m.manager.start({name:'missing-root',transport:f.transport,options:{cwd:'/missing',watch_file:'progress',timeout_ms:10000},instructions:'Inspect'});
  assert.equal(invalid.state,'failed');assert.ok(invalid.error);assert.equal(m.manager.jobs.size,0);
  await d('exec','-d','-u','monitor',f.name,'sh','-c','echo $$ > /work/pid; exec sleep 300');
  const pid=Number((await f.exec('cat /work/pid')).trim());await f.exec('printf initial > /work/progress');
  const config={name:'training',transport:f.transport,options:{cwd:'/work',pid,watch_file:'progress',poll_ms:1000,stalled_for_ms:1100,watchdog_only:true,timeout_ms:10000},instructions:'Inspect'};
  const preflight=await validateRequest(m.thread,path.join(f.root,'probe'),{operation:'start',config},false);
  assert.equal(preflight.valid,true,JSON.stringify(preflight.errors));assert.equal(existsSync(path.join(f.root,'probe')),false);
  const monitored=await m.manager.start(config);assert.equal(monitored.state,'armed',monitored.error);
  await state(m.manager,()=>Object.values(m.manager.events).some(e=>e.event_type==='watchdog_stalled'));
  await m.manager.stop(monitored.id);
  assert.equal((await f.exec(`kill -0 ${pid}; printf ok`)).trim(),'ok');
  const connection=new SshSession(f.transport);t.after(()=>connection.close());await connection.open();assert.ok((await processSample(connection,pid)).identity.includes(':'+pid+':'));
});

test('replacing a stopped representative does not supersede a shared incident; settlement covers every recipient',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-shared-history-')),f={root,cleanups:[]};
  const m=await managerFixture(t,f);t.after(async()=>{for(const c of f.cleanups)await c();await rm(root,{recursive:true,force:true});});
  const ids=[randomUUID(),randomUUID()];
  for(const [i,id]of ids.entries())m.manager.records[id]={id,name:'history'+i,state:'stopped',notify_on:['connection_lost'],registered_at:Date.now(),event_count:0,event_ttl_ms:60000,instructions:'Inspect'};
  const raw={event_type:'connection_lost',incident_id:randomUUID(),connection_id:randomUUID(),host:'fixture'};
  m.manager.connectionEvent(ids,raw);
  const event=Object.values(m.manager.events)[0];
  await m.manager.start({name:'history0',instructions:'Inspect',options:{cwd:root,watch_file:'progress',timeout_ms:5000}});
  assert.equal(event.state,'pending');
  m.manager.records[ids[0]].muted=true;
  m.manager.connectionEvent(ids,raw);assert.equal(Object.keys(m.manager.events).length,1);
  m.manager.wait={state:'waiting',monitor_ids:[ids[1]],mode:'blocking'};
  await m.manager.reviewEvent({event_ids:[event.id],resolution:'Shared evidence handled'});
  assert.equal(m.manager.wait.state,'interrupted');
  m.manager.records[ids[1]].muted=false; // Explicitly rearm the fixture for a separate expiry scenario.
  m.manager.connectionEvent(ids,{...raw,incident_id:randomUUID()});
  const expiring=Object.values(m.manager.events).find(e=>e.state==='pending');expiring.expires_at=0;
  m.manager.wait={state:'waiting',monitor_ids:[ids[1]],mode:'blocking'};
  m.manager.expire();assert.equal(expiring.state,'expired');assert.equal(m.manager.wait.state,'interrupted');
});

test('SSH rejects unknown host keys and failed authentication without weakening host trust',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t),known=path.join(f.root,'known_hosts'),original=await readFile(known);
  await writeFile(known,'');
  const untrusted=new SshSession(f.transport);t.after(()=>untrusted.close());
  await assert.rejects(untrusted.open(),e=>e.reason==='authentication_error');
  assert.equal(await readFile(known,'utf8'),'');await writeFile(known,original);
  const other=path.join(f.root,'other');
  await run(process.platform==='win32'?'ssh-keygen.exe':'ssh-keygen',['-q','-t','ed25519','-N','','-f',other]);
  const config=await readFile(f.transport.config_file,'utf8');
  await writeFile(f.transport.config_file,config.replace(path.join(f.root,'key').replaceAll('\\','/'),other.replaceAll('\\','/')));
  const denied=new SshSession(f.transport);t.after(()=>denied.close());
  await assert.rejects(denied.open(),e=>e.reason==='authentication_error');
});

test('oversized remote samples fail only their source and preserve the shared connection',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t),m=await managerFixture(t,f),first=await m.start('healthy');
  await f.exec(`printf '%s\\n' '#!/bin/sh' "printf '%600000s' x" > /work/oversized; chmod +x /work/oversized`);
  const failed=await m.manager.start({name:'oversized',transport:f.transport,options:{cwd:'/work',nvidia_smi:'./oversized',gpu_util_below:10,timeout_ms:10000},instructions:'Inspect source limit'});
  assert.equal(failed.state,'failed');assert.equal(m.manager.records[first.id].state,'armed');
  assert.equal(m.manager.jobs.size,1);
  assert.ok(Object.values(m.manager.events).some(e=>e.event_type==='monitor_error'&&e.evidence.error.includes('sample exceeds')));
  assert.ok(!Object.values(m.manager.events).some(e=>e.event_type.startsWith('connection_')));
  const second=await m.start('still-shared');assert.equal(second.connection_id,first.connection_id);
});

test('remote GPU watchdog evaluates selected device dwell and recovery locally',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t),m=await managerFixture(t,f);
  await f.exec(`printf '%s\\n' '#!/bin/sh' 'cat /work/gpu_values' > /work/gpu; chmod +x /work/gpu; printf '0, GPU-one, 00000000:01:00.0, 5\\n1, GPU-two, 00000000:02:00.0, 90\\n' > /work/gpu_values`);
  const monitor=await m.manager.start({name:'gpu',transport:f.transport,instructions:'Inspect GPU stall',notify_on:['watchdog_stalled','watchdog_recovered','monitor_error','monitor_expired'],options:{cwd:'/work',nvidia_smi:'/work/gpu',gpu_id:'0',gpu_util_below:10,gpu_below_for_ms:1100,gpu_recover_above:20,gpu_sample_ms:1000,poll_ms:1000,timeout_ms:20000,report_recovery:true}});
  assert.equal(monitor.state,'armed',monitor.error);
  await state(m.manager,()=>Object.values(m.manager.events).some(e=>e.event_type==='watchdog_stalled'));
  const event=Object.values(m.manager.events).find(e=>e.event_type==='watchdog_stalled');
  assert.deepEqual(event.evidence.conditions.gpu_low.utilization,{'gpu-one':5});
  await f.exec("printf '0, GPU-one, 00000000:01:00.0, 90\\n1, GPU-two, 00000000:02:00.0, 5\\n' > /work/gpu_values");
  await state(m.manager,()=>Object.values(m.manager.events).some(e=>e.event_type==='watchdog_recovered'));
  await m.manager.stop(monitor.id);
});

test('a timed-out remote query and replaced watch root fail only their source',{skip:!native,timeout:60000},async t=>{
  const f=await fixture(t),m=await managerFixture(t,f),healthy=await m.start('healthy',{timeout_ms:50000});
  await f.exec(`printf '%s\\n' '#!/bin/sh' 'sleep 300' > /work/slow; chmod +x /work/slow`);
  const slow=await m.manager.start({name:'slow',transport:f.transport,options:{cwd:'/work',nvidia_smi:'./slow',gpu_util_below:10,timeout_ms:20000},instructions:'Inspect failed sampling'});
  assert.equal(slow.state,'failed');assert.equal(m.manager.records[healthy.id].state,'armed');
  assert.ok(Object.values(m.manager.events).some(e=>e.monitor_id===slow.id&&e.evidence.error.includes('sample timeout')));
  // The timeout must reap the read-only query rather than leave it behind.
  const session=new SshSession(f.transport);t.after(()=>session.close());await session.open();
  const processes=await session.request("for p in /proc/[0-9]*/cmdline; do cat \"$p\" 2>/dev/null; printf '\\n'; done");
  assert.ok(!processes.data.includes(Buffer.from('sleep\0'+'300\0')),'Remote timeout left the query child running');
  await f.exec('mkdir /work/root; printf first > /work/root/progress');
  const watched=await m.manager.start({name:'root',transport:f.transport,options:{cwd:'/work',watch_directory:'/work/root',poll_ms:1000,timeout_ms:20000},instructions:'Inspect replaced root'});
  assert.equal(watched.state,'armed');assert.equal(watched.connection_id,healthy.connection_id);
  await f.exec('mv /work/root /work/previous-root; mkdir /work/root; printf second > /work/root/progress');
  await state(m.manager,()=>m.manager.records[watched.id].state==='stopped');
  assert.ok(Object.values(m.manager.events).some(e=>e.monitor_id===watched.id&&e.evidence.error.includes('root identity changed')));
  assert.equal(m.manager.records[healthy.id].state,'armed');assert.equal(m.manager.jobs.size,1);
  assert.ok(!Object.values(m.manager.events).some(e=>e.event_type.startsWith('connection_')));
  const after=await m.start('after');assert.equal(after.connection_id,healthy.connection_id);
});
