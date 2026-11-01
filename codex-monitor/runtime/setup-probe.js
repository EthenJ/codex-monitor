import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// Fresh, isolated MCP connection. Never contacts a model, starts a workload or trusts hooks.
const root = await mkdtemp(path.join(tmpdir(), 'codex-monitor-setup-'));
const client = new Client({ name: 'codex-monitor-setup', version: '0.2.3' });
try {
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('./server.js', import.meta.url))],
        env: { ...process.env, CODEX_MONITOR_HOME: root },
        stderr: 'pipe',
    }));
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const name of [
        'monitor_start',
        'monitor_event',
        'monitor_display',
        'monitor_report',
        'monitor_status',
        'monitor_stop',
        'monitor_validate',
        'monitor_wait',
        'monitor_cancel_wait',
        'monitor_ack',
        'monitor_recovery',
    ])
        assert(names.includes(name), `Missing ${name}`);
    const thread_id = randomUUID();
    const display = await client.callTool({ name: 'monitor_display', arguments: { thread_id } });
    assert(!display.isError);
    assert.equal(display.structuredContent?.mode, 'compact');
    const report = await client.callTool({ name: 'monitor_report', arguments: { thread_id } });
    assert(!report.isError);
    assert.equal(report.structuredContent?.source, 'empty');
    const resources = await client.listResources();
    assert(resources.resources.some((x) => x.mimeType === 'text/html;profile=mcp-app'));
    console.log('Verified: 11 MCP tools, new display tool execution, isolated report and UI resource. Conversation activation and hook review remain pending.');
}
finally {
    await client.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('codex-monitor-setup-'))
        throw Error('Unexpected temporary directory');
    await rm(root, { recursive: true, force: true });
}
