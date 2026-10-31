// Native handles preserve process identity; only owned guardians enter kill-on-close jobs.
import koffi from 'koffi';
import { Json } from './common.js';
let api: any;
function kernel() {
  if (api) return api;
  const k = koffi.load('kernel32.dll');
  const basic = koffi.struct('MonitorBasicLimits', { processTime: 'int64', jobTime: 'int64', flags: 'uint32', min: 'size_t', max: 'size_t', active: 'uint32', affinity: 'size_t', priority: 'uint32', scheduling: 'uint32' });
  const limits = koffi.struct('MonitorExtendedLimits', { basic, io: koffi.array('uint64', 6), processMemory: 'size_t', jobMemory: 'size_t', peakProcess: 'size_t', peakJob: 'size_t' });
  const startup = koffi.struct('MonitorStartup', { cb: 'uint32', reserved: 'void *', desktop: 'void *', title: 'void *', x: 'uint32', y: 'uint32', xs: 'uint32', ys: 'uint32', xc: 'uint32', yc: 'uint32', fill: 'uint32', flags: 'uint32', show: 'uint16', reserved2: 'uint16', reservedPtr: 'void *', stdin: 'void *', stdout: 'void *', stderr: 'void *' });
  const pi = koffi.struct('MonitorProcessInfo', { process: 'void *', thread: 'void *', pid: 'uint32', tid: 'uint32' });
  api = { limits, startup,
    error: k.func('uint32 __stdcall GetLastError()'),
    close: k.func('int __stdcall CloseHandle(void *)'),
    open: k.func('void * __stdcall OpenProcess(uint32, int, uint32)'),
    wait: k.func('uint32 __stdcall WaitForSingleObject(void *, uint32)'),
    exitCode: k.func('int __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)'),
    createJob: k.func('void * __stdcall CreateJobObjectW(void *, const char16_t *)'),
    setJob: k.func('int __stdcall SetInformationJobObject(void *, int, MonitorExtendedLimits *, uint32)'),
    assign: k.func('int __stdcall AssignProcessToJobObject(void *, void *)'),
    create: k.func('int __stdcall CreateProcessW(const char16_t *, void *, void *, void *, int, uint32, void *, const char16_t *, MonitorStartup *, _Out_ MonitorProcessInfo *)') };
  return api;
}
export function ownCurrentProcess(): () => void {
  const k = kernel(), job = k.createJob(null, null);
  if (!job) throw Error(`CreateJobObject: ${k.error()}`);
  const limits: Json = { basic: { flags: 0x2000 } };
  if (!k.setJob(job, 9, limits, koffi.sizeof(k.limits))) { k.close(job); throw Error(`SetInformationJobObject: ${k.error()}`); }
  const self = k.open(0x100 | 0x1, 0, process.pid);
  if (!self || !k.assign(job, self)) { if (self) k.close(self); k.close(job); throw Error(`AssignProcessToJobObject: ${k.error()}`); }
  k.close(self);
  return () => k.close(job);
}
export function observeWindowsPid(pid: number, onExit: (code: number) => void, onError: (e: Error) => void): () => void {
  const k = kernel(), handle = k.open(0x100000 | 0x1000, 0, pid);
  if (!handle) throw Error(`Cannot observe PID ${pid}: Win32 ${k.error()}`);
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; clearInterval(timer); k.close(handle); } };
  const timer = setInterval(() => {
    const result = k.wait(handle, 0);
    if (result === 0) { const value = [0]; const ok = k.exitCode(handle, value); stop(); if (ok) onExit(value[0]); else onError(Error('GetExitCodeProcess failed')); }
    else if (result !== 258) { stop(); onError(Error(`PID wait failed: ${result}`)); }
  }, 250);
  return stop;
}
function quote(arg: string) { return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
export function launchWindowsDetached(executable: string, args: string[], cwd: string, breakaway = true): number {
  const k = kernel(), output: Json = {};
  const line = Buffer.from([executable, ...args].map(quote).join(' ') + '\0', 'utf16le');
  if (!k.create(executable, line, null, null, 0, (breakaway ? 0x01000000 : 0) | 0x08000000 | 0x200, null, cwd, { cb: koffi.sizeof(k.startup) }, output)) {
    throw Error(`Detached startup denied (Win32 ${k.error()}). Run npm run bootstrap in an external terminal outside the MCP host job.`);
  }
  k.close(output.thread); k.close(output.process);
  return output.pid;
}
