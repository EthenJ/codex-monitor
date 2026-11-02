import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ensureBroker,rpc} from '../../codex-monitor/runtime/service.js';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'monitor-api-')),thread=randomUUID(),directory=path.join(root,thread),work=path.join(root,'work');
 await mkdir(work);const client=new Client({name:'reduced-api-test',version:'1'});let broker;
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('codex-monitor/runtime/server.js')],env:{...process.env,CODEX_MONITOR_HOME:root}}));
 t.after(async()=>{await client.close();for(const dir of [directory,broker].filter(Boolean))try{await rpc(dir,'shutdown');}catch{}await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
 return {root,thread,directory,work,client,call:(name,args={})=>client.callTool({name,arguments:{thread_id:thread,...args}}),
  broker:async()=>{broker=await ensureBroker(root);return broker;}};
}

test('the reduced status API reads empty and saved state without starting observers or recovery',async t=>{
 const f=await fixture(t);
 for(const details of ['summary','active','full']){
  const r=await f.call('status',{details});assert.equal(r.isError,undefined);assert.equal(r.structuredContent.source,'empty');
  assert.equal(existsSync(f.directory),false);
 }
 const monitor=randomUUID(),event=randomUUID();await mkdir(f.directory);
 const data={thread_id:f.thread,revision:1,monitors:{[monitor]:{id:monitor,name:'saved',state:'armed',options:{watch_file:'secret'},instructions:'Inspect this evidence'}},
  events:{[event]:{id:event,monitor_id:monitor,event_type:'file_change',state:'returned',evidence:{path:'private'},timing:{wait_elapsed_ms:1234}}},recovery:{enabled:true,state:'observing'}};
 const state=path.join(f.directory,'state.json');await writeFile(state,JSON.stringify(data));const before=await readFile(state,'utf8');
 const result=await f.call('status',{monitor_id:monitor});assert.equal(result.structuredContent.source,'saved');assert.equal(result.structuredContent.verified,false);
 assert.equal(result.structuredContent.details,'full');assert.deepEqual(result.structuredContent.monitors[0].options,data.monitors[monitor].options);
 assert.deepEqual(result.structuredContent.events[0].evidence,{path:'private'});assert.equal(result.structuredContent.events[0].timing.wait_elapsed_ms,1234);
 assert.equal(result.content[0].text,'Monitor · live status unavailable');assert.equal(await readFile(state,'utf8'),before);
 assert.equal(existsSync(path.join(f.directory,'endpoint.json')),false);
 for(const args of [{monitor_id:randomUUID()},{monitor_id:monitor,details:'summary'},{monitor_id:monitor,after_revision:1},{details:'full',after_revision:1},{wait_ms:10}])
  assert.equal((await f.call('status',args)).isError,true);
 assert.equal(await readFile(state,'utf8'),before);
});

test('stop requires one explicit target and stopping only waiting preserves an owned command',async t=>{
 const f=await fixture(t);
 for(const args of [{},{target:'wait',monitor_id:randomUUID()},{target:'all'}])assert.equal((await f.call('stop',args)).isError,true);
 assert.equal(existsSync(f.directory),false,'Invalid targets must fail before any service starts');
 await f.broker();
 const started=await f.call('start',{name:'owned',options:{cwd:f.work,command:'node -e "setTimeout(()=>{},15000)"',timeout_ms:20000},instructions:'Inspect completion'});
 assert.equal(started.isError,undefined);const id=started.structuredContent.id;
 const before=await rpc(f.directory,'status');
 const stopped=await f.call('stop',{target:'wait'});assert.equal(stopped.isError,undefined);
 assert.equal(stopped.structuredContent.target,'wait');assert.equal(stopped._meta.monitorView.tool,'stop');
 assert.match(stopped.content[0].text,/wait stopped.*observers unchanged.*goal unchanged/);
 const after=await rpc(f.directory,'status');assert.equal(after.service_pid,before.service_pid);
 assert.equal(after.monitors[0].state,'armed');assert.equal(after.monitors[0].observed_pid,before.monitors[0].observed_pid);
 const full=await f.call('status',{monitor_id:id});assert.equal(full.structuredContent.monitors[0].options.command,'node -e "setTimeout(()=>{},15000)"');
 const cancelled=await f.call('stop',{monitor_id:id});assert.equal(cancelled.structuredContent.state,'stopped');
 assert.equal((await rpc(f.directory,'status')).monitors[0].state,'stopped');
});

test('full status keeps accurate omitted event counts for bounded thread and selected monitor evidence',async t=>{
 const f=await fixture(t),monitor=randomUUID();await mkdir(f.directory);
 const events=Object.fromEntries(Array.from({length:12},(_,index)=>{const id=randomUUID();return [id,{id,monitor_id:monitor,
  event_type:'file_change',state:'pending',evidence:{index}}];}));
 await writeFile(path.join(f.directory,'state.json'),JSON.stringify({thread_id:f.thread,
  monitors:{[monitor]:{id:monitor,name:'backlog',state:'armed'}},events}));
 for(const args of [{details:'summary'},{details:'full'},{monitor_id:monitor}]){
  const r=await f.call('status',args);assert.equal(r.isError,undefined);
  assert.equal(r.structuredContent.events.length,8);assert.equal(r.structuredContent.omitted.events,4);
  assert.equal(r.structuredContent.summary.unhandled_events,12);
 }
});

test('event inspection and resolution replace standalone acknowledgement without hiding unsettled evidence',async t=>{
 const f=await fixture(t);await f.broker();
 const started=await f.call('start',{name:'events',options:{cwd:f.work,watch_file:'metrics',timeout_ms:10000},instructions:'Inspect progress'});
 const id=started.structuredContent.id;
 // The service owns the state; trigger real observation then use its revision wait.
 const before=await f.call('status');const changed=f.call('status',{after_revision:before.structuredContent.revision,wait_ms:3000});
 await writeFile(path.join(f.work,'metrics'),'ready\n');await changed;
 let snapshot=await rpc(f.directory,'status');
 if(!snapshot.events.length){const update=f.call('status',{after_revision:snapshot.revision,wait_ms:3000});await update;snapshot=await rpc(f.directory,'status');}
 assert.equal(snapshot.events.length,1);const event=snapshot.events[0];
 const inspect=await f.call('event',{event_ids:[event.id]});assert.equal(inspect.structuredContent.events[0].actionable,true);
 const full=await f.call('status',{monitor_id:id});assert.deepEqual(full.structuredContent.events[0].evidence,inspect.structuredContent.events[0].evidence);
 assert.equal(full.structuredContent.events[0].evidence.event_type,'file_change');
 assert.equal((await f.call('event',{event_ids:[event.id],resolution:' '})).isError,true);
 const resolved=await f.call('event',{event_ids:[event.id],resolution:'Evidence inspected; continue observing'});
 assert.equal(resolved.structuredContent.events[0].state,'acknowledged');assert.equal(resolved.structuredContent.report.summary.unhandled_events,0);
 assert.equal(resolved.structuredContent.report.summary.running,1);
 const again=await f.call('event',{event_ids:[event.id],resolution:'Already handled'});
 assert.deepEqual(again.structuredContent.already_settled_ids,[event.id]);
});
