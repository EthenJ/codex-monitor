import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { collect } from '../../install.mjs';
import { settings, inspect, apply, assertInactive, run, stateDirectory } from '../../installer/setup.mjs';
import { packagePlugin } from '../../installer/package.mjs';

const source = path.resolve('.');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'monitor-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = settings({ codex_home: path.join(root, '配置 with spaces'), bootstrap: false });
  // execute is mocked; unit tests need no Codex installation.
  const env = {
    ...process.env,
    CODEX_HOME: config.codex_home,
    CODEX_MONITOR_HOME: path.join(root, 'state'),
    CODEX_MONITOR_CODEX_BIN: process.execPath,
  };
  const calls = [];
  const execute = async (command, args) => {
    calls.push(args);
    if (args[0] === '--version') return 'codex-cli 0.166.0';
    if (args[1] === 'list') return '{"installed":[]}';
    if (args[1] === 'marketplace' && args[2] === 'list') return '{"marketplaces":[]}';
    throw Error('Unexpected execution: ' + args.join(' '));
  };
  return { root, config, env, execute, calls };
}

test('wizard collects choices and rejects invalid settings before execution', async () => {
  const answers = ['', 'invalid', 'both', 'verbose', 'no', 'no'];
  const value = await collect(async () => answers.shift());
  assert.equal(value.client, 'both');
  assert.equal(value.display, 'verbose');
  assert.equal(value.hooks, false);
  assert.equal(value.bootstrap, false);
  assert.equal(value.replace, false);
  for (const raw of [
    { hooks: 'yes' },
    { display: 'hidden' },
    { replace: 1 },
    { codex_home: '\0' },
    { recovery: true },
    [],
  ])
    assert.throws(() => settings(raw));
  assert.equal(stateDirectory(value, {}), path.join(value.codex_home, 'monitor-node'));
});

test('unattended installation requires an explicit file and confirmation', async () => {
  await assert.rejects(run(process.execPath, ['install.mjs', '--yes']), /requires --config/);
  await assert.rejects(run(process.execPath, ['install.mjs']), /needs a terminal/);
  await assert.rejects(run(process.execPath, ['install.mjs', '--config', 'missing.json']), /requires --yes/);
  await assert.rejects(run(process.execPath, ['install.mjs', '--unknown']), /Unknown argument/);
});
test('subprocess warnings do not corrupt JSON stdout and failures retain stderr', async () => {
  const text = await run(process.execPath, [
    '-e',
    'console.error("WARNING: fixture");console.log(JSON.stringify({ok:true}))',
  ]);
  assert.deepEqual(JSON.parse(text), { ok: true });
  await assert.rejects(
    run(process.execPath, ['-e', 'console.error("fixture error");process.exit(1)']),
    /fixture error/,
  );
});

test('preflight checks installed CLI and rejects a shared marketplace', async (t) => {
  const f = await fixture(t);
  const detected = await inspect(source, f.config, f);
  assert.equal(detected.source, true);
  assert.equal(detected.old, undefined);
  assert.equal(f.calls.length, 3);
  await assert.rejects(
    inspect(source, f.config, { env: f.env, execute: async () => 'codex-cli 0.165.0' }),
    /0.166.0/,
  );
  const market = path.join(f.root, 'market');
  await mkdir(path.join(market, '.agents/plugins'), { recursive: true });
  await writeFile(
    path.join(market, '.agents/plugins/marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'codex-monitor' }, { name: 'other' }] }),
  );
  await assert.rejects(
    inspect(source, f.config, {
      env: f.env,
      execute: async (cmd, args) =>
        args[2] === 'list'
          ? JSON.stringify({ marketplaces: [{ name: 'codex-monitor', root: market }] })
          : f.execute(cmd, args),
    }),
    /other plugins/,
  );
});

test('active, pending and corrupt monitor state blocks upgrades before dependency or registry changes', async (t) => {
  const f = await fixture(t),
    detected = await inspect(source, f.config, f);
  const dir = path.join(f.env.CODEX_MONITOR_HOME, randomUUID());
  await mkdir(dir, { recursive: true });
  for (const value of [
    { monitors: [{ state: 'armed' }] },
    { monitors: { one: { state: 'starting' } } },
    { recovery: { enabled: true } },
    { wait: { state: 'waiting' } },
    { events: { one: { state: 'pending' } } },
    { events: [{ state: 'unknown' }] },
    null,
  ]) {
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(value));
    await assert.rejects(apply(source, f.config, detected, f), /Active or unresolved|Cannot verify/);
  }
  await writeFile(path.join(dir, 'state.json'), '{broken');
  await assert.rejects(apply(source, f.config, detected, f), /Cannot verify/);
  assert.equal(f.calls.length, 3);
  assert.equal(existsSync(path.join(f.config.codex_home, 'plugin-sources')), false);
  await writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({ monitors: [{ state: 'stopped' }], events: [{ state: 'acknowledged' }] }),
  );
  assert.deepEqual(await assertInactive(f.env.CODEX_MONITOR_HOME), []);
});

