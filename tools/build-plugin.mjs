import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const destination = path.resolve(process.argv[2] || path.join(root, 'dist', `codex-monitor-v${manifest.version}`));
if (existsSync(destination)) throw Error('Choose a new destination; existing files are never removed');
if (!existsSync(path.join(root, 'codex-monitor/runtime/server.js'))) throw Error('Run npm run build first');
await mkdir(destination, { recursive: true });
for (const relative of ['README.md', 'LICENSE', '.mcp.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', 'codex-monitor/SKILL.md', 'codex-monitor/agents/openai.yaml']) {
  await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await cp(path.join(root, relative), path.join(destination, relative));
}
await cp(path.join(root, 'codex-monitor/runtime'), path.join(destination, 'codex-monitor/runtime'), { recursive: true });
await mkdir(path.join(destination, 'codex-monitor/references'), { recursive: true });
await cp(path.join(root, 'codex-monitor/references/plugin.md'), path.join(destination, 'codex-monitor/references/plugin.md'));
// Deployment has no source/build/test entry points or development dependency tree.
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
delete manifest.devDependencies;
manifest.scripts = { bootstrap: manifest.scripts.bootstrap };
delete lock.packages[''].devDependencies;
for (const [key, entry] of Object.entries(lock.packages)) if (entry.dev === true) delete lock.packages[key];
await writeFile(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
// The installed plugin runs compiled JavaScript. Source, tests, workflows and legacy
// Python helpers stay on develop; runtime dependencies install from the lock file.
console.log(destination);
