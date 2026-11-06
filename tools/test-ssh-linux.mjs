import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const exec=promisify(execFile),docker=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'):'docker';
const run=async(cmd,args,timeout=30000)=>exec(cmd,args,{windowsHide:true,timeout,maxBuffer:4*1024*1024,env:{...process.env,PATH:path.dirname(docker)+path.delimiter+process.env.PATH}});
const d=(...args)=>run(docker,args);
const root=await mkdtemp(path.join(tmpdir(),'codex-ssh-linux-')),id=randomUUID().slice(0,8),network='codex-ssh-'+id,server='codex-sshd-'+id,jump='codex-ssh-jump-'+id,client='codex-ssh-client-'+id;
let networkCreated=false,serverCreated=false,jumpCreated=false;
try{
  for(const [file,image]of [['Dockerfile.ssh','codex-monitor-ssh-test'],['Dockerfile.ssh-client','codex-monitor-ssh-client-test']]){
    const r=await run(docker,['build','-f','tests/container/'+file,'-t',image,'.'],600000);process.stdout.write(r.stdout+r.stderr);
  }
  const key=path.join(root,'key');await run(process.platform==='win32'?'ssh-keygen.exe':'ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);await copyFile(key+'.pub',path.join(root,'authorized_keys'));
  await d('network','create','--internal',network);networkCreated=true;
  await d('run','-d','--name',server,'--network',network,'--network-alias','ssh-target','--mount',`type=bind,source=${root},target=/fixture,readonly`,'codex-monitor-ssh-test');serverCreated=true;
  await d('run','-d','--name',jump,'--network',network,'--network-alias','ssh-jump','--mount',`type=bind,source=${root},target=/fixture,readonly`,'codex-monitor-ssh-test');jumpCreated=true;
  const pub=(await d('exec',server,'cat','/etc/ssh/ssh_host_ed25519_key.pub')).stdout.trim().split(/\s+/).slice(0,2).join(' ');
  const jumpPub=(await d('exec',jump,'cat','/etc/ssh/ssh_host_ed25519_key.pub')).stdout.trim().split(/\s+/).slice(0,2).join(' ');
  await writeFile(path.join(root,'linux_known_hosts'),'ssh-target '+pub+'\nssh-jump '+jumpPub+'\n');
  const r=await run(docker,['run','--rm','--init','--name',client,'--network',network,'--mount',`type=bind,source=${root},target=/fixture,readonly`,'-e','CODEX_MONITOR_SSH_LINUX_FIXTURE=1','codex-monitor-ssh-client-test'],90000);
  process.stdout.write(r.stdout+r.stderr);
  const jumps=await d('logs',jump);
  if(!jumps.stderr.includes('Accepted publickey'))throw Error('ProxyJump did not authenticate through the jump fixture');
}catch(e){console.error(e.stdout||'',e.stderr||'',String(e));process.exitCode=1;}
finally{
  await d('rm','-f',client).catch(()=>{});
  if(serverCreated)await d('rm','-f',server).catch(()=>{});
  if(jumpCreated)await d('rm','-f',jump).catch(()=>{});
  if(networkCreated)await d('network','rm',network).catch(()=>{});
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
