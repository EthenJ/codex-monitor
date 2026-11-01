import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Bridge, codexExecutable } from '../../codex-monitor/runtime/bridge.js';
import { capture } from '../../codex-monitor/runtime/processes.js';

test('native installed plugin resolves its MCP cwd and UI resources from a different workspace', {skip:!process.env.CODEX_MONITOR_TEST_NATIVE,timeout:25000}, async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-plugin-native-'));let bridge;
  try {
    const source=path.join(root,'plugin with spaces'),work=path.join(root,'different workspace');await mkdir(source);await mkdir(work);
    for(const file of ['.mcp.json','.codex-plugin/plugin.json','.agents/plugins/marketplace.json']){
      await mkdir(path.dirname(path.join(source,file)),{recursive:true});await cp(file,path.join(source,file));
    }
    await mkdir(path.join(source,'codex-monitor'));await cp('codex-monitor/SKILL.md',path.join(source,'codex-monitor/SKILL.md'));
    await cp('codex-monitor/runtime',path.join(source,'codex-monitor/runtime'),{recursive:true});
    await cp('node_modules',path.join(source,'node_modules'),{recursive:true});
    await writeFile(path.join(source,'package.json'),JSON.stringify({type:'module'}));
    const manifest=JSON.parse(await readFile(path.join(source,'.codex-plugin/plugin.json'),'utf8'));delete manifest.hooks;
    await writeFile(path.join(source,'.codex-plugin/plugin.json'),JSON.stringify(manifest));
    await writeFile(path.join(root,'config.toml'),'model="fixture"\nmodel_provider="fixture"\n[features]\nenable_mcp_apps=true\n[model_providers.fixture]\nname="Offline fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
    const env={...process.env,CODEX_HOME:root,CODEX_MONITOR_HOME:path.join(root,'state')};
    await capture(codexExecutable(),['plugin','marketplace','add',source],{env});
    await capture(codexExecutable(),['plugin','add','codex-monitor@codex-monitor'],{env});
    bridge=await Bridge.connect({args:['app-server','--stdio'],jsonl:true,env});
    const statuses=new Map();bridge.on('notification',(method,p)=>{if(method==='mcpServer/startupStatus/updated')statuses.set(p.name,p);});
    const thread=(await bridge.rpc('thread/start',{cwd:work,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
    let server=(await bridge.rpc('mcpServerStatus/list',{threadId:thread})).data.find(x=>x.pluginId==='codex-monitor@codex-monitor');assert.ok(server);
    if(!Object.keys(server.tools).length)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{bridge.off('notification',listener);reject(Error('MCP startup notification timed out'));},8000);
      const listener=(method,p)=>{if(method==='mcpServer/startupStatus/updated'&&p.name===server.name&&p.status!=='starting'){clearTimeout(timer);bridge.off('notification',listener);resolve();}};
      bridge.on('notification',listener);const last=statuses.get(server.name);if(last)listener('mcpServer/startupStatus/updated',last);
    });
    server=(await bridge.rpc('mcpServerStatus/list',{threadId:thread,serverName:server.name})).data.find(x=>x.pluginId==='codex-monitor@codex-monitor');
    assert.equal(server.runtimeStatus,'connected',JSON.stringify({error:server.toolsError,notification:statuses.get(server.name)}));
    assert.equal(Object.keys(server.tools).length,11);assert.ok(Object.values(server.tools).every(x=>x._meta.ui.resourceUri));
    const r=await bridge.rpc('mcpServer/tool/call',{threadId:thread,server:server.name,tool:'monitor_report',arguments:{thread_id:thread}});
    assert.equal(r.isError,undefined);assert.equal(r.structuredContent.source,'empty');
    const resource=await bridge.rpc('mcpServer/resource/read',{threadId:thread,server:server.name,uri:server.resources[0].uri});
    assert.match(JSON.stringify(resource),/text\/html;profile=mcp-app/);
  }finally{await bridge?.close();await rm(root,{recursive:true,force:true});}
});
