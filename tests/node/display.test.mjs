import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { displaySettings } from '../../codex-monitor/runtime/display.js';
import { Manager } from '../../codex-monitor/runtime/manager.js';
import { toolResult } from '../../codex-monitor/runtime/presentation.js';
import { eventText } from '../../codex-monitor/runtime/event-text.js';
import { summarize } from '../../codex-monitor/runtime/report.js';
import { ensureBroker, rpc } from '../../codex-monitor/runtime/service.js';

async function setup(t) {
  const root=await mkdtemp(path.join(tmpdir(),'monitor-display-')),thread=randomUUID(),dir=path.join(root,thread);
  const cleanup=[];t.after(async()=>{for(const f of cleanup)await f();await rm(root,{recursive:true,force:true});});return{root,thread,dir,cleanup};
}
test('display mode is thread-scoped, defaults compact and never starts supervision',async t=>{
  const {root,thread,dir}=await setup(t),other=randomUUID();
  assert.equal(displaySettings(thread,undefined,root).mode,'compact');assert.equal(existsSync(dir),false);
  assert.equal(displaySettings(thread,'verbose',root).mode,'verbose');
  assert.equal(displaySettings(thread,undefined,root).mode,'verbose');assert.equal(displaySettings(other,undefined,root).mode,'compact');
  const before=await readFile(path.join(dir,'display.json'),'utf8');
  assert.throws(()=>displaySettings(thread,'hidden',root));assert.equal(await readFile(path.join(dir,'display.json'),'utf8'),before);
  assert.equal(existsSync(path.join(dir,'state.json')),false);assert.equal(existsSync(path.join(dir,'endpoint.json')),false);
  await writeFile(path.join(dir,'display.json'),JSON.stringify({thread_id:other,mode:'verbose'}));
  assert.equal(displaySettings(thread,undefined,root).mode,'compact');assert.equal(displaySettings(thread,undefined,root).warnings.length,1);
  assert.throws(()=>displaySettings('../escape','compact',root));
});
test('event inspection is read-only; resolution preserves settled events and active workloads',async t=>{
  const {root,thread,dir,cleanup}=await setup(t),work=path.join(root,'work');await mkdir(work);
  const host=new EventEmitter();host.close=async()=>{};host.rpc=async(method)=>method==='thread/loaded/list'?{data:[thread]}:{};
  const manager=new Manager(dir,thread,{connect:async()=>host});cleanup.push(()=>manager.close());
  const monitor=await manager.start({name:'event-test',options:{cwd:work,watch_file:'metrics',timeout_ms:30000},instructions:'Registered action'});
  const eid=randomUUID(),stale=randomUUID();
  manager.events[eid]={id:eid,monitor_id:monitor.id,event_type:'file_change',state:'submitted',occurred_at:Date.now(),expires_at:Date.now()+30000,evidence:{path:'metrics',value:'UNTRUSTED'}};
  manager.events[stale]={...manager.events[eid],id:stale,state:'superseded'};manager.save();
  const before=await readFile(path.join(dir,'state.json'),'utf8');
  const inspected=await manager.reviewEvent({event_ids:[eid]});
  assert.equal(inspected.events[0].actionable,true);assert.equal(inspected.events[0].instructions,'Registered action');
  assert.equal(inspected.events[0].evidence.value,'UNTRUSTED');assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),before);
  await assert.rejects(manager.reviewEvent({event_ids:[eid,randomUUID()],resolution:'checked'}),/Unknown event/);
  await assert.rejects(manager.reviewEvent({event_ids:[eid],resolution:' '}));
  assert.equal(manager.events[eid].state,'submitted');
  const resolved=await manager.reviewEvent({event_ids:[eid,stale,eid],resolution:'Checked file; keep observing'});
  assert.deepEqual(resolved.acknowledged_ids,[eid]);assert.deepEqual(resolved.already_settled_ids,[stale]);
  assert.equal(manager.events[stale].state,'superseded');assert.equal(manager.records[monitor.id].state,'armed');assert.equal(manager.jobs.size,1);
  const timestamp=manager.events[eid].acknowledged_at;
  assert.deepEqual((await manager.reviewEvent({event_ids:[eid],resolution:'repeat'})).acknowledged_ids,[]);
  assert.equal(manager.events[eid].acknowledged_at,timestamp);
  await manager.stop(monitor.id);
});
test('installation defaults apply to new threads and per-thread choices override them', async t => {
  const {root,thread}=await setup(t);
  await writeFile(path.join(root,'settings.json'),JSON.stringify({display_mode:'verbose'}));
  assert.equal(displaySettings(thread,undefined,root).mode,'verbose');
  assert.equal(displaySettings(thread,'compact',root).mode,'compact');
  assert.equal(displaySettings(thread,undefined,root).mode,'compact');
  await writeFile(path.join(root,'settings.json'),'{bad json');
  assert.equal(displaySettings(thread,undefined,root).mode,'compact');
  assert.deepEqual(displaySettings(thread,undefined,root).warnings,[]);
  const fallback=displaySettings(randomUUID(),undefined,root);
  assert.equal(fallback.mode,'compact');assert.equal(fallback.warnings.length,1);
});
test('expired callbacks remain expired and unknown IDs never acknowledge a valid selection',async t=>{
  const {dir,thread,cleanup}=await setup(t),manager=new Manager(dir,thread);cleanup.push(()=>manager.close());
  const eid=randomUUID();manager.events[eid]={id:eid,monitor_id:randomUUID(),state:'submitted',expires_at:0};
  const r=await manager.reviewEvent({event_ids:[eid],resolution:'Already obsolete'});
  assert.equal(r.events[0].state,'expired');assert.equal(r.events[0].actionable,false);assert.deepEqual(r.acknowledged_ids,[]);
});
test('trigger cards show failures and progress, keep evidence structured, and add verbose details',()=>{
  const event={id:randomUUID(),monitor_id:randomUUID(),name:'job\u001b\u202e<img>',event_type:'command_exit',evidence:{returncode:7,private:'SECRET'},instructions:'SECRET',state:'submitted',actionable:true};
  const report=summarize({monitors:[],events:[event]},'live'),data={events:[event],report};
  const compact=toolResult('monitor_event',data,false,report),verbose=toolResult('monitor_event',data,false,report,'verbose');
  assert.match(compact.content[0].text,/Monitor event/);assert.match(compact.content[0].text,/! command finished · exit 7 · needs review/);
  assert.match(compact.content[0].text,/none running/);assert.ok(!compact.content[0].text.includes(event.id));
  assert.ok(!/SECRET|[\u001b\u202e<>]/.test(compact.content[0].text));assert.ok(verbose.content[0].text.includes(event.id));
  assert.equal(compact.structuredContent,data);assert.equal(compact.content.length,1);
  const callback={type:'monitor_events',events:[{...event,event_id:event.id}]};
  assert.match(eventText(callback),/Compact display: call monitor_event/);assert.match(eventText({...callback,display_mode:'verbose'}),/Verbose display: read monitor_status/);
  assert.ok(!eventText(callback).includes('SECRET'));
});
test('MCP event acknowledgement carries the final report; display changes need no service restart', {timeout:20000},async t=>{
  const {root,thread,dir}=await setup(t),work=path.join(root,'work');await mkdir(work);
  const client=new Client({name:'compact-display-test',version:'1'}),broker=await ensureBroker(root);
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('codex-monitor/runtime/server.js')],env:{...process.env,CODEX_MONITOR_HOME:root}}));
    const call=(name,args={})=>client.callTool({name,arguments:{thread_id:thread,...args}});
    assert.equal((await call('monitor_display')).structuredContent.mode,'compact');assert.equal(existsSync(path.join(dir,'endpoint.json')),false);
    const started=await call('monitor_start',{name:'compact-test',options:{cwd:work,watch_file:'metrics',timeout_ms:10000},instructions:'Check progress',notify_on:['monitor_expired']});
    assert.equal(started.structuredContent.report.summary.running,1);assert.equal(started.content[0].text.split('\n').length,1);
    const pid=(await rpc(dir,'status')).service_pid;
    await call('monitor_display',{mode:'verbose'});
    assert.match((await call('monitor_status')).content[0].text,/compact-test · running/);
    assert.equal((await rpc(dir,'status')).service_pid,pid);
    await call('monitor_display',{mode:'compact'});
    assert.equal((await call('monitor_status')).content[0].text,'Monitor · 1 running');
    const stopped=await call('monitor_stop',{monitor_id:started.structuredContent.id});
    assert.equal(stopped.structuredContent.report.summary.running,0);
    const command=await call('monitor_start',{name:'completed-event',options:{cwd:work,command:'node -e "process.exit(0)"',timeout_ms:10000},instructions:'Check exit',notify_on:['command_exit']});
    let event;const deadline=Date.now()+5000;
    while(!event){event=(await rpc(dir,'status',{monitor_id:command.structuredContent.id})).events[0];if(Date.now()>deadline)assert.fail('Command completion missing');if(!event)await new Promise(r=>setTimeout(r,10));}
    const inspected=await call('monitor_event',{event_ids:[event.id]});assert.equal(inspected.structuredContent.events[0].evidence.returncode,0);
    assert.equal(inspected.structuredContent.events[0].actionable,true);assert.match(inspected.content[0].text,/needs review/);
    const handled=await call('monitor_event',{event_ids:[event.id],resolution:'Verified exit 0'});
    assert.equal(handled.structuredContent.report.summary.running,0);assert.equal(handled.structuredContent.report.summary.unhandled_events,0);
    assert.match(handled.content[0].text,/acknowledged/);assert.equal(handled.structuredContent.events[0].monitor_state,'stopped');
    const bad=await call('monitor_event',{event_ids:[randomUUID()],resolution:'checked'});assert.equal(bad.isError,true);
    assert.match(bad.content[0].text,/Unknown event/);
  }finally{await client.close();for(const directory of[dir,broker])try{await rpc(directory,'shutdown');}catch{}}
});
