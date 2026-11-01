import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { packagePlugin } from '../../installer/package.mjs';
import { run } from '../../installer/setup.mjs';
import { inspect, settings } from '../../installer/setup.mjs';
import { Bridge } from '../../codex-monitor/runtime/bridge.js';
import { ensureBroker, ensureService, rpc } from '../../codex-monitor/runtime/service.js';

test(
  'fresh-home preflight succeeds without creating the selected home',
  { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 20000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monitor-new-home-'));
    try {
      const config = settings({ codex_home: path.join(root, 'not created yet') });
      const result = await inspect(path.resolve('.'), config);
      assert.equal(result.old, undefined);
      assert.equal(result.context.env.CODEX_HOME, config.codex_home);
      assert.equal(existsSync(config.codex_home), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'real wizard installs and replaces in an isolated Codex home with spaces and Unicode',
  { skip: !process.env.CODEX_MONITOR_TEST_NATIVE, timeout: 180000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monitor-install-native-'));
    const home = path.join(root, '模拟 home'),
      state = path.join(root, 'monitor state'),
      deployment = path.join(root, 'release package');
    const env = { ...process.env, CODEX_HOME: home, CODEX_MONITOR_HOME: state };
    const answers = path.join(root, 'answers.json');
    let bridge, service;
    const checkHost = async (expectedMode, hooks) => {
      bridge = await Bridge.connect({
        args: ['app-server', '--stdio', '--enable', 'hooks'],
        jsonl: true,
        env,
      });
      try {
        const statuses = new Map();
        bridge.on('notification', (method, p) => {
          if (method === 'mcpServer/startupStatus/updated') statuses.set(p.name, p);
        });
        const thread = (
          await bridge.rpc('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' })
        ).thread.id;
        let server = (await bridge.rpc('mcpServerStatus/list', { threadId: thread })).data.find(
          (x) => x.pluginId === 'codex-monitor@codex-monitor',
        );
        assert.ok(server);
        if (!Object.keys(server.tools).length)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              bridge.off('notification', listener);
              reject(Error('MCP startup timed out'));
            }, 15000);
            const listener = (method, p) => {
              if (
                method === 'mcpServer/startupStatus/updated' &&
                p.name === server.name &&
                p.status !== 'starting'
              ) {
                clearTimeout(timer);
                bridge.off('notification', listener);
                resolve();
              }
            };
            bridge.on('notification', listener);
            const last = statuses.get(server.name);
            if (last) listener('mcpServer/startupStatus/updated', last);
          });
        server = (
          await bridge.rpc('mcpServerStatus/list', { threadId: thread, serverName: server.name })
        ).data.find((x) => x.pluginId === 'codex-monitor@codex-monitor');
        assert.equal(server.runtimeStatus, 'connected');
        assert.equal(Object.keys(server.tools).length, 11);
        const result = await bridge.rpc('mcpServer/tool/call', {
          threadId: thread,
          server: server.name,
          tool: 'monitor_display',
          arguments: { thread_id: thread },
        });
        assert.ok(!result.isError);
        assert.equal(result.structuredContent.mode, expectedMode);
        const catalog = JSON.stringify(await bridge.rpc('hooks/list', { threadId: thread }));
        if (hooks) {
          assert.match(catalog, /Reporting monitor status/);
          assert.match(catalog, /untrusted/);
        } else assert.ok(!catalog.includes('Reporting monitor status'));
      } finally {
        await bridge.close();
        bridge = undefined;
      }
    };
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, 'config.toml'),
        'personality="pragmatic"\nmodel="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Offline fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n',
      );
      await packagePlugin(path.resolve('.'), deployment);
      const checkout = path.join(root, 'source checkout');
      await cp(deployment, checkout, { recursive: true });
      for (const file of ['src', 'tsconfig.json', 'package.json', 'package-lock.json'])
        await cp(path.resolve(file), path.join(checkout, file), { recursive: true });
      let input = checkout;
      let config = {
        codex_home: home,
        client: 'cli',
        display: 'verbose',
        hooks: true,
        bootstrap: false,
        replace: false,
      };
      // Windows editors often emit a UTF-8 BOM.
      await writeFile(answers, '\uFEFF' + JSON.stringify(config));
      const exec = (args) =>
        run(process.execPath, [path.join(input, 'install.mjs'), '--config', answers, ...args], {
          cwd: root,
          env,
          timeout: 120000,
        });
      const before = await readFile(path.join(home, 'config.toml'), 'utf8');
      assert.match(await exec(['--dry-run']), /Dry run complete/);
      assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), before);
      assert.equal(existsSync(path.join(home, 'plugin-sources')), false);
      assert.equal(existsSync(state), false);
      assert.equal(existsSync(path.join(checkout, 'node_modules')), false);
      assert.match(await exec(['--yes']), /Activation/);
      const receiptFile = path.join(home, 'plugin-sources/codex-monitor/last-install.json');
      const first = JSON.parse(await readFile(receiptFile, 'utf8'));
      assert.equal(first.launcher, 'not_requested');
      assert.equal(first.activation_required, true);
      assert.ok(first.bundle.startsWith(home + path.sep));
      assert.ok(existsSync(first.cache));
      assert.match(await readFile(path.join(home, 'config.toml'), 'utf8'), /personality\s*=\s*"pragmatic"/);
      assert.equal(existsSync(path.join(home, 'auth.json')), false);
      await checkHost('verbose', true);
      input = deployment;
      await assert.rejects(exec(['--yes']), /replace=true/);
      assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).bundle, first.bundle);
      await ensureBroker(state);
      service = await ensureService(randomUUID(), state);
      const oldBroker = (await rpc(path.join(state, 'broker'), 'status')).service_pid;
      config = { ...config, replace: true, hooks: false, display: 'compact', bootstrap: true };
      await writeFile(answers, JSON.stringify(config));
      assert.match(await exec(['--yes']), /Activation/);
      const second = JSON.parse(await readFile(receiptFile, 'utf8'));
      assert.notEqual(second.bundle, first.bundle);
      assert.ok(existsSync(first.bundle));
      assert.equal(second.launcher, 'ready');
      assert.notEqual((await rpc(path.join(state, 'broker'), 'status')).service_pid, oldBroker);
      await assert.rejects(rpc(service, 'status'));
      assert.deepEqual(JSON.parse(await readFile(path.join(second.cache, 'hooks/hooks.json'), 'utf8')), {
        hooks: {},
      });
      assert.equal(
        JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8')).display_mode,
        'compact',
      );
      assert.match(await readFile(path.join(home, 'config.toml'), 'utf8'), /personality\s*=\s*"pragmatic"/);
      await checkHost('compact', false);
    } finally {
      await bridge?.close();
      for (const dir of [service, path.join(state, 'broker')].filter(Boolean))
        try {
          await rpc(dir, 'shutdown');
        } catch {}
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('monitor-install-native-')
      )
        throw Error('Unexpected test root');
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
