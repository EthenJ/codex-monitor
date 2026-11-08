import path from 'node:path';
import { existsSync } from 'node:fs';
import { Bridge } from './bridge.js';
import { atomicJson, readJson, stateRoot, threadKey } from './common.js';
class MetadataUnavailable extends Error {
}
// forkedFromId and sessionId are deliberately not ancestry evidence. Only the
// host's subagent parent metadata may join two otherwise isolated services.
export async function ancestry(bridge, caller) {
    caller = threadKey(caller);
    const seen = new Set(), ancestors = [];
    let current = caller, first;
    for (let depth = 0; depth < 32; depth++) {
        if (seen.has(current))
            throw Error('Cyclic host subagent ancestry');
        seen.add(current);
        let result;
        try {
            result = await bridge.rpc('thread/read', { threadId: current, includeTurns: false });
        }
        catch (error) {
            if (current === caller)
                throw new MetadataUnavailable(String(error));
            throw error;
        }
        const { thread } = result;
        if (!thread || threadKey(thread.id) !== current)
            throw Error('Host thread metadata mismatch');
        first ??= thread;
        const source = thread.source?.subAgent ?? thread.source?.subagent;
        const legacy = source?.thread_spawn?.parent_thread_id;
        const parent = thread.parentThreadId ?? legacy;
        if (thread.parentThreadId && legacy && threadKey(thread.parentThreadId) !== threadKey(legacy))
            throw Error('Conflicting host subagent ancestry');
        if (!parent) {
            if (source)
                throw Error('Host subagent metadata has no verifiable parent');
            return { caller, owner: current, ancestors, nickname: first?.agentNickname ?? undefined, role: first?.agentRole ?? undefined };
        }
        current = threadKey(parent);
        ancestors.push(current);
    }
    throw Error('Subagent ancestry exceeds 32 levels');
}
export function savedRoute(caller, root = stateRoot()) {
    caller = threadKey(caller);
    const file = path.join(root, caller, 'route.json');
    if (!existsSync(file))
        return;
    const route = readJson(file);
    if (route.caller !== caller || threadKey(route.owner) !== route.owner || !Array.isArray(route.ancestors) ||
        route.ancestors.length > 32 || route.ancestors.some((x) => threadKey(x) !== x) ||
        (route.ancestors.at(-1) ?? caller) !== route.owner)
        throw Error('Invalid saved monitor routing; inspect route.json');
    return route;
}
export class Routing {
    root;
    connect;
    bridge;
    cache = new Map();
    constructor(root = stateRoot(), connect = () => Bridge.connect()) {
        this.root = root;
        this.connect = connect;
    }
    async resolve(caller) {
        caller = threadKey(caller);
        let pending = this.cache.get(caller);
        if (!pending) {
            pending = this.lookup(caller).catch(error => {
                this.cache.delete(caller);
                // Preserve standalone/offline observation, without claiming that an
                // unverified caller is a root or silently changing a known child owner.
                if (error instanceof MetadataUnavailable && !savedRoute(caller, this.root)?.ancestors.length)
                    return { caller, owner: caller, ancestors: [], warning: 'Host ancestry unavailable; isolated thread observation only. Subagent routing and callbacks are unverified.' };
                throw error;
            });
            this.cache.set(caller, pending);
            if (this.cache.size > 128)
                this.cache.delete(this.cache.keys().next().value);
        }
        return pending;
    }
    async lookup(caller) {
        this.bridge ??= this.connect().then(bridge => {
            bridge.on('disconnected', () => { this.bridge = undefined; this.cache.clear(); });
            return bridge;
        }).catch(error => { this.bridge = undefined; throw new MetadataUnavailable(String(error)); });
        const route = await ancestry(await this.bridge, caller);
        const bindings = [route, ...route.ancestors.map((key, i) => ({ caller: key, owner: route.owner, ancestors: route.ancestors.slice(i + 1) }))];
        for (const binding of bindings) {
            const previous = savedRoute(binding.caller, this.root);
            if (previous && previous.owner !== route.owner)
                throw Error('Host ancestry changed; inspect the existing monitor owner before routing');
            // Never strand pre-upgrade observers in a still-running child service.
            if (route.owner !== binding.caller && !previous) {
                const file = path.join(this.root, binding.caller, 'state.json');
                if (existsSync(file)) {
                    const old = readJson(file);
                    if (Object.values(old.monitors || {}).some((r) => ['armed', 'starting', 'reconnecting', 'stopping', 'unknown'].includes(r.state)) ||
                        Object.values(old.events || {}).some((e) => !['acknowledged', 'expired', 'suppressed', 'superseded'].includes(e.state)) ||
                        old.recovery?.enabled || ['preparing', 'waiting', 'waking'].includes(old.wait?.state))
                        throw Error('Legacy child monitor state requires reconciliation with the previous plugin before task routing can activate. No observers were moved or restarted.');
                }
            }
        }
        for (const binding of bindings)
            atomicJson(path.join(this.root, binding.caller, 'route.json'), binding);
        return route;
    }
    async close() { const bridge = this.bridge; this.bridge = undefined; this.cache.clear(); if (bridge)
        await (await bridge).close(); }
}
