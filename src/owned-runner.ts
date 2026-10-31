import { spawn, ChildProcess } from 'node:child_process';
import { ownCurrentProcess } from './windows.js';
let child: ChildProcess | undefined;
let closeJob: (() => void) | undefined;
let finished = false;
function cleanup() {
  if (finished) return;
  finished = true;
  if (process.platform === 'win32') closeJob?.();
  else if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  process.exit(0);
}
process.on('disconnect', cleanup);
process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
process.once('message', (config: any) => {
  try {
    if (process.platform === 'win32') closeJob = ownCurrentProcess();
    child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env || process.env,
      shell: config.shell || false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdin.pipe(child.stdin!);
    child.stdout!.pipe(process.stdout, { end: false }); child.stderr!.pipe(process.stderr, { end: false });
    child.on('spawn', () => process.send?.({ type: 'ready', pid: child!.pid }));
    child.on('error', e => { process.send?.({ type: 'error', error: e.message }, cleanup); });
    // Kill descendants as soon as the leader exits, including descendants holding stdout open.
    child.on('exit', (code, signal) => {
      if (process.platform !== 'win32' && child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      process.send?.({ type: 'exit', code, signal }, () => setTimeout(cleanup, 20));
    });
  } catch (e) { process.send?.({ type: 'error', error: String(e) }, cleanup); }
});
