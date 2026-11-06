import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,chmod,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {SshSession,quote} from '../../codex-monitor/runtime/ssh-session.js';
import {fileSample} from '../../codex-monitor/runtime/ssh-samples.js';
import {SshPool} from '../../codex-monitor/runtime/ssh-monitor.js';
import {normalizeMonitor} from '../../codex-monitor/runtime/validation.js';

for(const mode of ['direct','ProxyJump'])test(`Linux SSH client observes a runtime-free target using ${mode}`,{
  skip:!process.env.CODEX_MONITOR_SSH_LINUX_FIXTURE,timeout:30000,
},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'monitor-linux-ssh-'));
  const key=path.join(root,'key'),known=path.join(root,'known_hosts'),config=path.join(root,'config');
  await copyFile('/fixture/key',key);await chmod(key,0o600);await copyFile('/fixture/linux_known_hosts',known);
  const auth=` User monitor\n IdentityFile ${key}\n UserKnownHostsFile ${known}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n`;
  await writeFile(config,`Host fixture\n HostName ssh-target\n${mode==='ProxyJump'?' ProxyJump gateway\n':''}${auth} ForkAfterAuthentication yes\n StdinNull yes\n SessionType none\nHost gateway\n HostName ssh-jump\n${auth}`);
  const transport={type:'ssh',host:'fixture',config_file:config,connect_timeout_ms:5000,query_timeout_ms:2000,heartbeat_ms:1000,reconnect:{enabled:false,max_elapsed_ms:1000}};
  const setup=new SshSession(transport),events=[],pool=new SshPool((ids,e)=>events.push(e));
  t.after(async()=>{await pool.close();await setup.close();await rm(root,{recursive:true,force:true});});
  await setup.open();
  assert.equal(normalizeMonitor({name:'remote',transport:{type:'ssh',host:'fixture'},options:{cwd:'/work',watch_directory:'/work'},instructions:'Inspect'},'/work/local-state').options.watch_directory,'/work');
  assert.equal((await setup.request('! command -v node && ! command -v python3 && test ! -w "$HOME"')).code,0);
  const target='/work/with quote\' and\nUnicode 中文';
  assert.equal((await setup.request(`printf first > ${quote(target)}`)).code,0);
  assert.ok((await fileSample(setup,{watch_file:target})).entries.has(target));
  let resolve;const changed=new Promise(r=>resolve=r);
  const options={cwd:'/work',watch_file:target,timeout_ms:15000,poll_ms:1000,gpu_sample_ms:15000,max_events:0,dead_if:'all'};
  const first=pool.start('first','watchdog',options,transport,e=>{events.push(e);if(e.event_type==='file_change')resolve(e);},()=>{},()=>{});
  const second=pool.start('second','connection',{timeout_ms:15000},transport,e=>events.push(e),()=>{},()=>{});
  const [a,b]=await Promise.all([first.ready,second.ready]);assert.equal(a.connection_id,b.connection_id);
  await setup.request(`printf second >> ${quote(target)}`);
  assert.equal((await changed).change,'modified');
  await first.stop();assert.ok(!events.some(e=>e.event_type.startsWith('connection_')));
  await second.stop();assert.ok(!events.some(e=>e.event_type.startsWith('connection_')));
});
