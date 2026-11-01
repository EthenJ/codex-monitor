import { spawn } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rename, rmdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { packagePlugin } from './package.mjs';

export const pluginId = 'codex-monitor@codex-monitor';
export function settings(raw = {}, env = process.env) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Configuration must be an object');
  for (const key of Object.keys(raw))
    if (!['codex_home', 'client', 'display', 'hooks', 'bootstrap', 'replace'].includes(key))
      throw Error(`Unknown setting: ${key}`);
  const r = {
    codex_home: env.CODEX_HOME || path.join(homedir(), '.codex'),
    client: 'cli',
    display: 'compact',
    hooks: true,
    bootstrap: true,
    replace: false,
    ...raw,
  };
  if (typeof r.codex_home !== 'string' || !r.codex_home.trim() || /[\r\n\0]/.test(r.codex_home))
    throw Error('codex_home must be a directory path');
  r.codex_home = path.resolve(r.codex_home.replace(/^~(?=$|[\\/])/, homedir()));
  for (const [key, values] of Object.entries({
    client: ['cli', 'desktop', 'both'],
    display: ['compact', 'verbose'],
  }))
    if (!values.includes(r[key])) throw Error(`${key} must be ${values.join(' or ')}`);
  for (const key of ['hooks', 'bootstrap', 'replace'])
    if (typeof r[key] !== 'boolean') throw Error(`${key} must be true or false`);
  return r;
}
export function stateDirectory(config, env = process.env) {
  return path.resolve(env.CODEX_MONITOR_HOME || path.join(config.codex_home, 'monitor-node'));
}
export function executable(name, env = process.env) {
  if (name === 'codex' && env.CODEX_MONITOR_CODEX_BIN) return env.CODEX_MONITOR_CODEX_BIN;
  if (process.platform !== 'win32') return name;
  for (const dir of (env.PATH || '').split(path.delimiter))
    if (existsSync(path.join(dir, `${name}.exe`))) return path.join(dir, `${name}.exe`);
  if (name === 'codex')
    for (const base of [
      env.CODEX_MANAGED_PACKAGE_ROOT,
      ...(env.PATH || '').split(path.delimiter).map((p) => path.join(p, 'node_modules/@openai/codex')),
    ].filter(Boolean)) {
      if (!existsSync(base)) continue;
      const files = globSync('node_modules/@openai/codex-win32-*/vendor/*/bin/codex.exe', { cwd: base });
      if (files[0]) return path.join(base, files[0]);
    }
  throw Error(`${name}.exe not found. Install Codex CLI and open a new terminal.`);
}
export function npmCommand(env = process.env) {
  if (process.platform !== 'win32') return ['npm', []];
  for (const dir of [path.dirname(process.execPath), ...(env.PATH || '').split(path.delimiter)]) {
    const entry = path.join(dir, 'node_modules/npm/bin/npm-cli.js');
    if (existsSync(entry)) return [process.execPath, [entry]];
  }
  throw Error('npm was not found beside Node.js or on PATH. Install Node.js with npm.');
}
export function run(command, args, { cwd, env = process.env, inherit = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Error(`Timed out: ${path.basename(command)}`));
    }, timeout);
    child.stdout?.setEncoding('utf8').on('data', (c) => {
      output = (output + c).slice(-262144);
    });
    child.stderr?.setEncoding('utf8').on('data', (c) => {
      errors = (errors + c).slice(-262144);
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output.trim())
        : reject(
            Error(
              `${path.basename(command)} exited ${code}: ${(output + '\n' + errors).trim().slice(-4000)}`,
            ),
          );
    });
  });
}
export async function localRpc(directory, method) {
  const e = JSON.parse(await readFile(path.join(directory, 'endpoint.json'), 'utf8'));
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || typeof e.token !== 'string')
    throw Error('Invalid local endpoint');
  const r = await fetch(`http://127.0.0.1:${e.port}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
    signal: AbortSignal.timeout(1500),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw Error(data.error || 'Local status unavailable');
  return data.result;
}
export async function assertInactive(root) {
  const live = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let state;
    try {
      state = await localRpc(dir, 'status');
      live.push(dir);
    } catch {
      try {
        state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw Error(`Cannot verify monitor state in ${dir}`);
      }
    }
    if (!state || typeof state !== 'object' || Array.isArray(state))
      throw Error(`Cannot verify monitor state in ${dir}`);
    if (
      Object.values(state.monitors || {}).some(
        (m) => !m || ['starting', 'armed', 'stopping'].includes(m.state),
      ) ||
      state.recovery?.enabled ||
      ['preparing', 'waiting', 'waking'].includes(state.wait?.state) ||
      Object.values(state.events || {}).some((e) => !e || ['pending', 'sending', 'unknown'].includes(e.state))
    )
      throw Error(
        `Active or unresolved monitoring in thread ${entry.name}. Stop its monitors, cancel its wait, disable recovery and reconcile pending/unknown events before upgrading. Training PIDs are not stopped by this installer.`,
      );
  }
  return live;
}
export async function inspect(root, config, { env = process.env, execute = run } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 22)) throw Error('Node.js 22.22 or newer is required');
  const command = executable('codex', env),
    context = { env: { ...env, CODEX_HOME: config.codex_home }, cwd: root };
  // Codex rejects a nonexistent CODEX_HOME. Preview a fresh installation in a
  // disposable home instead of creating the user's chosen target before consent.
  const probeHome = existsSync(config.codex_home)
    ? null
    : await mkdtemp(path.join(tmpdir(), 'monitor-preflight-'));
  const diagnostic = probeHome ? { ...context, env: { ...context.env, CODEX_HOME: probeHome } } : context;
  let version, installed, markets;
  try {
    version = await execute(command, ['--version'], diagnostic);
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match || (+match[1] === 0 && +match[2] < 166))
      throw Error('Codex CLI 0.166.0 or newer is required (0.166.0 validated)');
    installed = JSON.parse(await execute(command, ['plugin', 'list', '--json'], diagnostic));
    markets = JSON.parse(await execute(command, ['plugin', 'marketplace', 'list', '--json'], diagnostic));
  } finally {
    if (probeHome) {
      if (
        path.dirname(probeHome) !== path.resolve(tmpdir()) ||
        !path.basename(probeHome).startsWith('monitor-preflight-')
      )
        throw Error('Unexpected preflight directory');
      await rm(probeHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  const old = installed.installed.find((p) => p.pluginId === pluginId),
    market = markets.marketplaces.find((m) => m.name === 'codex-monitor');
  if (market) {
    const catalog = JSON.parse(
      await readFile(path.join(market.root, '.agents/plugins/marketplace.json'), 'utf8'),
    );
    if (catalog.plugins.length !== 1 || catalog.plugins[0].name !== 'codex-monitor')
      throw Error(
        'The codex-monitor marketplace contains other plugins; manage that marketplace explicitly before installing.',
      );
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'codex-monitor' || manifest.version !== '0.2.4')
    throw Error('Expected the codex-monitor v0.2.4 package');
  npmCommand(env);
  if (config.hooks) {
    const definitions = JSON.parse(await readFile(path.join(root, 'hooks/hooks.json'), 'utf8'));
    if (!definitions.hooks?.Stop?.length || !definitions.hooks?.Interrupt?.length)
      throw Error('This source omits reporting hooks. Use a complete release package to enable them.');
  }
  return {
    command,
    context,
    version,
    old,
    market,
    source: existsSync(path.join(root, 'src/server.ts')),
    manifest,
  };
}
export function activation(config, bundle, state = stateDirectory(config)) {
  const quote = (value) =>
    "'" + (process.platform === 'win32' ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''")) + "'";
  const environment =
    process.platform === 'win32'
      ? [`   $env:CODEX_HOME = ${quote(config.codex_home)}`, `   $env:CODEX_MONITOR_HOME = ${quote(state)}`]
      : [`   export CODEX_HOME=${quote(config.codex_home)}`, `   export CODEX_MONITOR_HOME=${quote(state)}`];
  return [
    'Activation (installation is not activation):',
    config.client === 'desktop'
      ? '1. Fully restart the desktop client and reopen/resume the conversation.'
      : config.client === 'both'
        ? '1. Fully restart Codex CLI and the desktop client, then reopen/resume the conversation.'
        : '1. Fully exit Codex CLI and reopen/resume the conversation.',
    '   Existing conversations can keep an old MCP connection even when discovery lists new tools.',
    '2. Open /plugins and confirm codex-monitor is enabled, then /mcp and check monitor.',
    '3. Ask Codex to call monitor_display with your current thread ID. The new tool must actually execute.',
    config.hooks
      ? '4. Open /hooks. Review and trust ONLY codex-monitor Stop and Interrupt. Installing does not grant trust.'
      : '4. Automatic Stop/Interrupt reports were omitted. Use monitor_report when needed.',
    '   Finish installation before hook review. Do not edit the installed bundle afterward.',
    config.bootstrap
      ? '5. The launcher was requested. Check its result below; it is not an OS startup service.'
      : '5. Start the launcher from an external terminal before monitoring:',
    ...environment,
    `   node ${quote(path.join(bundle, 'codex-monitor/runtime/cli.js'))} bootstrap`,
    '   Run it again after each login/reboot, with the same CODEX_HOME and CODEX_MONITOR_HOME as Codex.',
    '6. Ask for a short command-exit demo. Expect a native event tool result and, when enabled, a one-line Stop report.',
    '   CLI shows text results; it does not render HTML panels or a separate background-arrival card.',
    '   Desktop HTML rendering is host-dependent and has not been visually validated.',
    'Automatic recovery is not enabled by installation. Authorize it separately in the intended conversation.',
    'Example: retry failed conversation turns every 300 seconds for at most 3 hours; respect manual interruption.',
  ].join('\n');
}
export async function apply(
  root,
  config,
  detected,
  { env = process.env, execute = run, log = console.log } = {},
) {
  const state = stateDirectory(config, env),
    parent = path.join(config.codex_home, 'plugin-sources', 'codex-monitor');
  if ((detected.old || detected.market) && !config.replace)
    throw Error(
      'An installation/marketplace exists. Review it and choose replace=true to reinstall this plugin only.',
    );
  await assertInactive(state);
  const defaultsFile = path.join(state, 'settings.json');
  let previous = {};
  try {
    previous = JSON.parse(await readFile(defaultsFile, 'utf8'));
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw Error('Invalid settings');
  } catch (e) {
    if (e.code !== 'ENOENT') throw Error(`Cannot read existing defaults: ${defaultsFile}`);
  }
  await mkdir(parent, { recursive: true });
  const lock = path.join(parent, 'install.lock');
  try {
    await mkdir(lock);
  } catch (e) {
    if (e.code === 'EEXIST') throw Error(`Another installation may be running: ${lock}`);
    throw e;
  }
  const bundle = path.join(parent, `0.2.4-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const context = detected.context;
  const codex = (args) => execute(detected.command, args, context);
  let registryChanged = false;
  try {
    const [npm, prefix] = npmCommand(env);
    if (detected.source) {
      log('Installing development dependencies and compiling this source checkout...');
      await execute(npm, [...prefix, 'ci'], { ...context, inherit: true, timeout: 600000 });
      await execute(npm, [...prefix, 'run', 'build'], { ...context, inherit: true });
    }
    await packagePlugin(root, bundle);
    if (!config.hooks)
      await writeFile(path.join(bundle, 'hooks/hooks.json'), JSON.stringify({ hooks: {} }, null, 2) + '\n');
    log('Installing production dependencies into the complete deployment bundle...');
    await execute(npm, [...prefix, 'ci', '--omit=dev'], {
      ...context,
      cwd: bundle,
      inherit: true,
      timeout: 600000,
    });
    await execute(process.execPath, [path.join(bundle, 'codex-monitor/runtime/setup-probe.js')], {
      ...context,
      cwd: bundle,
    });
    const oldServices = (await assertInactive(state)) || [];
    if (detected.market || detected.old) {
      for (const directory of oldServices) await localRpc(directory, 'shutdown');
      try {
        await localRpc(path.join(state, 'broker'), 'shutdown');
      } catch (e) {
        if (e.code !== 'ENOENT' && !/fetch failed|abort|timeout/i.test(String(e))) throw e;
      }
    }
    if (detected.old) {
      registryChanged = true;
      await codex(['plugin', 'remove', pluginId, '--json']);
    }
    if (detected.market) {
      registryChanged = true;
      await codex(['plugin', 'marketplace', 'remove', 'codex-monitor', '--json']);
    }
    registryChanged = true;
    await codex(['plugin', 'marketplace', 'add', bundle, '--json']);
    await codex(['plugin', 'add', pluginId, '--json']);
    const result = JSON.parse(await codex(['plugin', 'list', '--json']));
    if (!result.installed.some((p) => p.pluginId === pluginId && p.version === '0.2.4' && p.enabled))
      throw Error('Codex did not report the enabled v0.2.4 installation');
    const cache = path.join(config.codex_home, 'plugins/cache/codex-monitor/codex-monitor/0.2.4');
    if (!existsSync(path.join(cache, 'codex-monitor/runtime/server.js')))
      throw Error('Installed cache was not found; inspect codex plugin list');
    await execute(process.execPath, [path.join(cache, 'codex-monitor/runtime/setup-probe.js')], {
      ...context,
      cwd: cache,
    });
    await mkdir(state, { recursive: true, mode: 0o700 });
    const temp = defaultsFile + `.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ ...previous, display_mode: config.display }, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(temp, defaultsFile);
    let launcher = 'not_requested';
    if (config.bootstrap) {
      try {
        await execute(
          process.execPath,
          [path.join(bundle, 'codex-monitor/runtime/cli.js'), 'bootstrap'],
          context,
        );
        launcher = 'ready';
      } catch (e) {
        launcher = 'needs_external_terminal';
        log(`Launcher could not start: ${e.message}`);
      }
    }
    const receipt = {
      version: '0.2.4',
      installed_at: new Date().toISOString(),
      bundle,
      cache,
      config,
      launcher,
      activation_required: true,
    };
    await writeFile(path.join(parent, 'last-install.json'), JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    log(activation(config, bundle, state));
    log(`Launcher: ${launcher}. Saved defaults: ${defaultsFile}`);
    return receipt;
  } catch (error) {
    if (registryChanged)
      log(
        `Registration was partially changed. Old source retained: ${detected.market?.root || '(none)'}. Prepared source retained: ${bundle}. Inspect codex plugin list --json before retrying. No monitor state was removed.`,
      );
    throw error;
  } finally {
    await rmdir(lock);
  }
}
