import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {watchInputHistory} from '../../codex-monitor/runtime/input-history.js';
import {codexExecutable} from '../../codex-monitor/runtime/bridge.js';

test('real CLI submitted input releases a pending MCP tool through the same-thread history adapter',{
  skip:!process.env.CODEX_MONITOR_TEST_NATIVE||process.platform==='win32',timeout:25000,
},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-cli-input-'));
  let terminal,observer,release,thread,sendTimer,enterTimer,resolveDone,rejectDone;
  let toolPending=false,turnRequests=0,inputSeenWhilePending=false,closed=false;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});void done.catch(()=>{});
  const control=createServer(async(req,res)=>{
    for await(const c of req){}
    toolPending=true;release=()=>{toolPending=false;res.end('Input hint received; let Codex consume its own queued message.');};
    try{
      observer=await watchInputHistory(path.join(root,'history.jsonl'),thread,reason=>{
        if(reason!=='user_input'){rejectDone(Error(reason));return;}
        inputSeenWhilePending=toolPending;release();
      },50);
      // Separate typing from Enter so Codex does not interpret the burst as a
      // bracketed paste. This writes only to this isolated test's pseudo-terminal.
      sendTimer=setTimeout(()=>terminal.stdin.write('EXTRA_CLI_INPUT'),100);
      enterTimer=setTimeout(()=>terminal.stdin.write('\r'),900);
    }catch(e){rejectDone(e);res.end();}
  });
  await new Promise(r=>control.listen(0,'127.0.0.1',r));
  const sdk=new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js',import.meta.url).href;
  const stdio=new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url).href;
  await writeFile(path.join(root,'tool.mjs'),`import {McpServer} from ${JSON.stringify(sdk)};import {StdioServerTransport} from ${JSON.stringify(stdio)};const server=new McpServer({name:'fixture',version:'0.0.1'});server.registerTool('wait',{inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async()=>{const text=await(await fetch('http://127.0.0.1:${control.address().port}',{method:'POST',body:'{}'})).text();return {content:[{type:'text',text}]};});await server.connect(new StdioServerTransport());`);
  const provider=createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;const request=JSON.parse(body);
    let meta={};try{meta=JSON.parse(request.client_metadata?.['x-codex-turn-metadata']||'{}');}catch{}
    const isTitle=meta.request_kind&&meta.request_kind!=='turn'||JSON.stringify(request.input).includes('Generate a concise, single-line task title');
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const id='fixture_'+Date.now(),emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    emit({type:'response.created',response:{id,status:'in_progress',output:[]}});
    if(!isTitle&&++turnRequests===1){
      thread=request.client_metadata.thread_id;
      const item={id:'fc_wait',type:'function_call',namespace:'mcp__fixture',name:'wait',call_id:'call_wait',arguments:'{}',status:'completed'};
      emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}});
      emit({type:'response.output_item.done',output_index:0,item});
      emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
    }else if(!isTitle){resolveDone(request);}
    else{
      const item={id:'msg_title',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Test CLI input',annotations:[]}]};
      emit({type:'response.output_item.added',output_index:0,item});emit({type:'response.output_item.done',output_index:0,item});
      emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
    }
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const deadline=setTimeout(()=>rejectDone(Error('CLI input fixture timed out')),18000);
  t.after(async()=>{
    closed=true;clearTimeout(deadline);clearTimeout(sendTimer);clearTimeout(enterTimer);observer?.close();release?.();
    if(terminal){try{process.kill(-terminal.pid,'SIGKILL');}catch{}await new Promise(r=>terminal.exitCode!==null?r():terminal.once('close',r));}
    control.closeAllConnections();provider.closeAllConnections();
    await Promise.all([new Promise(r=>control.close(r)),new Promise(r=>provider.close(r))]);
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  });
  await writeFile(path.join(root,'config.toml'),`model_provider="fixture"\nmodel="fixture"\ncheck_for_update_on_startup=false\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(path.join(root,'tool.mjs'))}]\ntool_timeout_sec=86420\n[model_providers.fixture]\nname="Offline CLI input fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  terminal=spawn('script',['-qefc',`stty rows 40 cols 120; ${quote(codexExecutable())} --no-alt-screen --cd ${quote(root)} CLI_INPUT_FIXTURE`,'/dev/null'],{
    detached:true,env:{...process.env,CODEX_HOME:root,TERM:'xterm-256color'},stdio:['pipe','pipe','pipe'],
  });
  terminal.on('error',rejectDone);terminal.on('close',code=>{if(!closed)rejectDone(Error('CLI exited before input continuation: '+code));});
  terminal.stderr.resume();terminal.stdout.on('data',chunk=>{
    const output=chunk.toString();
    if(output.includes('\x1b[6n'))terminal.stdin.write('\x1b[1;1R');
    if(output.includes('\x1b]11;?'))terminal.stdin.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
  });
  const continuation=await done;
  assert.equal(inputSeenWhilePending,true);assert.equal(turnRequests,2,'Quiet waiting must not generate model requests');
  assert.equal(toolPending,false);
  assert.ok(JSON.stringify(continuation.input).includes('EXTRA_CLI_INPUT'));
  assert.ok(continuation.input.some(i=>i.type==='function_call_output'&&i.call_id==='call_wait'));
});
