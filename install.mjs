#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settings, inspect, apply, stateDirectory } from './installer/setup.mjs';

export async function collect(ask, initial = {}) {
  const result = settings(initial);
  async function choose(question, allowed, fallback) {
    for (;;) {
      const value = (await ask(`${question} [${fallback}]: `)).trim() || fallback;
      if (allowed.includes(value)) return value;
      console.log(`Choose ${allowed.join(' / ')}.`);
    }
  }
  result.codex_home =
    (await ask(`Codex configuration directory [${result.codex_home}]: `)).trim() || result.codex_home;
  result.client = await choose('Client: cli / desktop / both', ['cli', 'desktop', 'both'], result.client);
  result.display = await choose(
    'Default display: compact (recommended) / verbose',
    ['compact', 'verbose'],
    result.display,
  );
  result.hooks =
    (await choose(
      'Include automatic Stop/Interrupt reports? Requires later /hooks review: yes / no',
      ['yes', 'no'],
      result.hooks ? 'yes' : 'no',
    )) === 'yes';
  result.bootstrap =
    (await choose(
      'Start the background launcher now? No OS startup service: yes / no',
      ['yes', 'no'],
      result.bootstrap ? 'yes' : 'no',
    )) === 'yes';
  return settings(result);
}
export async function main(args = process.argv.slice(2)) {
  let configFile,
    dry = false,
    yes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') {
      configFile = args[++i];
      if (!configFile) throw Error('--config needs a JSON file');
    } else if (args[i] === '--dry-run') dry = true;
    else if (args[i] === '--yes') yes = true;
    else if (args[i] === '--help') {
      console.log(
        'node install.mjs [--dry-run] [--config answers.json --yes]\nInteractive by default. --dry-run previews without installing or changing plugin preferences.\nConfiguration: codex_home, client (cli/desktop/both), display (compact/verbose), hooks, bootstrap, replace.\nAgent-assisted: collect user choices, preview --config FILE --dry-run, then apply --config FILE --yes.',
      );
      return;
    } else throw Error(`Unknown argument: ${args[i]}`);
  }
  if (yes && !configFile) throw Error('--yes requires --config so unattended choices are explicit');
  if (!configFile && !process.stdin.isTTY)
    throw Error(
      'Interactive setup needs a terminal. Use --config FILE --dry-run to preview, then --config FILE --yes to install.',
    );
  if (configFile && !dry && !yes && !process.stdin.isTTY)
    throw Error('Non-interactive installation requires --yes after reviewing the configuration');
  let rl;
  const ask = (q) => rl.question(q);
  try {
    if (process.stdin.isTTY) rl = createInterface({ input: process.stdin, output: process.stdout });
    const config = configFile
      ? settings(JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, '')))
      : await collect(ask);
    const root = fileURLToPath(new URL('.', import.meta.url));
    console.log('\nChecking Node.js, npm, Codex and existing plugin registration...');
    const detected = await inspect(root, config);
    if ((detected.old || detected.market) && !configFile)
      config.replace = /^y(es)?$/i.test(
        (
          await ask(
            'Existing codex-monitor found. Reinstall ONLY this plugin? Hook review and plugin-specific policies may need reapplying [no]: ',
          )
        ).trim(),
      );
    console.log(
      [
        '\nInstallation plan · codex-monitor v0.2.2',
        `  Codex directory: ${config.codex_home}`,
        `  Monitor state:   ${stateDirectory(config)}`,
        `  Client:          ${config.client}`,
        `  Display:         ${config.display}`,
        `  Stop reports:    ${config.hooks ? 'included; /hooks review required' : 'omitted'}`,
        `  Start launcher:  ${config.bootstrap ? 'yes' : 'no'}`,
        `  Existing plugin: ${detected.old?.version || (detected.market ? 'marketplace only' : 'none')}`,
        `  Replace:         ${config.replace ? 'yes, codex-monitor only' : 'no'}`,
        `  Source build:    ${detected.source ? 'npm ci and TypeScript build in this checkout' : 'use included JavaScript'}`,
        '  Auto-recovery:   not enabled',
      ].join('\n'),
    );
    console.log(
      'A complete deployment directory will be prepared. Existing monitors are not stopped automatically. Reopen Codex afterward.',
    );
    if (dry) {
      console.log(
        'Dry run complete. No dependencies, plugin registration, preferences or trust were changed. Codex diagnostic commands may maintain their own caches.',
      );
      return;
    }
    if (!yes && !/^y(es)?$/i.test((await ask('Install with these settings? [no]: ')).trim())) {
      console.log('Cancelled. No installation changes made.');
      return;
    }
    await apply(root, config, detected);
  } finally {
    rl?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`Setup failed: ${error.message}`);
    process.exitCode = 1;
  });
