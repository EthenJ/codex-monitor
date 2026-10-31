import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bounded } from './common.js';
export async function owned(command, args = [], options = {}) {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./owned-runner.js', import.meta.url))], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    let resolveExit;
    const done = new Promise(resolve => { resolveExit = resolve; });
    let result;
    let exitFallback;
    process.on('message', (message) => { if (message.type === 'exit')
        result = message; });
    process.on('exit', (code, signal) => {
        // Windows job termination can close the process without a ChildProcess close
        // event for its IPC pipe. Drain data, then release all parent pipe handles.
        exitFallback = setTimeout(() => {
            process.stdout?.destroy();
            process.stderr?.destroy();
            process.stdin?.destroy();
            resolveExit(result || { code, signal });
        }, 100);
    });
    process.on('close', (code, signal) => { clearTimeout(exitFallback); resolveExit(result || { code, signal }); });
    const stop = async () => {
        process.stdout?.resume();
        process.stderr?.resume();
        process.stdin?.destroy();
        if (process.connected)
            process.disconnect();
        const timeout = setTimeout(() => process.kill('SIGKILL'), 3000);
        await done;
        clearTimeout(timeout);
    };
    try {
        const pid = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('Owned command startup timed out')), 10000);
            process.on('error', reject);
            process.on('close', () => { clearTimeout(timeout); reject(Error('Owned process exited before readiness')); });
            process.on('message', (m) => { if (m.type === 'ready') {
                clearTimeout(timeout);
                resolve(m.pid);
            }
            else if (m.type === 'error') {
                clearTimeout(timeout);
                reject(Error(m.error));
            } });
            process.send({ command, args, ...options });
        });
        return { process, pid, done, stop };
    }
    catch (e) {
        await stop();
        throw e;
    }
}
export async function capture(command, args, options = {}, timeoutMs = 10000, signal) {
    if (signal?.aborted)
        throw Error('Subprocess cancelled');
    const p = await owned(command, args, options);
    const abort = () => { void p.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        abort();
    let output = '', overflow = false, expired = false;
    const consume = (chunk) => { output += chunk; if (output.length > 65536) {
        output = output.slice(-65536);
        overflow = true;
    } };
    p.process.stdout.setEncoding('utf8').on('data', consume);
    p.process.stderr.setEncoding('utf8').on('data', consume);
    p.process.stdin.end();
    const timer = setTimeout(() => { expired = true; void p.stop(); }, timeoutMs);
    try {
        const result = await p.done;
        if (signal?.aborted || expired || overflow || result.code !== 0)
            throw Error(signal?.aborted ? 'Subprocess cancelled' : expired ? 'Subprocess timed out' : overflow ? 'Subprocess output exceeded limit' : bounded(output));
        return output;
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        await p.stop();
    }
}
