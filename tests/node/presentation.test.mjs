import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Changes } from '../../codex-monitor/runtime/changes.js';
import { Manager } from '../../codex-monitor/runtime/manager.js';
import { summarize, waitReport } from '../../codex-monitor/runtime/report.js';
import { toolResult } from '../../codex-monitor/runtime/presentation.js';
import { widgetHtml, widgetUri } from '../../codex-monitor/runtime/widget.js';
import { ensureBroker, rpc } from '../../codex-monitor/runtime/service.js';

test('lifecycle journal is bounded, persistent, sample-free and contains no evidence or authority', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'monitor-changes-')); const thread=randomUUID();
  const directory=path.join(root,'state');const m=new Manager(directory,thread); t.after(async()=>{await m.close();await rm(root,{recursive:true,force:true});});
  const first=m.changes.revision;
  const record=await m.start({name:'watch',options:{cwd:root,watch_file:'metrics',timeout_ms:10000},instructions:'SECRET'});
  assert.deepEqual(m.changes.entries.filter(x=>x.id===record.id).map(x=>x.state),['starting','armed']);
  const rev=m.changes.revision;m.save();assert.equal(m.changes.revision,rev);
  m.records[record.id].event_count++;m.save();assert.equal(m.changes.revision,rev);
  await m.stop(record.id);assert.deepEqual(m.changes.entries.filter(x=>x.id===record.id).map(x=>x.state),['starting','armed','stopping','stopped']);
  m.events.e={id:'e',monitor_id:record.id,event_type:'file_change',state:'pending',evidence:'SECRET'};m.save();
  await m.acknowledge({event_ids:['e'],resolution:'SECRET'});
  assert.ok(m.changes.revision>first);assert.ok(!JSON.stringify(m.changes.entries).includes('SECRET'));
  const saved=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));const restored=new Changes(saved);
  assert.equal(restored.revision,m.changes.revision);assert.equal(restored.update(saved),false);
  const data={monitors:{a:{id:'a',state:'armed'}}};for(let i=0;i<160;i++){data.monitors.a.state=String(i);restored.update(data);}
  assert.equal(restored.entries.length,128);assert.equal(summarize({thread_id:thread,revision:restored.revision,changes:restored.entries},'live').changes_omitted,restored.revision-128);
});

test('live wait resolves only for revisions, timeout, cancellation or close and releases viewers',async()=>{
  const c=new Changes();const abort=new AbortController();
  const waiting=c.wait(0,5000,abort.signal);assert.equal(c.listeners,1);abort.abort();await waiting;assert.equal(c.listeners,0);
  const changed=c.wait(0,5000);c.update({wait:{id:'w',state:'waiting'}});c.notify();await changed;assert.equal(c.listeners,0);
  await c.wait(0,5000);assert.equal(c.listeners,0);
  await c.wait(c.revision,5);assert.equal(c.listeners,0);
  const controllers=Array.from({length:32},()=>new AbortController());const waits=controllers.map(a=>c.wait(c.revision,5000,a.signal));
  await assert.rejects(c.wait(c.revision,5000),/32 live/);controllers.forEach(a=>a.abort());await Promise.all(waits);assert.equal(c.listeners,0);
  const closed=c.wait(c.revision,5000);c.close();await closed;assert.equal(c.listeners,0);
});

test('tool cards preserve structured data, safely render labels and survive error results',()=>{
  const data={id:randomUUID(),name:'<img src=x onerror=alert(1)> [click](https://evil.test)\u202e',state:'armed'};
  const result=toolResult('monitor_start',data);assert.equal(result.structuredContent,data);assert.equal(JSON.parse(result.content[1].text).name,data.name);
  assert.ok(!result.content[0].text.includes('<img'));assert.ok(!result.content[0].text.includes('[click]'));assert.ok(!result.content[0].text.includes('\u202e'));
  for(const tool of ['monitor_status','monitor_report','monitor_stop'])assert.equal(toolResult(tool,{ok:false,error:'unavailable'},true).isError,true);
});

