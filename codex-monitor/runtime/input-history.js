import { watchFile, unwatchFile } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { threadKey } from './common.js';
// CLI input history is an early wake hint, not an authorization or message bus.
// Only inspect newly appended records, and never return their text to the model.
export async function watchInputHistory(file, threadId, wake, interval = 250) {
    const thread = threadKey(threadId), baseline = await stat(file);
    if (!baseline.isFile())
        throw Error('CLI input history is not a regular file');
    let offset = baseline.size, carry = '', closed = false, reading = false, again = false;
    let continuation;
    const decoder = new StringDecoder('utf8');
    let skipLine = false;
    if (offset) {
        const handle = await open(file, 'r');
        try {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, offset - 1);
            skipLine = last[0] !== 10;
        }
        finally {
            await handle.close();
        }
    }
    const close = () => { closed = true; unwatchFile(file, check); clearImmediate(continuation); carry = ''; };
    const finish = (reason) => { if (!closed) {
        close();
        wake(reason);
    } };
    const check = async () => {
        if (closed)
            return;
        if (reading) {
            again = true;
            return;
        }
        reading = true;
        try {
            do {
                again = false;
                const handle = await open(file, 'r');
                try {
                    const current = await handle.stat();
                    if (current.ino !== baseline.ino || current.dev !== baseline.dev || current.size < offset)
                        throw Error('CLI input history was replaced or truncated');
                    // Bound catch-up work per tick. A shared history may contain a large
                    // prompt from another thread; do not repeatedly read the entire file.
                    const end = Math.min(current.size, offset + 1024 * 1024);
                    while (!closed && offset < end) {
                        const buffer = Buffer.alloc(Math.min(65536, end - offset));
                        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                        if (!bytesRead)
                            throw Error('CLI input history changed during reading');
                        offset += bytesRead;
                        carry += decoder.write(buffer.subarray(0, bytesRead));
                        let newline;
                        while (!closed && (newline = carry.indexOf('\n')) >= 0) {
                            const line = carry.slice(0, newline);
                            carry = carry.slice(newline + 1);
                            if (skipLine) {
                                skipLine = false;
                                continue;
                            }
                            try {
                                const entry = JSON.parse(line);
                                if (typeof entry.session_id === 'string' &&
                                    entry.session_id.toLowerCase() === thread && typeof entry.text === 'string' && entry.text.trim())
                                    finish('user_input');
                            }
                            catch { /* An incomplete or malformed record grants no wake authority. */ }
                        }
                        if (carry.length > 1024 * 1024)
                            throw Error('CLI input history record exceeds the bounded reader');
                    }
                    // watchFile reports metadata changes, not a callback on every tick.
                    // Drain a bounded backlog even if no subsequent write occurs.
                    if (!closed && offset < current.size && !continuation)
                        continuation = setImmediate(() => {
                            continuation = undefined;
                            void check();
                        });
                }
                finally {
                    await handle.close();
                }
            } while (again && !closed);
        }
        catch {
            finish('input_unavailable');
        }
        finally {
            reading = false;
        }
    };
    watchFile(file, { interval, persistent: false }, check);
    // Close the stat-to-subscription race without scanning old messages.
    void check();
    return { close };
}
