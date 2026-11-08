import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Bridge,codexExecutable} from '../../codex-monitor/runtime/bridge.js';
import {owned} from '../../codex-monitor/runtime/processes.js';
import {rpc} from '../../codex-monitor/runtime/service.js';

function gate(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}

test('native inherited production MCP routes children into one root service and enforces scope',{
 skip:!process.env.CODEX_MONITOR_TEST_NATIVE,timeout:60000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'ms-')),state=path.join(root,'state');await mkdir(state);
 await writeFile(path.join(state,'settings.json'),JSON.stringify({recovery_enabled:false}));await writeFile(path.join(root,'history.jsonl'),'');
 let app,broker,bridge,parent,child,monitor,rootMonitor,requestNumber=0,childRequests=0,rootCalls=0;
 let appLog='';const notices=[];
 const returned=gate(),pollRequested=gate(),parentRunning=gate(),childEnd=gate();let finishChild;
 const provider=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;const request=JSON.parse(body),n=++requestNumber;
  const thread=request.client_metadata?.thread_id ?? request.prompt_cache_key;
  res.writeHead(200,{'Content-Type':'text/event-stream'});const id=`r_${n}`,emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  emit({type:'response.created',response:{id,status:'in_progress',output:[]}});
  const finish=output=>{emit({type:'response.completed',response:{id,status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();};
  const call=(namespace,name,args)=>{
   const item={id:`fc_${n}`,type:'function_call',namespace,name,call_id:`call_${n}`,arguments:JSON.stringify(args),status:'completed'};
   emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}});emit({type:'response.output_item.done',output_index:0,item});finish([item]);
  };
  if(thread===parent){
   rootCalls++;
   if(rootCalls===1){const ns=request.tools.find(x=>x.tools?.some(t=>t.name==='spawn_agent'))?.name;
    call(ns,'spawn_agent',{message:'Native monitor plugin fixture: monitor a progress file with inherited MCP tools.'});
   }else parentRunning.resolve();
  }else{
   child=thread;childRequests++;
   if(childRequests===1)call('mcp__monitor','start',{thread_id:child,name:'native-child',instructions:'Inspect and handle completion',options:{cwd:root,watch_file:'child-result',max_events:1,timeout_ms:30000}});
   else if(childRequests===2){
    const output=request.input.findLast(x=>x.type==='function_call_output')?.output;
    const serialized=typeof output==='string'?output:JSON.stringify(output);
    if(/request failed|unsupported call|requires approval/.test(serialized)){pollRequested.reject(Error(serialized));return;}
    call('mcp__monitor','poll',{thread_id:child,timeout_ms:20000,input_poll_ms:50});pollRequested.resolve();
   }else{finishChild=()=>finish([]);returned.resolve(request);}
  }
 });await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const env={...process.env,CODEX_HOME:root,CODEX_MONITOR_HOME:state};
 t.after(async()=>{
  if(!child)t.diagnostic('App startup: '+appLog);
  if(parent)try{
   const directory=path.join(state,parent),snapshot=await rpc(directory,'status');
   for(const m of snapshot.monitors)await rpc(directory,'stop',{monitor_id:m.id});
   await rpc(directory,'recovery',{enabled:false});await rpc(directory,'shutdown');
  }catch{}
  await bridge?.close();await app?.stop();await broker?.stop();provider.closeAllConnections();await new Promise(r=>provider.close(r));
  await rm(root,{recursive:true,force:true,maxRetries:12,retryDelay:150});
 });
 await writeFile(path.join(root,'config.toml'),`model_provider="fixture"\nmodel="fixture"\n[features]\nmulti_agent=true\n[mcp_servers.monitor]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(path.resolve('codex-monitor/runtime/server.js'))}]\nenv={CODEX_HOME=${JSON.stringify(root)},CODEX_MONITOR_HOME=${JSON.stringify(state)}}\ntool_timeout_sec=86420\n[model_providers.fixture]\nname="Offline full MCP fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
 app=await owned(codexExecutable(),['app-server','--listen','unix://'],{env});app.process.stdin.end();app.process.stdout.resume();app.process.stderr.on('data',chunk=>{appLog=(appLog+chunk).slice(-5000);});
 broker=await owned(process.execPath,[path.resolve('codex-monitor/runtime/cli.js'),'broker',path.join(state,'broker')],{env});broker.process.stdin.end();broker.process.stdout.resume();broker.process.stderr.resume();
 for(let i=0;i<40;i++){try{bridge=await Bridge.connect({env});break;}catch(error){if(i===39)throw error;await new Promise(r=>setTimeout(r,50));}}
 bridge.on('notification',(method,p)=>{notices.push({method,p});if(method==='turn/completed'&&p.threadId===child)childEnd.resolve();});
 parent=(await bridge.rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'danger-full-access'})).thread.id;
 await bridge.rpc('turn/start',{threadId:parent,input:[{type:'text',text:'Spawn one subagent to test the monitor plugin.'}]});
 await pollRequested.promise;await parentRunning.promise;
 const directory=path.join(state,parent);
 let snapshot;
 for(let i=0;i<50;i++){
  snapshot=await rpc(directory,'status');if(snapshot.delegated_waits?.some(w=>w.state==='waiting'))break;
  await rpc(directory,'report_wait',{after_revision:snapshot.revision,wait_ms:500},2000);
 }
 assert.ok(snapshot.delegated_waits.some(w=>w.state==='waiting'),
  'Production delegated poll armed: '+JSON.stringify({waits:snapshot.delegated_waits,monitors:snapshot.monitors,childRequests}));
 monitor=snapshot.monitors.find(m=>m.creator_thread_id===child);assert.ok(monitor);assert.equal(monitor.owner_thread_id,parent);
 assert.equal(snapshot.recovery.enabled,false);
 const tool=async(thread,name,args={})=>bridge.rpc('mcpServer/tool/call',{threadId:thread,server:'monitor',tool:name,arguments:{thread_id:thread,...args}});
 rootMonitor=(await tool(parent,'start',{name:'root-only',instructions:'Inspect root result',options:{cwd:root,watch_file:'root-result',timeout_ms:30000}})).structuredContent;
 assert.ok(rootMonitor.id);
 const childStatus=await tool(child,'status',{details:'active'});assert.equal(childStatus.structuredContent.monitors.length,1);
 assert.equal(childStatus.structuredContent.owner_thread_id,parent);
 assert.equal((await tool(child,'stop',{monitor_id:rootMonitor.id})).isError,true);
 assert.equal((await tool(child,'recovery',{enabled:false})).isError,true);
 assert.equal((await tool(child,'poll',{mode:'pause'})).isError,true);
 assert.equal((await tool(parent,'status')).structuredContent.summary.running,2);
 await writeFile(path.join(root,'child-result'),'completed');const next=await returned.promise;
 assert.ok(JSON.stringify(next.input).includes('monitor_event'));snapshot=await rpc(directory,'status');
 const event=snapshot.events.find(e=>e.monitor_id===monitor.id);assert.equal(event.delivery_thread_id,child);assert.equal(event.state,'returned');
 assert.equal(childRequests,3,'Start and poll results continue the original child turn');
 assert.equal(rootCalls,2,'Child delivery must not start a duplicate parent callback');
 assert.ok(!notices.some(n=>n.method==='thread/goal/updated'),'Child monitoring does not mutate native goals');
 const reviewed=await tool(child,'event',{event_ids:[event.id],resolution:'Verified native file result in the fixture'});
 assert.equal(reviewed.structuredContent.events[0].state,'acknowledged');
 assert.equal((await tool(child,'stop',{target:'wait'})).structuredContent.target,'wait');
 finishChild();await childEnd.promise;
 assert.equal((await rpc(directory,'status')).events.find(e=>e.id===event.id).state,'acknowledged');
 assert.equal((await tool(parent,'stop',{monitor_id:rootMonitor.id})).structuredContent.state,'stopped');
});
