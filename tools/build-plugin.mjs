import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePlugin } from '../installer/package.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
console.log(
  await packagePlugin(root, process.argv[2] || path.join(root, 'dist', `codex-monitor-v${version}`)),
);
