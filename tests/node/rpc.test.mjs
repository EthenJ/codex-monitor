import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {rpc} from '../../codex-monitor/runtime/service.js';
import {owned} from '../../codex-monitor/runtime/processes.js';

function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function endpoint(t,handler){
 const root=await mkdtemp(path.join(tmpdir(),'monitor-rpc-')),server=createServer(handler);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(path.join(root,'endpoint.json'),JSON.stringify({port:server.address().port,token:'fixture-token'}));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
 return root;
}

test('local RPC permits quiet headers and decodes a split Unicode response',async t=>{
 const reached=gate(),release=gate();let posted,headers;
 const root=await endpoint(t,async(req,res)=>{
  headers=req.headers;let body='';for await(const part of req)body+=part;posted=JSON.parse(body);reached.resolve();await release.promise;
  const bytes=Buffer.from(JSON.stringify({result:{text:'训练完成'}})),cut=bytes.indexOf(Buffer.from('训练'))+1;
  res.writeHead(200,{'Content-Type':'application/json'});res.write(bytes.subarray(0,cut));setImmediate(()=>res.end(bytes.subarray(cut)));
 });
 const pending=rpc(root,'block_wait',{instructions:'检查训练'},5000);await reached.promise;
 assert.equal(headers.authorization,'Bearer fixture-token');assert.equal(posted.params.instructions,'检查训练');
 release.resolve();assert.deepEqual(await pending,{text:'训练完成'});
});

for(const kind of ['deadline','caller_abort','body_abort'])test(`local RPC ${kind} closes a pending response`,async t=>{
 const reached=gate(),closed=gate(),controller=new AbortController();
 const root=await endpoint(t,async(req,res)=>{
  for await(const part of req){}res.once('close',()=>closed.resolve());
  if(kind==='body_abort'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"result":');}
  reached.resolve();
 });
 const pending=rpc(root,'block_wait',{},kind==='deadline'?250:5000,controller.signal);
 const rejected=assert.rejects(pending,e=>e.name==='AbortError'||e.code==='ECONNRESET');
 await reached.promise;if(kind!=='deadline')controller.abort();
 await rejected;await closed.promise;
});

test('local RPC preserves structured capacity and validation errors',async t=>{
 const root=await endpoint(t,async(req,res)=>{for await(const part of req){}res.writeHead(409,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Capacity reached',code:'MONITOR_CAPACITY_EXCEEDED',capacity:{used:32},guidance:['Consolidate sources'],validation:{valid:false}}));});
 await assert.rejects(rpc(root,'start'),e=>e.code==='MONITOR_CAPACITY_EXCEEDED'&&e.capacity.used===32&&e.report.valid===false&&e.guidance[0]==='Consolidate sources');
});

for(const mode of ['block_wait','wait'])test(`service cancellation during default initialization prevents a late ${mode}`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'monitor-service-cancel-')),directory=path.join(root,'state'),thread=randomUUID();
 const service=new URL('../../codex-monitor/runtime/service.js',import.meta.url).href,manager=new URL('../../codex-monitor/runtime/manager.js',import.meta.url).href;
 const script=path.join(root,'fixture.mjs');
 await writeFile(script,`import {EventEmitter} from 'node:events';import {serve} from ${JSON.stringify(service)};import {Manager} from ${JSON.stringify(manager)};
 const host=new EventEmitter();host.rpc=async method=>method==='config/read'?{config:{history:{persistence:'save-all'}}}:method==='thread/goal/get'?{goal:null}:method==='thread/turns/list'?{data:[{id:'caller',status:'inProgress'}]}:method==='thread/loaded/list'?{data:[${JSON.stringify(thread)}]}:{};host.close=async()=>{};
 Manager.prototype.connect=async()=>host;let activation=0,release;const pending=new Promise(r=>{release=r;});
 Manager.prototype.activateDefaults=async()=>{if(++activation>1){console.log('DEFAULTS_CHECK');await pending;}};
 process.stdin.on('data',()=>release());await serve(${JSON.stringify(directory)},${JSON.stringify(thread)});console.log('READY');`);
 await writeFile(path.join(root,'history.jsonl'),'');
 const child=await owned(process.execPath,[script],{env:{...process.env,CODEX_HOME:root}}),ready=gate(),checking=gate();
 const lines=createInterface({input:child.process.stdout});lines.on('line',line=>{if(line==='READY')ready.resolve();if(line==='DEFAULTS_CHECK')checking.resolve();});child.process.stderr.resume();
 t.after(async()=>{child.process.stdin.write('release\n');await child.stop();lines.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
 await ready.promise;await rpc(directory,'start',{name:'work',instructions:'Inspect',options:{cwd:root,watch_file:'metrics',timeout_ms:10000}});
 const waiting=rpc(directory,mode,{timeout_ms:100,input_poll_ms:50},5000);await checking.promise;
 await rpc(directory,'cancel_wait');child.process.stdin.write('release\n');
 const result=await waiting;assert.equal(result.state,'cancelled');
 assert.equal((await rpc(directory,'status')).monitors[0].state,'armed');
});