test('replacement and concurrent-install guards preserve existing configuration', async (t) => {
  const f = await fixture(t),
    detected = await inspect(source, f.config, f);
  await assert.rejects(
    apply(source, f.config, { ...detected, old: { version: '0.2.1' } }, f),
    /replace=true/,
  );
  await mkdir(path.join(f.config.codex_home, 'plugin-sources/codex-monitor/install.lock'), {
    recursive: true,
  });
  await assert.rejects(apply(source, f.config, detected, f), /Another installation/);
  assert.equal(f.calls.length, 3);
});

test('deployment packaging is complete and excludes development and local files', async (t) => {
  const f = await fixture(t),
    dest = path.join(f.root, 'release');
  await packagePlugin(source, dest);
  for (const file of [
    'install.mjs',
    'installer/setup.mjs',
    'codex-monitor/runtime/setup-probe.js',
    'codex-monitor/references/installation.md',
    '.mcp.json',
    'hooks/hooks.json',
  ])
    assert.equal(existsSync(path.join(dest, file)), true, file);
  for (const file of [
    'src',
    'tests',
    'tools',
    'node_modules',
    '.github',
    '.git',
    '.tmp-node-service',
    'docs',
  ])
    assert.equal(existsSync(path.join(dest, file)), false, file);
  const manifest = JSON.parse(await readFile(path.join(dest, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(dest, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts.test, undefined);
  assert.equal(lock.packages[''].devDependencies, undefined);
  assert.equal(
    Object.values(lock.packages).some((x) => x.dev),
    false,
  );
  await assert.rejects(packagePlugin(source, dest), /new destination/);
});

test('production dependency failure leaves registration and preferences unchanged', async (t) => {
  const f = await fixture(t),
    detected = await inspect(source, f.config, f);
  await mkdir(f.env.CODEX_MONITOR_HOME, { recursive: true });
  const prefs = path.join(f.env.CODEX_MONITOR_HOME, 'settings.json');
  await writeFile(prefs, '{"display_mode":"verbose","preserved":true}');
  const before = await readFile(prefs, 'utf8');
  const calls = [];
  await assert.rejects(
    apply(
      source,
      f.config,
      { ...detected, source: false },
      {
        env: f.env,
        log: () => {},
        execute: async (_, args) => {
          calls.push(args);
          throw Error('fixture dependency failure');
        },
      },
    ),
    /fixture dependency failure/,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('ci'));
  assert.equal(await readFile(prefs, 'utf8'), before);
  assert.equal(
    existsSync(path.join(f.config.codex_home, 'plugin-sources/codex-monitor/install.lock')),
    false,
  );
  const sources = await readdir(path.join(f.config.codex_home, 'plugin-sources/codex-monitor'));
  assert.equal(sources.length, 1); // Keep prepared files for diagnosis; do not delete user paths.
});

test('failed registration reports retained paths without claiming rollback or changing defaults', async (t) => {
  const f = await fixture(t),
    detected = await inspect(source, f.config, f),
    messages = [],
    calls = [];
  await assert.rejects(
    apply(
      source,
      { ...f.config, replace: true },
      { ...detected, source: false, old: { version: '0.2.1' } },
      {
        env: f.env,
        log: (message) => messages.push(message),
        execute: async (_, args) => {
          calls.push(args);
          if (args[0] === 'plugin' && args[1] === 'marketplace') throw Error('fixture registry failure');
          return '';
        },
      },
    ),
    /fixture registry failure/,
  );
  assert.ok(calls.some((args) => args[1] === 'remove'));
  assert.ok(messages.some((x) => x.includes('Registration was partially changed')));
  assert.equal(existsSync(path.join(f.env.CODEX_MONITOR_HOME, 'settings.json')), false);
});
