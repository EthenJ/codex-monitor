import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicJson, stateRoot, threadKey } from './common.js';

export const displayModeSchema = z.enum(['compact', 'verbose']);
export type DisplayMode = z.infer<typeof displayModeSchema>;
// Stored outside the installed plugin so changing presentation never invalidates hook trust.
export function displaySettings(threadId: string, mode?: DisplayMode, root = stateRoot()) {
  const key = threadKey(threadId), file = path.join(root, key, 'display.json');
  if (mode !== undefined) {
    const valid = displayModeSchema.parse(mode);
    atomicJson(file, { thread_id: key, mode: valid });
    return { mode: valid, warnings: [] as string[] };
  }
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.thread_id !== key) throw Error('Display settings belong to another thread');
    return { mode: displayModeSchema.parse(saved.mode), warnings: [] as string[] };
  } catch (error: any) {
    if (error.code !== 'ENOENT') return { mode: 'compact' as DisplayMode, warnings: ['Display settings are unreadable; using compact mode.'] };
    try {
      const defaults = JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8'));
      return { mode: displayModeSchema.parse(defaults.display_mode), warnings: [] as string[] };
    } catch (fallback: any) {
      return { mode: 'compact' as DisplayMode, warnings: fallback.code === 'ENOENT' ? [] : ['Installation display defaults are unreadable; using compact mode.'] };
    }
  }
}
