import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Shared deployment allowlist: no source, tests, workflows or local state.
export async function packagePlugin(root, destination) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  if (existsSync(destination)) throw Error('Choose a new destination; existing files are never removed');
  if (!existsSync(path.join(root, 'codex-monitor/runtime/server.js'))) throw Error('Run npm run build first');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const files = [
    'README.md',
    'LICENSE',
    'install.mjs',
    'installer',
    '.mcp.json',
    '.codex-plugin/plugin.json',
    '.agents/plugins/marketplace.json',
    'hooks/hooks.json',
    'codex-monitor/SKILL.md',
    'codex-monitor/agents/openai.yaml',
    'codex-monitor/runtime',
    'codex-monitor/references/plugin.md',
    'codex-monitor/references/installation.md',
  ];
  for (const relative of files) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relative), target, { recursive: true });
  }
  delete manifest.devDependencies;
  manifest.scripts = { setup: 'node install.mjs', bootstrap: manifest.scripts.bootstrap };
  delete lock.packages[''].devDependencies;
  for (const [key, entry] of Object.entries(lock.packages)) if (entry.dev === true) delete lock.packages[key];
  await writeFile(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  return destination;
}
