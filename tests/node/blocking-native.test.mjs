import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Bridge,getGoal} from '../../codex-monitor/runtime/bridge.js';
import {Manager} from '../../codex-monitor/runtime/manager.js';

function gate(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
for(const trigger of ['event','input','timeout','cancel'])test(`native blocked MCP call keeps goal active and releases on ${trigger}`,{
  skip:!process.env.CODEX_MONITOR_TEST_NATIVE,timeout:25000,
},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-block-native-')),history=path.join(root,'history.jsonl');
  await writeFile(history,'');
  let bridge,manager,thread,monitor,requests=0,blockedResult,firstResponse;
  const first=gate(),second=gate(),armed=gate(),notices=[];
  const control=createServer(async(req,res)=>{
    for await(const c of req){}
    let settled=false;
    const pending=manager.blockWait({timeout_ms:trigger==='timeout'?400:5000,input_poll_ms:50}).then(value=>{settled=true;return value;});
    while(manager.wait?.state!=='waiting'&&!settled&&!manager.closed)
      await Promise.race([manager.changes.wait(manager.changes.revision,500),pending]);
    if(manager.wait?.state!=='waiting'){
      const result=await pending;armed.reject(Error('Native wait did not attach: '+JSON.stringify(result)));res.end(JSON.stringify(result));return;
    }
    armed.resolve();blockedResult=await pending;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(blockedResult));
  });
  await new Promise(r=>control.listen(0,'127.0.0.1',r));
  const sdk=new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js',import.meta.url).href;
  const stdio=new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url).href;
  await writeFile(path.join(root,'tool.mjs'),`import {McpServer} from ${JSON.stringify(sdk)};import {StdioServerTransport} from ${JSON.stringify(stdio)};const server=new McpServer({name:'fixture',version:'0.0.1'});server.registerTool('wait',{inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async()=>{const result=await (await fetch('http://127.0.0.1:${control.address().port}',{method:'POST',body:'{}'})).json();return {content:[{type:'text',text:JSON.stringify(result)}]};});await server.connect(new StdioServerTransport());`);
  const provider=createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;requests++;
    const request=JSON.parse(body);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const id=`r_${requests}`,emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    emit({type:'response.created',response:{id,status:'in_progress',output:[]}});
    if(requests===1){firstResponse=()=>{
      const item={id:'fc_wait',type:'function_call',namespace:'mcp__fixture',name:'wait',call_id:'call_wait',arguments:'{}',status:'completed'};
      emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}});
      emit({type:'response.output_item.done',output_index:0,item});
      emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
    };first.resolve();}else second.resolve(request);
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  t.after(async()=>{
    await manager?.close();await bridge?.close();control.closeAllConnections();provider.closeAllConnections();
    await Promise.all([new Promise(r=>control.close(r)),new Promise(r=>provider.close(r))]);
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  });
  await writeFile(path.join(root,'config.toml'),`model_provider="fixture"\nmodel="fixture"\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(path.join(root,'tool.mjs'))}]\ntool_timeout_sec=86420\n[model_providers.fixture]\nname="Offline blocked MCP fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  bridge=await Bridge.connect({args:['app-server','--stdio'],jsonl:true,env:{...process.env,CODEX_HOME:root}});
  bridge.on('notification',(method,p)=>notices.push({method,p,at:Date.now()}));
  thread=(await bridge.rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
  await bridge.rpc('thread/goal/set',{threadId:thread,status:'paused',objective:'Offline blocked MCP goal',tokenBudget:10000,origin:'user'});
  manager=new Manager(path.join(root,'state'),thread,{connect:async()=>bridge,historyFile:history});
  monitor=await manager.start({name:'fixture',instructions:'Inspect completion',options:{cwd:root,watch_file:'result',timeout_ms:20000}});
  const {turn}=await bridge.rpc('turn/start',{threadId:thread,input:[{type:'text',text:'Run the blocking tool fixture.'}]});
  await first.promise;await bridge.rpc('thread/goal/set',{threadId:thread,status:'active',origin:'user'});firstResponse();await armed.promise;
  const started=Date.now();
  assert.equal((await getGoal(bridge,thread)).status,'active');
  if(trigger==='event'){
    await new Promise(r=>setTimeout(r,100));assert.equal(requests,1,'Healthy blocking must not call the model');
    manager.event(monitor.id,{event_type:'process_exit',returncode:0});
  }else if(trigger==='input'){
    await bridge.rpc('turn/steer',{threadId:thread,expectedTurnId:turn.id,input:[{type:'text',text:'EXTRA_NATIVE_INPUT'}]});
    await new Promise(r=>setTimeout(r,100));
    assert.equal(requests,1,'Queued input does not itself release an ordinary MCP call');
    assert.ok(!notices.some(n=>n.at>=started&&n.p.item?.type==='userMessage'),'User-message events are delayed until tool completion');
    // Native CLI writes this immediately on submit. The Linux PTY fixture
    // separately verifies that actual CLI behavior; here test the exact signal.
    await appendFile(history,JSON.stringify({session_id:thread,ts:Math.floor(Date.now()/1000),text:'EXTRA_NATIVE_INPUT'})+'\n');
  }else if(trigger==='cancel')await manager.cancelWait();
  const continuation=await second.promise;
  assert.equal(blockedResult.reason,{event:'monitor_event',input:'user_input',timeout:'timeout',cancel:'cancelled'}[trigger]);
  assert.equal((await getGoal(bridge,thread)).status,'active');
  assert.equal(notices.filter(n=>n.method==='turn/started').length,1,'Tool result must continue the original turn');
  assert.equal(notices.filter(n=>n.method==='thread/goal/updated'&&n.p.goal.status==='paused').length,1,'Blocking never pauses the active goal');
  if(trigger==='input')assert.ok(JSON.stringify(continuation.input).includes('EXTRA_NATIVE_INPUT'));
  if(trigger==='event')assert.equal(Object.values(manager.events)[0].state,'returned');
  if(trigger==='cancel'){
    assert.equal(blockedResult.state,'cancelled');assert.equal(manager.jobs.size,1);
    assert.equal(manager.records[monitor.id].state,'armed');assert.equal(manager.records[monitor.id].muted,true);
  }
  await bridge.rpc('turn/interrupt',{threadId:thread,turnId:turn.id});
});
