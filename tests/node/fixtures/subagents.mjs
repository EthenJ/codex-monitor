import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Manager} from '../../../codex-monitor/runtime/manager.js';
import {Routing} from '../../../codex-monitor/runtime/ancestry.js';
export async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'monitor-subagents-')),history=path.join(root,'history.jsonl');await writeFile(history,'');
 const parent=randomUUID(),a=randomUUID(),b=randomUUID(),grand=randomUUID(),other=randomUUID();
 const meta=new Map([[parent,null],[a,parent],[b,parent],[grand,a],[other,null]]);
 const host=new EventEmitter();host.submissions=[];host.reads=[];host.goal=null;host.goals=new Map();
 host.rpc=async(method,p)=>{
  host.reads.push({method,...p});
  if(method==='thread/read'){if(!meta.has(p.threadId))throw Error('Missing thread');return {thread:{id:p.threadId,parentThreadId:meta.get(p.threadId),source:meta.get(p.threadId)?{subAgent:{thread_spawn:{parent_thread_id:meta.get(p.threadId)}}}:'cli',agentNickname:p.threadId===a?'Alice':null}};}
  if(method==='thread/loaded/list')return {data:[...meta.keys()]};
  if(method==='thread/resume'){
   const goal=p.threadId===parent?host.goal:host.goals.get(p.threadId)??null;
   host.emit('notification',goal?'thread/goal/updated':'thread/goal/cleared',
    goal?{threadId:p.threadId,turnId:null,goal}:{threadId:p.threadId});
   return {thread:{id:p.threadId}};
  }
  if(method==='config/read')return {config:{history:{persistence:'save-all'}}};
  if(method==='thread/goal/get')return {goal:p.threadId===parent?host.goal:host.goals.get(p.threadId)??null};
  if(method==='thread/turns/list')return {data:[{id:`turn-${p.threadId}`,status:'inProgress'}]};
  if(method==='turn/start'){host.submissions.push(p);return {turn:{id:randomUUID()}};}
  throw Error(method);
 };host.close=async()=>{};
 const directory=path.join(root,parent),m=new Manager(directory,parent,{connect:async()=>host,historyFile:history});
 const routing=new Routing(root,async()=>host);
 t.after(async()=>{await m.close();await routing.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
 const start=(caller=parent,name='work')=>m.start({name,instructions:'Inspect result before continuing',options:{cwd:root,watch_file:name,timeout_ms:20000}},undefined,caller);
 const poll=(caller=a,params={},signal)=>m.delegation.poll(caller,{timeout_ms:5000,input_poll_ms:50,...params},signal);
 const armed=async caller=>{const deadline=Date.now()+5000;while((caller===parent?m.wait:m.delegation.waits[caller])?.state!=='waiting'){if(Date.now()>deadline)throw Error('Wait did not arm: '+JSON.stringify(m.snapshot().delegated_waits));await m.changes.wait(m.changes.revision,100);}};
 const emit=monitor=>m.event(monitor.id,{event_type:'file_change',path:randomUUID()});
 return {root,history,parent,a,b,grand,other,meta,host,m,start,poll,armed,emit,routing};
}
