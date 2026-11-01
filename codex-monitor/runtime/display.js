import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicJson, stateRoot, threadKey } from './common.js';
export const displayModeSchema = z.enum(['compact', 'verbose']);
// Stored outside the installed plugin so changing presentation never invalidates hook trust.
export function displaySettings(threadId, mode, root = stateRoot()) {
    const key = threadKey(threadId), file = path.join(root, key, 'display.json');
    if (mode !== undefined) {
        const valid = displayModeSchema.parse(mode);
        atomicJson(file, { thread_id: key, mode: valid });
        return { mode: valid, warnings: [] };
    }
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.thread_id !== key)
            throw Error('Display settings belong to another thread');
        return { mode: displayModeSchema.parse(saved.mode), warnings: [] };
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            return { mode: 'compact', warnings: ['Display settings are unreadable; using compact mode.'] };
        try {
            const defaults = JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8'));
            return { mode: displayModeSchema.parse(defaults.display_mode), warnings: [] };
        }
        catch (fallback) {
            return { mode: 'compact', warnings: fallback.code === 'ENOENT' ? [] : ['Installation display defaults are unreadable; using compact mode.'] };
        }
    }
}
