import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const VERSION = '0.2.0';
export const id = () => randomUUID();
export const now = () => Date.now();
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export function threadKey(value) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
        throw Error('An exact caller thread UUID is required');
    return value.toLowerCase();
}
export const stateRoot = () => path.resolve(process.env.CODEX_MONITOR_HOME || path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'monitor-node'));
export function atomicJson(file, data) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    // Antivirus/indexers can briefly open the destination without delete sharing
    // on Windows. Preserve the atomic replacement and retry only that operation.
    for (let attempt = 0;; attempt++) {
        try {
            renameSync(temp, file);
            return;
        }
        catch (e) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 4)
                throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
        }
    }
}
export function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function bounded(text, size = 2000) { return String(text).slice(0, size); }
export function within(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
}
export function text(value, name, max = 2000) {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw Error(`${name} must contain 1-${max} characters`);
    return value;
}
export function serial() {
    let tail = Promise.resolve();
    return (operation) => {
        const next = tail.then(operation);
        tail = next.then(() => { }, () => { });
        return next;
    };
}
