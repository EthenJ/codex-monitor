import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Bridge} from '../../codex-monitor/runtime/bridge.js';
import {Routing} from '../../codex-monitor/runtime/ancestry.js';
import {Manager} from '../../codex-monitor/runtime/manager.js';

function gate(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
for(const trigger of ['parent_message','close'])test(`native spawned agent inherits MCP, shares root monitoring and releases on ${trigger}`,{
 skip:!process.env.CODEX_MONITOR_TEST_NATIVE,timeout:30000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'monitor-subagent-native-')),history=path.join(root,'history.jsonl');await writeFile(history,'');
 let bridge,manager,routing,parent,child,monitor,result,spawnNamespace,requestNumber=0;
 const armed=gate(),continued=gate(),parentReady=gate(),notices=[];
 const emitters=new Map();
 const control=createServer(async(req,res)=>{
  try{
   let body='';for await(const c of req)body+=c;const {thread_id}=JSON.parse(body);
   const route=await routing.resolve(thread_id);assert.equal(route.owner,parent);assert.equal(route.caller,child);
   monitor=await manager.start({name:'native-child-work',instructions:'Inspect completion evidence',options:{cwd:root,watch_file:'result',timeout_ms:20000}},undefined,thread_id);
   let settled=false;const pending=manager.delegation.poll(thread_id,{timeout_ms:10000,input_poll_ms:50}).then(r=>{settled=true;return r;});
   while(manager.delegation.waits[thread_id]?.state!=='waiting'&&!settled)
    await Promise.race([manager.changes.wait(manager.changes.revision,500),pending]);
   if(settled)throw Error('Delegated native wait did not arm: '+JSON.stringify(await pending));
   armed.resolve();result=await pending;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(error){armed.reject(error);res.end(JSON.stringify({error:String(error)}));}
 });await new Promise(r=>control.listen(0,'127.0.0.1',r));
 const sdk=new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js',import.meta.url).href;
 const stdio=new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url).href;
 const zod=new URL('../../node_modules/zod/index.js',import.meta.url).href;
 await writeFile(path.join(root,'tool.mjs'),`import {McpServer} from ${JSON.stringify(sdk)};import {StdioServerTransport} from ${JSON.stringify(stdio)};import {z} from ${JSON.stringify(zod)};const server=new McpServer({name:'fixture',version:'1'});server.registerTool('poll',{inputSchema:{thread_id:z.string()},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{const r=await(await fetch('http://127.0.0.1:${control.address().port}',{method:'POST',body:JSON.stringify(args)})).json();return {content:[{type:'text',text:JSON.stringify(r)}]};});await server.connect(new StdioServerTransport());`);
 const provider=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;const request=JSON.parse(body);
  const n=++requestNumber,thread=request.client_metadata?.thread_id ?? request.prompt_cache_key;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const id=`r_${n}`,emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  emit({type:'response.created',response:{id,status:'in_progress',output:[]}});
  const call=(namespace,name,args)=>{
   const item={id:`fc_${n}`,type:'function_call',namespace,name,call_id:`call_${n}`,arguments:JSON.stringify(args),status:'completed'};
   emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}});emit({type:'response.output_item.done',output_index:0,item});
   emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  };
  emitters.set(thread,call);
  if(n===1){
   spawnNamespace=request.tools.find(x=>x.type==='namespace'&&x.tools?.some(t=>t.name==='spawn_agent'))?.name;
   assert.ok(spawnNamespace,'Native host must expose spawning in the isolated fixture');
   call(spawnNamespace,'spawn_agent',{message:'SUBAGENT_MONITOR_FIXTURE: use inherited poll tool to wait for external work.'});
  }else if(thread===parent)parentReady.resolve();
  else if(!child){
   child=thread;assert.ok(request.tools.some(x=>x.name==='mcp__fixture'||x.name==='mcp__fixture__poll'),'Child inherits MCP server');
   call('mcp__fixture','poll',{thread_id:child});
  }else continued.resolve(request);
 });await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 t.after(async()=>{
  if(t.error)t.diagnostic(JSON.stringify(notices.filter(x=>['thread/queue/changed','thread/goal/updated','thread/goal/cleared','turn/completed','thread/closed','thread/status/changed'].includes(x.method))));
  await manager?.close();await routing?.close();await bridge?.close();control.closeAllConnections();provider.closeAllConnections();
  await Promise.all([new Promise(r=>control.close(r)),new Promise(r=>provider.close(r))]);
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
 });
 await writeFile(path.join(root,'config.toml'),`model_provider="fixture"\nmodel="fixture"\n[features]\nmulti_agent=true\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(path.join(root,'tool.mjs'))}]\ntool_timeout_sec=86420\n[model_providers.fixture]\nname="Offline subagent fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
 bridge=await Bridge.connect({args:['app-server','--stdio'],jsonl:true,env:{...process.env,CODEX_HOME:root}});
 bridge.on('notification',(method,p)=>notices.push({method,p}));
 parent=(await bridge.rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
 manager=new Manager(path.join(root,'state',parent),parent,{connect:async()=>bridge,historyFile:history});routing=new Routing(path.join(root,'state'),async()=>bridge);
 await bridge.rpc('turn/start',{threadId:parent,input:[{type:'text',text:'Spawn one child for the offline monitoring test.'}]});
 await armed.promise;await parentReady.promise;
 assert.equal(manager.snapshot().monitors[0].creator_thread_id,child);assert.equal(manager.snapshot().monitors[0].owner_thread_id,parent);
 if(trigger==='parent_message')emitters.get(parent)(spawnNamespace,'send_input',{target:child,message:'NATIVE_PARENT_MESSAGE'});
 else emitters.get(parent)(spawnNamespace,'close_agent',{target:child});
 if(trigger!=='close'){
  const next=await continued.promise;assert.equal(result.reason,'agent_input');
  assert.ok(JSON.stringify(next.input).includes('NATIVE_PARENT_MESSAGE'));
 }else{
  while(manager.delegation.waits[child].state==='waiting')await manager.changes.wait(manager.changes.revision,500);
  assert.ok(['agent_stopped','agent_turn_ended','agent_closed'].includes(manager.delegation.waits[child].reason));
 }
 assert.equal(manager.records[monitor.id].state,'armed');assert.equal(manager.jobs.size,1);
 assert.ok(!notices.some(x=>x.method==='thread/goal/updated'),'Delegated waiting must not change any goal');
});
