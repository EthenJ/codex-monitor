import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { existsSync, globSync } from 'node:fs';
import path from 'node:path';
import { owned, Owned } from './processes.js';
import { Json, VERSION } from './common.js';

export class RpcError extends Error {
  constructor(message: string, public uncertain = false, public code?: number) { super(message); }
}
export interface BridgeLike {
  rpc(method: string, params: Json): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): any;
  close(): Promise<void>;
}
export function codexExecutable() {
  if (process.env.CODEX_MONITOR_CODEX_BIN) return process.env.CODEX_MONITOR_CODEX_BIN;
  if (process.platform !== 'win32') return 'codex';
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const dir of paths) if (existsSync(path.join(dir, 'codex.exe'))) return path.join(dir, 'codex.exe');
  const roots = [process.env.CODEX_MANAGED_PACKAGE_ROOT, ...paths.map(dir => path.join(dir, 'node_modules', '@openai', 'codex'))].filter(Boolean) as string[];
  for (const root of roots) {
    const files = globSync('node_modules/@openai/codex-win32-*/vendor/*/bin/codex.exe', { cwd: root });
    if (files[0]) return path.join(root, files[0]);
  }
  return 'codex.exe';
}
export class Bridge extends EventEmitter implements BridgeLike {
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private wire?: WebSocket;
  private process?: Owned;
  private sendRaw?: (message: string) => void;
  private closed = false;
  private disposing?: Promise<void>;
  static async connect(options: Json = {}): Promise<Bridge> {
    const client = new Bridge();
    try {
      client.process = await owned(options.command || codexExecutable(),
        options.args || ['app-server', 'proxy'], { env: options.env || process.env });
      const child = client.process.process;
      child.stdin!.on('error', () => client.fail('Codex proxy input failed'));
      child.stdout!.on('error', () => client.fail('Codex proxy output failed'));
      child.stderr!.resume();
      void client.process.done.then(() => client.fail('Codex proxy disconnected'));
      if (options.jsonl) {
        createInterface({ input: child.stdout! }).on('line', line => client.receive(line));
        client.sendRaw = message => { child.stdin!.write(message + '\n'); };
      } else {
        const socket = Duplex.from({ readable: child.stdout!, writable: child.stdin! }) as any;
        socket.setTimeout = () => socket; socket.setNoDelay = () => socket; socket.setKeepAlive = () => socket;
        const ws = new WebSocket('ws://localhost/', { createConnection: () => socket, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 8000 });
        client.wire = ws;
        ws.on('message', data => client.receive(data.toString()));
        ws.on('error', () => client.fail('Codex proxy transport failed'));
        ws.on('close', () => client.fail('Codex proxy closed'));
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        client.sendRaw = message => { ws.send(message); };
      }
      await client.rpc('initialize', { clientInfo: { name: 'codex_monitor', version: VERSION }, capabilities: { experimentalApi: false } });
      client.sendRaw(JSON.stringify({ method: 'initialized' }));
      return client;
    } catch (e) { await client.close(); throw e; }
  }
  private receive(text: string) {
    if (this.closed) return;
    let message: Json;
    try { message = JSON.parse(text); } catch { this.fail('Invalid Codex JSON-RPC response'); return; }
    if (message.method && message.id !== undefined) {
      this.sendRaw?.(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Monitor cannot approve user actions' } }));
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new RpcError(JSON.stringify(message.error), false, message.error.code));
      else request.resolve(message.result);
    } else if (message.method) this.emit('notification', message.method, message.params || {});
  }
  private fail(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new RpcError(reason, true)); }
    this.pending.clear();
    void this.dispose();
    this.emit('disconnected', reason);
  }
  private dispose() {
    if (!this.disposing) this.disposing = (async () => { this.wire?.terminate(); await this.process?.stop(); })();
    return this.disposing;
  }
  rpc(method: string, params: Json): Promise<any> {
    if (this.closed || !this.sendRaw) return Promise.reject(new RpcError('Codex connection unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`${method} timed out; outcome unknown`, true)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.sendRaw!(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new RpcError(String(e), true)); }
    });
  }
  async close() { this.fail('Connection closed'); await this.dispose(); }
}
export async function loaded(bridge: BridgeLike, threadId: string) {
  const result = await bridge.rpc('thread/loaded/list', {});
  if (!result.data?.includes(threadId)) throw new RpcError('Thread is not loaded in this daemon; reopen it before using monitor continuation');
}
export async function getGoal(bridge: BridgeLike, threadId: string) {
  return (await bridge.rpc('thread/goal/get', { threadId })).goal as Json | null;
}
export function sameGoal(expected: Json | null, actual: Json | null) {
  if (!expected || !actual) return expected === actual;
  for (const key of ['threadId', 'createdAt', 'objective', 'tokenBudget', 'status']) if (expected[key] !== actual[key]) return false;
  if (actual.tokenBudget != null && actual.tokensUsed >= actual.tokenBudget) return false;
  const keys = ['tokensUsed', 'timeUsedSeconds'];
  return keys.every(k => (actual[k] || 0) >= (expected[k] || 0)) &&
    (actual.updatedAt === expected.updatedAt || keys.some(k => actual[k] > expected[k]));
}
export async function latestTurn(bridge: BridgeLike, threadId: string) {
  try {
    const result = await bridge.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
    return result.data?.[0] as Json | undefined;
  } catch (e) {
    if (e instanceof RpcError && e.code === -32600 && e.message.includes('not materialized yet')) return undefined;
    throw e;
  }
}
export async function submit(bridge: BridgeLike, threadId: string, payload: Json, rootTurnId?: string) {
  await loaded(bridge, threadId);
  return bridge.rpc('turn/start', { threadId, input: [], ...(rootTurnId ? { rootTurnId } : {}),
    toolOutput: { name: 'monitor_event', namespace: 'codex_monitor', output: JSON.stringify(payload), retain: true } });
}
