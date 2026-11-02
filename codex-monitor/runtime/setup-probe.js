import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERSION } from './common.js';
// Fresh, isolated MCP connection. Never contacts a model, starts a workload or trusts hooks.
const root = await mkdtemp(path.join(tmpdir(), 'codex-monitor-setup-'));
const client = new Client({ name: 'codex-monitor-setup', version: VERSION });
try {
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('./server.js', import.meta.url))],
        env: { ...process.env, CODEX_MONITOR_HOME: root },
        stderr: 'pipe',
    }));
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.equal(names.length, 8, 'Unexpected public MCP tool count');
    for (const name of [
        'start',
        'event',
        'display',
        'status',
        'stop',
        'validate',
        'poll',
        'recovery',
    ])
        assert(names.includes(name), `Missing ${name}`);
    const thread_id = randomUUID();
    const display = await client.callTool({ name: 'display', arguments: { thread_id } });
    assert(!display.isError);
    assert.equal(display.structuredContent?.mode, 'compact');
    const report = await client.callTool({ name: 'status', arguments: { thread_id } });
    assert(!report.isError);
    assert.equal(report.structuredContent?.source, 'empty');
    const resources = await client.listResources();
    assert(resources.resources.some((x) => x.mimeType === 'text/html;profile=mcp-app'));
    console.log('Verified: 8 MCP tools, display execution, isolated status and UI resource. Conversation activation and hook review remain pending.');
}
finally {
    await client.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('codex-monitor-setup-'))
        throw Error('Unexpected temporary directory');
    await rm(root, { recursive: true, force: true });
}