test('MCP tools serve the UI and long wait sees mutations without starting a model', {timeout:20000}, async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-panel-'));const state=path.join(root,'state'),thread=randomUUID(),directory=path.join(state,thread);
  const broker=await ensureBroker(state);const client=new Client({name:'panel-test',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('codex-monitor/runtime/server.js')],env:{...process.env,CODEX_MONITOR_HOME:state}}));
    const tools=(await client.listTools()).tools;assert.equal(tools.length,9);assert.ok(tools.every(x=>x._meta.ui.resourceUri===widgetUri&&x.title));
    assert.ok(tools.every(x=>x._meta['openai/ui'].preferredModelDisplayMode==='inline'));
    assert.equal((await client.readResource({uri:widgetUri})).contents[0].text,widgetHtml);
    const call=(name,args={})=>client.callTool({name,arguments:{thread_id:thread,...args}});
    const empty=await call('monitor_report');assert.equal(empty.structuredContent.source,'empty');assert.equal(empty.structuredContent.live_updates,false);
    assert.equal((await call('monitor_report',{wait_ms:1})).isError,true);
    const start=await call('monitor_start',{name:'panel',options:{cwd:root,watch_file:'metrics',timeout_ms:10000},instructions:'test',notify_on:['monitor_expired']});
    assert.equal(start._meta.monitorView.report.summary.active,1);
    const before=(await call('monitor_report')).structuredContent;assert.equal(before.live_updates,true);
    const change=call('monitor_report',{after_revision:before.revision,wait_ms:5000});
    await call('monitor_stop',{monitor_id:start.structuredContent.id});
    const result=(await change).structuredContent;assert.ok(result.revision>before.revision);
    const latest=(await call('monitor_report')).structuredContent;assert.equal(latest.summary.active,0);assert.equal(latest.summary.unhandled_events,0);
    const timeout=await call('monitor_report',{after_revision:latest.revision,wait_ms:10});assert.equal(timeout.structuredContent.revision,latest.revision);
    assert.equal((await rpc(directory,'status')).events.length,0);
  }finally{await client.close();for(const dir of [directory,broker])try{await rpc(dir,'shutdown');}catch{}await rm(root,{recursive:true,force:true});}
});

test('missing live transport falls back without rearming or claiming live updates',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-panel-offline-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const r=await waitReport(randomUUID(),0,5,undefined,root);assert.equal(r.live_updates,false);assert.equal(r.source,'empty');
});

// Exercise the shipped bridge script with hostile input and host messages, not a duplicate implementation.
test('panel uses one read-only wait, ignores foreign messages and stops on disconnect',async()=>{
  class Element {children=[];textContent='';append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}}
  const elements=new Map(),listeners={},sent=[];const parent={postMessage:m=>sent.push(m)};
  const document={hidden:false,getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element(),addEventListener:(name,fn)=>{listeners[name]=fn;},documentElement:{getBoundingClientRect:()=>({height:500})}};
  const window={parent,addEventListener:(name,fn)=>{listeners[name]=fn;}};
  vm.runInNewContext(widgetHtml.match(/<script>([\s\S]*)<\/script>/)[1],{window,document,setTimeout,clearTimeout,console});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const message=(data,source=parent)=>listeners.message({source,data:{jsonrpc:'2.0',...data}});
  try {
    message({id:sent[0].id,result:{}});await flush();
    const r=summarize({thread_id:randomUUID(),revision:1,monitors:[{id:'m',name:'<img onerror=bad>',state:'armed'}]},'live');
    message({method:'ui/notifications/tool-result',params:toolResult('monitor_report',r,false,r)},{});assert.equal(sent.filter(x=>x.method==='tools/call').length,0);
    message({method:'ui/notifications/tool-result',params:toolResult('monitor_report',r,false,r)});await flush();
    let calls=sent.filter(x=>x.method==='tools/call');assert.equal(calls.length,1);assert.equal(calls[0].params.name,'monitor_report');assert.equal(calls[0].params.arguments.after_revision,1);
    assert.equal(elements.get('monitors').children[0].children[0].children[0].textContent,'<img onerror=bad>');
    message({method:'ui/notifications/tool-result',params:toolResult('monitor_report',r,false,r)});await flush();assert.equal(sent.filter(x=>x.method==='tools/call').length,1);
    document.hidden=true;listeners.visibilitychange();message({id:calls[0].id,result:toolResult('monitor_report',r)});await flush();assert.equal(sent.filter(x=>x.method==='tools/call').length,1);
    document.hidden=false;listeners.visibilitychange();await flush();calls=sent.filter(x=>x.method==='tools/call');assert.equal(calls.length,2);
    message({id:calls[1].id,error:{message:'Offline'}});await flush();assert.equal(sent.filter(x=>x.method==='tools/call').length,2);
    assert.equal(sent.some(x=>x.method==='ui/message'),false);
  }finally{listeners.pagehide();await flush();}
});
