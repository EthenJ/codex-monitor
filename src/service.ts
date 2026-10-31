import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, bounded, delay, Json, now, readJson, stateRoot, threadKey, VERSION } from './common.js';
import { launchWindowsDetached } from './windows.js';
import { Manager } from './manager.js';

export async function rpc(directory: string, method: string, params: Json = {}, timeout = 20000): Promise<any> {
  const endpoint = readJson(path.join(directory, 'endpoint.json'));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, { method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(timeout) });
  const result = await response.json() as Json;
  if (!response.ok || result.error) throw Error(result.error || 'Local monitor request failed');
  return result.result;
}
async function lock(directory: string, operation: () => Promise<void>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const location = path.join(directory, 'startup.lock-node');
  const deadline = now() + 12000;
  while (true) {
    try { await mkdir(location); atomicJson(path.join(location, 'owner.json'), { pid: process.pid }); break; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const owner = JSON.parse(await readFile(path.join(location, 'owner.json'), 'utf8'));
        try { process.kill(owner.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') { await rm(location, { recursive: true, force: true }); continue; } }
      } catch { if (now() - (await stat(location)).mtimeMs > 30000) throw Error('Stale startup lock without verifiable owner; inspect state'); }
      if (now() >= deadline) throw Error('Monitor startup lock busy');
      await delay(50);
    }
  }
  try { await operation(); } finally { await rm(location, { recursive: true, force: true }); }
}
async function launch(directory: string, threadId?: string, breakaway = true) {
  const args = [fileURLToPath(new URL('./cli.js', import.meta.url)), threadId ? 'serve' : 'broker', directory, ...(threadId ? [threadId] : [])];
  let pid: number | undefined;
  if (process.platform === 'win32') pid = launchWindowsDetached(process.execPath, args, process.cwd(), breakaway);
  else {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    pid = child.pid; child.unref();
  }
  const deadline = now() + 10000;
  while (now() < deadline) {
    try { const result = await rpc(directory, 'status', {}, 1000); if (result.service_pid === pid) return; } catch {}
    await delay(50);
  }
  throw Error('Detached service did not become ready; run bootstrap from an external terminal and inspect service-error.json');
}
async function reachable(directory: string) {
  if (!existsSync(path.join(directory, 'endpoint.json'))) return false;
  try { await rpc(directory, 'status', {}, 1000); return true; } catch { return false; }
}
export async function ensureBroker(root = stateRoot()) {
  const directory = path.join(root, 'broker');
  await lock(directory, async () => { if (!await reachable(directory)) await launch(directory); });
  return directory;
}
export async function ensureService(threadId: string, root = stateRoot(), useBroker = true): Promise<string> {
  const directory = path.join(root, threadKey(threadId));
  if (await reachable(directory)) return directory;
  if (useBroker && await reachable(path.join(root, 'broker'))) {
    try { await rpc(path.join(root, 'broker'), 'launch', { thread_id: threadId }); }
    catch (e) { throw Error(`External launcher could not start observer: ${bounded(e)}`); }
    return directory;
  }
  // Only the external broker calls this with useBroker=false. Its children are
  // already independent of the MCP host; a second job breakaway is unnecessary
  // and can be denied by an enclosing Windows runner/job policy.
  await lock(directory, async () => { if (!await reachable(directory)) await launch(directory, threadId, useBroker); });
  return directory;
}
export async function serve(directory: string, threadId?: string) {
  const manager = threadId ? new Manager(directory, threadKey(threadId)) : undefined;
  const token = randomBytes(32).toString('hex');
  let closing = false, requests = 0;
  const close = async () => {
    if (closing) return; closing = true; clearInterval(idle);
    server.close(); await manager?.close();
    await rm(path.join(directory, 'endpoint.json'), { force: true });
  };
  const server = createServer(async (request, response) => {
    requests++;
    try {
      const auth = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
      if (request.method !== 'POST' || request.url !== '/rpc' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        response.writeHead(403).end(); return;
      }
      if (closing) throw Error('Service shutting down');
      let body = '';
      for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 65536) throw Error('Request too large'); }
      const { method, params = {} } = JSON.parse(body);
      let result;
      if (!manager) {
        if (method === 'status') result = { version: VERSION, state: 'ready', service_pid: process.pid };
        else if (method === 'launch') result = { directory: await ensureService(params.thread_id, path.dirname(directory), false) };
        else if (method === 'shutdown') { result = { state: 'shutting_down', observers: 'Existing observers remain independent' }; setImmediate(() => void close()); }
        else throw Error('Unknown broker method');
      } else {
        manager.lastUsed = now();
        switch (method) {
          case 'status': result = manager.snapshot(params.monitor_id); break;
          case 'start': result = await manager.start(params); break;
          case 'stop': result = await manager.stop(params.monitor_id); break;
          case 'wait': result = await manager.beginWait(params); break;
          case 'cancel_wait': result = await manager.cancelWait(); break;
          case 'ack': result = await manager.acknowledge(params); break;
          case 'recovery': result = await manager.configureRecovery(params); break;
          case 'shutdown': if (!manager.isIdle()) throw Error('Stop monitors, cancel waits, disable recovery before shutdown'); result = { state: 'shutting_down' }; setImmediate(() => void close()); break;
          default: throw Error('Unknown monitor method');
        }
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ result }));
    } catch (e) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: bounded(e) })); }
    finally { requests--; }
  });
  server.requestTimeout = 60000; server.headersTimeout = 5000;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  atomicJson(path.join(directory, 'endpoint.json'), { port: address.port, token, pid: process.pid });
  const idle = setInterval(() => { if (manager && !requests && manager.isIdle() && now() - manager.lastUsed > 60000) void close(); }, 2000);
  process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
}
