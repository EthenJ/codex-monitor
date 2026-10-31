// Simulate an MCP host that kills its entire Windows process job at disconnect.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ownCurrentProcess } from '../../../codex-monitor/runtime/windows.js';
const [server, thread, work] = process.argv.slice(2);
ownCurrentProcess();
const client = new Client({ name: 'strict-windows-job', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env }));
const result = await client.callTool({ name: 'monitor_start', arguments: { thread_id: thread, name: 'strict-job', kind: 'watchdog',
  options: { cwd: work, watch_file: 'metrics', timeout_ms: 15000 }, instructions: 'Fixture', notify_on: ['monitor_expired'] } });
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
