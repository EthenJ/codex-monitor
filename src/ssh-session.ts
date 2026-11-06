import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { owned, Owned } from './processes.js';
import { bounded, Json } from './common.js';

export const quote = (value: string) => {
  if (value.includes('\0')) throw Error('NUL is not a shell argument');
  return "'" + value.replaceAll("'", "'\\''") + "'";
};
export class SshFailure extends Error {
  constructor(message: string, public reason = 'connection_lost') { super(message); }
}
// Includes finite spawn/connect and baseline work. Shared-session queuing must
// not leave a new registration alive after its caller RPC has timed out.
export const sshReadinessMs = (t: Json) => (t.connect_timeout_ms ?? 10000) + (t.query_timeout_ms ?? 5000) * 6 + 10000;
export function sshArgs(t: Json) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:\-]*$/.test(t.host)) throw Error('SSH host must be a hostname, IP or config alias, not shell syntax');
  if (t.user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/.test(t.user)) throw Error('Invalid SSH user');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectionAttempts=1',
    '-o', `ConnectTimeout=${Math.ceil(t.connect_timeout_ms / 1000)}`, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
    '-o', 'ForkAfterAuthentication=no', '-o', 'StdinNull=no', '-o', 'SessionType=default',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no'];
  for (const [field, flag] of [['config_file', '-F'], ['identity_file', '-i']]) if (t[field]) {
    if (!path.isAbsolute(t[field]) || /[\r\n\0]/.test(t[field])) throw Error(`${field} must be an absolute local path`);
    args.push(flag, t[field]);
  }
  if (t.user) args.push('-l', t.user);
  if (t.port) args.push('-p', String(t.port));
  return [...args, '--', t.host, 'exec sh -s'];
}

// Exactly one request per owned SSH shell. Only fixed templates are accepted by
// callers; task values must be quoted. Encoded response bytes cannot forge frames.
export class SshSession extends EventEmitter {
  private child?: Owned;
  private starting?: Promise<Owned>;
  private stopped = false;
  private pending?: { prefix: string; resolve: (value: { code: number; data: Buffer }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private output = '';
  private oversized = false;
  private diagnostics = '';
  readonly generation = randomUUID();
  lastResponseAt = 0;
  constructor(readonly transport: Json) { super(); }
  async open() {
    this.starting = owned(process.platform === 'win32' ? 'ssh.exe' : 'ssh', sshArgs(this.transport));
    const child = await this.starting;
    this.child = child;
    if (this.stopped) { await child.stop(); throw new SshFailure('SSH connection cancelled'); }
    child.process.stdout!.setEncoding('ascii').on('data', chunk => this.consume(chunk));
    child.process.stderr!.setEncoding('utf8').on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-2048); });
    child.process.stdin!.on('error', e => this.fail(new SshFailure(bounded(e))));
    void child.done.then(result => { if (!this.stopped) this.fail(new SshFailure(`SSH exited (${result.code}): ${bounded(this.diagnostics)}`,
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Permission denied \(|no such identity:/i.test(this.diagnostics) ? 'authentication_error' : 'connection_lost')); });
    const nonce = randomUUID();
    // Fixed encoded zero status; no external framing utilities needed yet.
    await this.exchange(nonce, `printf '${nonce}:AENNX1JDOjA=\\n'\n`, this.transport.connect_timeout_ms + 2000);
    const check = await this.request('test "$(uname -s)" = Linux && command -v timeout >/dev/null && command -v base64 >/dev/null && printf ok');
    if (check.code !== 0 || check.data.toString() !== 'ok') { await this.close(); throw Error('Remote Linux, sh, GNU-compatible timeout and base64 are required'); }
  }
  request(script: string): Promise<{ code: number; data: Buffer }> {
    const nonce = randomUUID(), seconds = this.transport.query_timeout_ms / 1000;
    // Wrap in timeout remotely too: terminating local ssh alone does not prove
    // a remote child exited. The inner command never reads control stdin.
    const command = `printf '${nonce}:'; { timeout -k 1 ${seconds} sh -c ${quote(script)} </dev/null 2>/dev/null; cm_rc=$?; printf '\\000CM_RC:%s' "$cm_rc"; } | base64 -w 0; printf '\\n'\n`;
    return this.exchange(nonce, command, this.transport.query_timeout_ms + 2500);
  }
  private exchange(nonce: string, command: string, timeout: number) {
    if (this.stopped || !this.child) return Promise.reject(new SshFailure('SSH session closed'));
    if (this.pending) return Promise.reject(Error('Concurrent SSH request rejected'));
    return new Promise<{ code: number; data: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new SshFailure('SSH response deadline exceeded', 'connection_unresponsive')), timeout);
      this.pending = { prefix: nonce + ':', timer, reject, resolve };
      this.child!.process.stdin!.write(command);
    });
  }
  private consume(chunk: string) {
    if (this.stopped) return;
    while (chunk.length) {
      const newline = chunk.indexOf('\n'), part = newline < 0 ? chunk : chunk.slice(0, newline);
      chunk = newline < 0 ? '' : chunk.slice(newline + 1);
      const p = this.pending;
      if (!this.oversized) {
        this.output += part;
        if (!p || !p.prefix.startsWith(this.output) && !this.output.startsWith(p.prefix)) { this.fail(new SshFailure('Unexpected SSH stdout; check shell startup banners', 'protocol_error')); return; }
        if (this.output.length > 512 * 1024) { this.oversized = true; this.output = ''; }
      }
      if (newline < 0) return;
      const line = this.output; this.output = '';
      if (this.oversized && p) {
        // Drain only this bounded request. A broad directory must not kill
        // unrelated subscriptions sharing a healthy SSH connection.
        this.oversized = false; clearTimeout(p.timer); this.pending = undefined;
        p.reject(Error('SSH sample exceeds 512 KiB response limit; narrow the observed source'));
        continue;
      }
      if (!p || !line.startsWith(p.prefix)) { this.fail(new SshFailure('Unexpected SSH stdout; check shell startup banners', 'protocol_error')); return; }
      const encoded = line.slice(p.prefix.length);
      if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) { this.fail(new SshFailure('Invalid SSH response encoding', 'protocol_error')); return; }
      const data = Buffer.from(encoded, 'base64'), marker = Buffer.from('\0CM_RC:');
      const pos = data.lastIndexOf(marker), status = data.subarray(pos + marker.length).toString();
      if (pos < 0 || !/^\d{1,3}$/.test(status) || Number(status) > 255) { this.fail(new SshFailure('Missing SSH request completion status', 'protocol_error')); return; }
      clearTimeout(p.timer); this.pending = undefined;
      this.lastResponseAt = performance.now();
      p.resolve({ code: Number(status), data: data.subarray(0, pos) });
    }
  }
  private fail(error: SshFailure) {
    if (this.stopped) return;
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.stopped = true; void this.child?.stop(); this.emit('lost', error);
  }
  async close() {
    this.stopped = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new SshFailure('SSH request cancelled')); this.pending = undefined; }
    // Cancellation can arrive before owned() has returned its child handle.
    const child = this.child ?? await this.starting?.catch(() => undefined);
    await child?.stop();
  }
}
