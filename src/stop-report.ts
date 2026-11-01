import { pathToFileURL } from 'node:url';
import { compactReport, readReport } from './report.js';
import { Json, stateRoot, threadKey } from './common.js';

export async function stopReport(input: Json, root = stateRoot()) {
  if (!['Stop', 'Interrupt'].includes(input.hook_event_name)) throw Error('Expected Stop or Interrupt');
  const report = await readReport(threadKey(input.session_id), root, 700);
  // Informational output only: never block/continue a turn, submit an event,
  // enable recovery or create a service just to report that nothing is running.
  return { systemMessage: compactReport(report) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let buffer = '';
  const timer = setTimeout(() => { process.stdout.write(JSON.stringify({ systemMessage: 'Monitor · status unavailable' })); process.exit(0); }, 1500);
  try {
    for await (const chunk of process.stdin) {
      buffer += chunk; if (Buffer.byteLength(buffer) > 65536) throw Error('Hook input too large');
    }
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(await stopReport(JSON.parse(buffer))));
  } catch {
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ systemMessage: 'Monitor · status unavailable' }));
  }
}
