import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withStartupLock } from '../../codex-monitor/runtime/service.js';

test('startup lock released between contention and metadata inspection is retried', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'monitor-lock-'));
  const lock = path.join(root, 'startup.lock-node');
  await fs.mkdir(lock);
  const original = fs.stat;
  let raced = false, operations = 0;
  t.mock.method(fs, 'stat', async (file, ...args) => {
    if (file === lock && !raced) { raced = true; await fs.rm(lock, { recursive: true }); }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await withStartupLock(root, async () => { operations++; });
    assert.equal(raced, true);
    assert.equal(operations, 1);
    await assert.rejects(original(lock), { code: 'ENOENT' });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const persistent of [false, true]) test(`Windows pending lock deletion retries without bypassing persistent permissions (${persistent})`, {skip:process.platform!=='win32'}, async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'monitor-lock-delete-')),lock=path.join(root,'startup.lock-node');
  const mkdir=fs.mkdir;let attempts=0,operations=0;
  t.mock.timers.enable({apis:['Date'],now:1800000000000});
  t.mock.method(fs,'mkdir',async(file,...args)=>{
    if(file===lock && (++attempts===1 || persistent)){
      if(persistent&&attempts>1)t.mock.timers.setTime(1800000012000);
      throw Object.assign(Error('Fixture directory pending deletion'),{code:'EPERM'});
    }
    return mkdir(file,...args);
  });syncBuiltinESMExports();
  try{
    const result=withStartupLock(root,async()=>{operations++;});
    if(persistent)await assert.rejects(result,{code:'EPERM'});else await result;
    assert.equal(attempts,2);assert.equal(operations,persistent?0:1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
});
