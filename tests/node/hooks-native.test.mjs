import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capture } from '../../codex-monitor/runtime/processes.js';
import { Bridge, codexExecutable } from '../../codex-monitor/runtime/bridge.js';

for (const surface of ['exec', 'app-server']) test(surface === 'exec' ? 'real trusted Stop hook reports without a continuation' : 'real App Server discovers untrusted hooks and skips execution', { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 25000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-hook-native-'));
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {} calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture done.', annotations: [] }] };
    const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture done.' },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'config.toml'), `model_provider="fixture"\nmodel="fixture"\n[model_providers.fixture]\nname="Offline hook fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const plugin = path.join(root, 'plugin with spaces');
  await mkdir(path.join(plugin, 'codex-monitor/runtime'), { recursive: true });
  await mkdir(path.join(plugin, 'hooks'), { recursive: true });
  await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(path.join(plugin, '.agents/plugins'), { recursive: true });
  const marker = path.join(root, 'hook-result.json'), harness = path.join(plugin, 'codex-monitor/runtime/stop-report.js');
  await writeFile(harness, `import {writeFileSync} from 'node:fs';import {stopReport} from ${JSON.stringify(new URL('../../codex-monitor/runtime/stop-report.js', import.meta.url).href)};let input='';for await(const c of process.stdin)input+=c;const parsed=JSON.parse(input);const result=await stopReport(parsed);writeFileSync(${JSON.stringify(marker)},JSON.stringify({input:parsed,result}));process.stdout.write(JSON.stringify(result));`);
  const hooks = JSON.parse(await readFile(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'));
  await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify(hooks));
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'report-fixture', version: '0.0.1', hooks: './hooks/hooks.json' }));
  await writeFile(path.join(plugin, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'report-fixture', plugins: [{ name: 'report-fixture', source: { source: 'local', path: './' } }] }));
  // Only these repository-owned read-only hooks are vetted for this isolated invocation.
  // User trust/configuration and paid model credentials are never used or modified.
  const env = { ...process.env, CODEX_HOME: root, CODEX_MONITOR_HOME: path.join(root, 'state') };
  await capture(codexExecutable(), ['plugin', 'marketplace', 'add', plugin], { env });
  await capture(codexExecutable(), ['plugin', 'add', 'report-fixture@report-fixture'], { env });
  if (surface === 'exec') {
    const out = await capture(codexExecutable(), ['exec', '--json', '--enable', 'hooks', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--cd', root, 'Fixture: answer once.'], { env }, 20000);
    assert.match(out, /Fixture done/, out);
  } else {
    const bridge = await Bridge.connect({ args: ['app-server', '--stdio', '--enable', 'hooks'], jsonl: true, env });
    try {
      let timeout;
      const thread = (await bridge.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
      const catalog = await bridge.rpc('hooks/list', { threadId: thread });
      assert.match(JSON.stringify(catalog), /untrusted/); assert.match(JSON.stringify(catalog), /Reporting monitor status/);
      const turn = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(Error('No turn/completed notification')), 15000);
        bridge.on('notification', (method, params) => { if (method === 'turn/completed') resolve(params); });
      });
      void turn.catch(() => {});
      try {
        await bridge.rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Fixture: answer once.' }] });
        const event = await turn; assert.equal(event.turn.status, 'completed');
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
      } finally { clearTimeout(timeout); }
    } finally { await bridge.close(); }
  }
  assert.equal(calls, 1, 'Reporting must not cause another model request');
  if (surface === 'exec') {
    const recorded = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(recorded.input.hook_event_name, 'Stop');
    assert.match(recorded.input.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(recorded.result.systemMessage, 'Monitor · none running');
    assert.deepEqual(Object.keys(recorded.result), ['systemMessage']);
  }
});
