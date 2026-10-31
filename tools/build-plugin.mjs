import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = path.resolve(process.argv[2] || path.join(root, 'dist', 'codex-monitor-v0.3.0'));
if (existsSync(destination)) throw Error('Choose a new destination; existing files are never removed');
if (!existsSync(path.join(root, 'codex-monitor/runtime/server.js'))) throw Error('Run npm run build first');
await mkdir(destination, { recursive: true });
for (const relative of ['README.md', 'LICENSE', 'package.json', 'package-lock.json', '.mcp.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', 'codex-monitor/SKILL.md', 'codex-monitor/agents/openai.yaml']) {
  await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await cp(path.join(root, relative), path.join(destination, relative));
}
await cp(path.join(root, 'codex-monitor/runtime'), path.join(destination, 'codex-monitor/runtime'), { recursive: true });
await mkdir(path.join(destination, 'codex-monitor/references'), { recursive: true });
await cp(path.join(root, 'codex-monitor/references/plugin.md'), path.join(destination, 'codex-monitor/references/plugin.md'));
// The installed plugin runs compiled JavaScript. Source, tests, workflows and legacy
// Python helpers stay on develop; runtime dependencies install from the lock file.
console.log(destination);
