import { ancestry } from './ancestry.js';
import { getGoal, latestTurn, loaded, sameGoal } from './bridge.js';
import { bounded, id, integer, now, threadKey } from './common.js';
import { DEFAULT_RESUME_INSTRUCTIONS, resumeInstructionsSchema } from './contracts.js';
import { watchInputHistory } from './input-history.js';
const settled = new Set(['acknowledged', 'expired', 'superseded', 'suppressed']);
// Delegated waits never mutate a native goal or acquire a recovery policy.
// Sensors belong to the root service; a pending tool only leases delivery.
export class Delegation {
    host;
    historyFile;
    members = {};
    waits = {};
    blocks = new Map();
    revisions = new Map();
    verified = new Map();
    registrations = new Map();
    epoch = 0;
    preparations = new Map();
    goals = new Map();
    stamp(caller) { return `${this.epoch}:${this.revisions.get(caller) || 0}`; }
    invalidate(caller) { this.revisions.set(caller, (this.revisions.get(caller) || 0) + 1); }
    get active() { return this.blocks.size > 0 || this.preparations.size > 0 || this.registrations.size > 0; }
    constructor(host, historyFile, old = {}) {
        this.host = host;
        this.historyFile = historyFile;
        this.members = old.members || {};
        this.waits = old.delegated_waits || {};
        for (const wait of Object.values(this.waits))
            if (wait.state === 'waiting')
                Object.assign(wait, { state: 'interrupted', reason: 'service_restarted', goal_control: 'unchanged' });
    }
    async verify(caller) {
        caller = threadKey(caller);
        if (caller === this.host.threadId)
            return;
        let pending = this.verified.get(caller);
        if (!pending) {
            const stamp = this.stamp(caller);
            pending = (async () => {
                const bridge = await this.host.connect(), route = await ancestry(bridge, caller);
                if (route.owner !== this.host.threadId)
                    throw Error('Caller does not belong to this monitor task');
                // Provenance lives on records, so an inactive member may be reclaimed.
                // Registrations are leased across validation and the serialized sensor
                // queue; never prune a caller simply because its record is not ready yet.
                for (const key of Object.keys(this.members)) {
                    if (key === caller || this.blocks.has(key) || this.registrations.has(key) || this.preparations.has(key))
                        continue;
                    const required = Object.values(this.host.records).some(r => this.owns(key, r) && ['starting', 'armed', 'reconnecting', 'stopping', 'unknown'].includes(r.state)) ||
                        Object.values(this.host.events).some(e => !settled.has(e.state) && (e.delivery_thread_id === key || this.owns(key, this.host.records[e.monitor_id] || {})));
                    if (!required) {
                        delete this.members[key];
                        delete this.waits[key];
                        this.verified.delete(key);
                        this.revisions.delete(key);
                        this.goals.delete(key);
                    }
                }
                if (!this.members[caller] && Object.keys(this.members).length >= 128)
                    throw Error('Task member history full; reconcile the task before adding agents');
                this.members[caller] = route;
                // Subscribe only already-loaded members. Never resurrect a closed child.
                const live = (await bridge.rpc('thread/loaded/list', {})).data || [];
                if (!live.includes(caller))
                    throw Error('Subagent is no longer loaded; its root retains existing observers');
                for (const key of [caller, ...route.ancestors.filter(key => key !== this.host.threadId)]) {
                    if (this.host.closed || stamp !== this.stamp(caller))
                        throw Error('Agent activity changed during ancestry verification');
                    if (live.includes(key)) {
                        // Reuse a verified ancestor's existing subscription. Resuming it
                        // again replays goal snapshots and could interrupt its active wait.
                        const ancestor = key !== caller ? this.verified.get(key) : undefined;
                        if (ancestor)
                            await ancestor;
                        else
                            await bridge.rpc('thread/resume', { threadId: key, excludeTurns: true });
                    }
                }
                if (this.host.closed || stamp !== this.stamp(caller))
                    throw Error('Agent activity changed during ancestry verification');
                this.host.save();
                return route;
            })().catch(error => {
                if (this.verified.get(caller) === pending)
                    this.verified.delete(caller);
                throw error;
            });
            this.verified.set(caller, pending);
        }
        return pending;
    }
    async registration(caller, operation) {
        this.registrations.set(caller, (this.registrations.get(caller) || 0) + 1);
        const stamp = this.stamp(caller), checkCurrent = () => {
            if (this.host.closed || stamp !== this.stamp(caller))
                throw Error('Agent activity changed during monitor registration');
        };
        try {
            await this.verify(caller);
            checkCurrent();
            return await operation(checkCurrent);
        }
        finally {
            const remaining = (this.registrations.get(caller) || 1) - 1;
            if (remaining)
                this.registrations.set(caller, remaining);
            else
                this.registrations.delete(caller);
        }
    }
    owns(caller, record) {
        return caller === this.host.threadId || record.creator_thread_id === caller || record.creator_ancestors?.includes(caller);
    }
    monitor(caller, key) {
        const record = this.host.records[key];
        if (!record || !this.owns(caller, record))
            throw Error('Unknown monitor in caller scope');
        return record;
    }
    event(caller, key, resolution = false) {
        const event = this.host.events[key];
        if (!event || !(event.affected_monitor_ids || [event.monitor_id]).every((id) => this.host.records[id] && this.owns(caller, this.host.records[id])))
            throw Error('Unknown event in caller scope');
        if (resolution && caller !== this.host.threadId && event.delivery_thread_id && event.delivery_thread_id !== caller && !settled.has(event.state))
            throw Error('Event delivery belongs to another agent; let that agent reconcile it');
        return event;
    }
    snapshot(snapshot, caller) {
        if (caller === this.host.threadId)
            return { ...snapshot, delegated_waits: Object.values(this.waits), members: Object.values(this.members) };
        return scopeSnapshot({ ...snapshot, delegated_waits: Object.values(this.waits) }, caller);
    }
    async poll(caller, params, signal) {
        caller = threadKey(caller);
        const stamp = this.stamp(caller);
        this.preparations.set(caller, (this.preparations.get(caller) || 0) + 1);
        try {
            try {
                await this.verify(caller);
            }
            catch (error) {
                if (stamp === this.stamp(caller))
                    throw error;
            }
            if (stamp !== this.stamp(caller))
                return { state: 'released', reason: 'agent_activity', goal_control: 'unchanged' };
            return await this.preparePoll(caller, params, stamp, signal);
        }
        finally {
            const remaining = this.preparations.get(caller) - 1;
            if (remaining)
                this.preparations.set(caller, remaining);
            else
                this.preparations.delete(caller);
        }
    }
    async preparePoll(caller, params, stamp, signal) {
        if (this.host.callbacksHeld())
            return { state: 'parent_stopped', goal_control: 'unchanged', reason: 'Root callbacks are held; the root must reconcile the stopped task before delegating another wait' };
        const scope = params.wake_scope ?? 'thread';
        if (!['thread', 'selected'].includes(scope))
            throw Error('wake_scope must be thread or selected');
        const requested = params.monitor_ids ?? [];
        if (!Array.isArray(requested) || requested.some(key => typeof key !== 'string') || scope === 'selected' && !requested.length)
            throw Error('Select monitor IDs');
        for (const key of requested)
            this.monitor(caller, key);
        let selected = [];
        const timeout = integer(params.timeout_ms ?? 3600000, 'timeout_ms', 100, 86400000);
        const interval = integer(params.input_poll_ms ?? 250, 'input_poll_ms', 50, 5000);
        const instructions = resumeInstructionsSchema.parse(params.resume_instructions) ?? DEFAULT_RESUME_INSTRUCTIONS;
        const readiness = () => {
            selected = scope === 'selected' ? [...new Set(requested)] : Object.keys(this.host.records).filter(key => this.owns(caller, this.host.records[key]) && this.host.liveMonitor(key));
            if (this.blocks.has(caller))
                return { state: 'wait_active', reason: 'A delegated wait is already active' };
            if (selected.some(key => this.reservedByOther(caller, key)))
                return { state: 'wait_active', reason: 'Another agent is reconciling events in the selected branch' };
            const pending = Object.values(this.host.events).filter(e => !settled.has(e.state) && this.owns(caller, this.host.records[e.monitor_id] || {}) &&
                (!e.delivery_thread_id || e.delivery_thread_id === caller));
            if (pending.length)
                return { state: 'ready', reason: 'Reconcile existing events before waiting', event_ids: pending.slice(0, 8).map(e => e.id) };
            if (!selected.length || selected.some(key => !this.host.liveMonitor(key)))
                return { state: 'ready', reason: 'No verified live monitor is available for waiting' };
            if (selected.some(key => !this.host.guardedMonitor(key)))
                return { state: 'guard_required', reason: 'Every selected source needs live error/expiry guards (and SSH connection guards)' };
            // A descendant has priority over an ancestor, but never allow overlapping
            // delegated leases. The root's task-wide wait may coexist with either.
            if ([...this.blocks.values()].some(block => block.wait.monitor_ids.some((key) => selected.includes(key))))
                return { state: 'wait_active', reason: 'Another delegated wait already covers these monitors' };
            if (this.blocks.size >= 32)
                return { state: 'wait_active', reason: 'At most 32 delegated waits per task' };
        };
        const ready = readiness();
        if (ready)
            return { ...ready, goal_control: 'unchanged' };
        let wake, adopted = false;
        const route = this.members[caller];
        if (!route)
            throw Error('Unverified delegated caller');
        let observer;
        try {
            observer = await watchInputHistory(this.historyFile, [caller, ...route.ancestors], reason => {
                wake = reason;
                if (adopted)
                    this.release(caller, reason);
            }, interval);
        }
        catch {
            return { state: 'input_unavailable', goal_control: 'unchanged', reason: 'Readable CLI input history is required for delegated waiting' };
        }
        try {
            const bridge = await this.host.connect();
            await loaded(bridge, caller);
            const config = await bridge.rpc('config/read', { includeLayers: false });
            if (config.config?.history?.persistence === 'none')
                return { state: 'input_unavailable', goal_control: 'unchanged' };
            const parentUpdate = this.goals.get(this.host.threadId), ownUpdate = this.goals.get(caller);
            const goal = await getGoal(bridge, this.host.threadId), ownGoal = await getGoal(bridge, caller);
            if ([goal, ownGoal].some(g => g && (g.status !== 'active' || g.tokenBudget != null && g.tokensUsed >= g.tokenBudget)))
                return { state: 'goal_paused', goal_control: 'unchanged', reason: 'Parent or child goal is paused, ended or out of budget; preserve the stop' };
            const turn = await latestTurn(bridge, caller);
            if (this.host.closed || this.host.callbacksHeld() || signal?.aborted || wake || stamp !== this.stamp(caller) ||
                this.goals.get(this.host.threadId) !== parentUpdate && !sameGoal(goal, this.goals.get(this.host.threadId) ?? null) ||
                this.goals.get(caller) !== ownUpdate && !sameGoal(ownGoal, this.goals.get(caller) ?? null))
                return { state: 'released', reason: wake || (signal?.aborted ? 'client_disconnected' : 'agent_activity'), goal_control: 'unchanged' };
            if (turn?.status !== 'inProgress')
                return { state: 'turn_unavailable', goal_control: 'unchanged' };
            const again = readiness();
            if (again)
                return { ...again, goal_control: 'unchanged' };
            const waiting = { id: id(), caller_thread_id: caller, owner_thread_id: this.host.threadId,
                mode: 'blocking', state: 'waiting', turn_id: turn.id, monitor_ids: selected, wake_scope: scope,
                guard_ids: selected.filter(key => this.host.guardedMonitor(key)), instructions, started_at: now(), deadline: now() + timeout, goal_control: 'unchanged' };
            let resolve;
            const pending = new Promise(done => { resolve = done; });
            const abort = () => this.release(caller, 'client_disconnected');
            const timer = setTimeout(() => this.release(caller, 'timeout'), timeout);
            this.blocks.set(caller, { wait: waiting, parentGoal: goal, ownGoal, resolve, cleanup: () => { clearTimeout(timer); observer.close(); signal?.removeEventListener('abort', abort); } });
            this.waits[caller] = waiting;
            adopted = true;
            signal?.addEventListener('abort', abort, { once: true });
            try {
                this.host.save();
                this.check();
            }
            catch (error) {
                this.release(caller, 'persistence_failed', error);
            }
            return await pending;
        }
        finally {
            if (!adopted)
                observer.close();
        }
    }
    release(caller, reason, error) {
        this.invalidate(caller);
        const block = this.blocks.get(caller);
        if (!block)
            return;
        this.blocks.delete(caller);
        block.cleanup();
        const events = reason === 'monitor_event' ? Object.values(this.host.events).filter(e => this.deliverable(e, block.wait)).slice(0, 8) : [];
        for (const event of events)
            Object.assign(event, { state: 'returned', delivery_thread_id: caller, returned_at: now(), returned_turn: block.wait.turn_id, processing: 'unconfirmed' });
        Object.assign(block.wait, { state: reason === 'timeout' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'released',
            reason, released_at: now(), elapsed_ms: Math.max(0, now() - block.wait.started_at) });
        try {
            if (error)
                throw error;
            this.host.save();
        }
        catch (failure) {
            error = failure;
            for (const event of events)
                Object.assign(event, { state: 'unknown', error: 'Delivery persistence failed; reconcile before replay' });
            Object.assign(block.wait, { state: 'interrupted', reason: 'persistence_failed', error: bounded(failure) });
            this.host.holdCallbacks('Delivery persistence failed; reconcile monitor state before callbacks resume');
        }
        block.resolve(structuredClone({ ...block.wait, event_ids: events.map(e => e.id), events: events.map(e => this.host.eventView(e)) }));
        if (!error)
            this.host.requestFlush();
    }
    cancel(caller) {
        const wait = this.waits[caller];
        for (const key of wait?.monitor_ids || [])
            if (this.host.records[key])
                this.host.records[key].muted = true;
        for (const event of Object.values(this.host.events))
            if (event.state === 'pending' &&
                (event.affected_monitor_ids || [event.monitor_id]).every((key) => this.host.records[key]?.muted))
                event.state = 'suppressed';
        this.release(caller, 'cancelled');
        if (wait)
            Object.assign(wait, { state: 'cancelled', reason: 'cancelled' });
        this.host.save();
        return { state: 'cancelled', target: 'wait', goal_control: 'unchanged' };
    }
    registered(key) {
        for (const block of this.blocks.values())
            if (block.wait.wake_scope === 'thread' && this.owns(block.wait.caller_thread_id, this.host.records[key]))
                block.wait.monitor_ids.push(key);
    }
    ready(key) {
        for (const [caller, block] of this.blocks)
            if (block.wait.monitor_ids.includes(key)) {
                if (this.host.guardedMonitor(key)) {
                    if (!block.wait.guard_ids.includes(key))
                        block.wait.guard_ids.push(key);
                }
                else
                    this.release(caller, 'guard_changed');
            }
    }
    waitingFor(key) { return [...this.blocks.values()].find(b => b.wait.monitor_ids.includes(key))?.wait; }
    reserved(event) {
        return this.reservedByOther(this.host.threadId, event.monitor_id);
    }
    reservedByOther(caller, key) {
        return Object.values(this.host.events).some(e => e.state === 'returned' && e.expires_at > now() && e.delivery_thread_id &&
            e.delivery_thread_id !== this.host.threadId && e.delivery_thread_id !== caller && this.owns(e.delivery_thread_id, this.host.records[key] || {}));
    }
    deliverable(event, wait) {
        return event.state === 'pending' && event.expires_at > now() &&
            (event.affected_monitor_ids || [event.monitor_id]).some((key) => wait.monitor_ids.includes(key) && !this.host.records[key]?.muted && !this.reservedByOther(wait.caller_thread_id, key));
    }
    check() {
        for (const [caller, block] of this.blocks) {
            if (Object.values(this.host.events).some(e => this.deliverable(e, block.wait)))
                this.release(caller, 'monitor_event');
            else if (block.wait.monitor_ids.every((key) => !this.host.jobs.has(key)))
                this.release(caller, 'observers_ended');
        }
    }
    stopped(key) { for (const [caller, block] of this.blocks)
        if (block.wait.monitor_ids.includes(key))
            this.release(caller, 'monitor_stopped'); }
    handoff(caller, reason, turnId) {
        if (!turnId || this.blocks.get(caller)?.wait.turn_id === turnId)
            this.release(caller, reason);
        else if (!this.blocks.has(caller))
            this.invalidate(caller);
        for (const event of Object.values(this.host.events))
            if (event.state === 'returned' && event.delivery_thread_id === caller && (!turnId || event.returned_turn === turnId)) {
                const muted = (event.affected_monitor_ids || [event.monitor_id]).every((key) => this.host.records[key]?.muted);
                Object.assign(event, { state: muted ? 'suppressed' : 'pending', handoff: { from_thread_id: caller, reason, previous_delivery: 'unconfirmed', at: now() } });
                delete event.delivery_thread_id;
            }
        this.host.save();
        this.host.requestFlush();
    }
    notice(method, params) {
        const key = params.threadId, known = key === this.host.threadId || this.members[key] || this.registrations.has(key) || this.preparations.has(key) || Object.values(this.members).some(m => m.ancestors.includes(key));
        if (!known)
            return;
        if (method === 'item/completed' && params.item?.type === 'collabAgentToolCall') {
            if (['sendInput', 'sendMessage', 'followupTask', 'interruptAgent', 'closeAgent'].includes(params.item.tool))
                for (const target of params.item.receiverThreadIds || [])
                    if (this.members[target])
                        ['interruptAgent', 'closeAgent'].includes(params.item.tool) ? this.handoff(target, 'agent_stopped') : this.release(target, 'agent_input');
        }
        if (method === 'thread/queue/changed')
            this.release(key, 'agent_input');
        if (['thread/goal/updated', 'thread/goal/cleared'].includes(method)) {
            const goal = method === 'thread/goal/cleared' ? null : params.goal;
            const previous = this.goals.get(key);
            this.goals.set(key, goal);
            // thread/resume also publishes the current goal (including no goal).
            // An initial/unchanged snapshot is not a stop. Once a wait has a goal
            // baseline, explicit actions and meaningful changes still release it.
            const stoppedBeforeAttachment = goal ? goal.status !== 'active' ||
                previous !== undefined && params.turnId === null && !sameGoal(previous, goal) : previous != null;
            if (key === this.host.threadId) {
                for (const caller of Object.keys(this.members)) {
                    const block = this.blocks.get(caller);
                    if (block ? params.turnId === null || goal && goal.status !== 'active' || !sameGoal(block.parentGoal, goal) : stoppedBeforeAttachment)
                        this.release(caller, 'parent_stopped');
                }
            }
            else {
                const block = this.blocks.get(key);
                if (block ? params.turnId === null || goal && goal.status !== 'active' || !sameGoal(block.ownGoal, goal) : stoppedBeforeAttachment)
                    this.release(key, 'goal_changed');
            }
        }
        if (key === this.host.threadId) {
            if (method === 'turn/completed' && params.turn?.status === 'interrupted' ||
                ['thread/closed', 'thread/archived', 'thread/deleted'].includes(method)) {
                this.epoch++;
                for (const caller of Object.keys(this.members))
                    this.release(caller, 'parent_stopped');
            }
        }
        else if (method === 'turn/completed' || ['thread/closed', 'thread/archived', 'thread/deleted'].includes(method) ||
            method === 'thread/status/changed' && params.status?.type === 'notLoaded') {
            this.verified.delete(key);
            this.handoff(key, method === 'turn/completed' ? 'agent_turn_ended' : 'agent_closed', method === 'turn/completed' ? params.turn?.id : undefined);
            if (method !== 'turn/completed' || params.turn?.status === 'interrupted')
                for (const [caller, member] of Object.entries(this.members))
                    if (member.ancestors.includes(key)) {
                        this.verified.delete(caller);
                        this.handoff(caller, 'ancestor_stopped');
                    }
        }
    }
    disconnect() {
        this.epoch++;
        this.verified.clear();
        this.goals.clear();
        for (const caller of this.blocks.keys())
            this.release(caller, 'host_disconnected');
        for (const event of Object.values(this.host.events))
            if (event.state === 'returned' && event.delivery_thread_id && event.delivery_thread_id !== this.host.threadId)
                Object.assign(event, { state: 'unknown', error: 'Host disconnected during child handling; inspect effects before replay',
                    handoff: { from_thread_id: event.delivery_thread_id, previous_delivery: 'unconfirmed', reason: 'host_disconnected', at: now() } });
    }
}
// Also used for saved, read-only reports. A saved route never creates a service
// or establishes that its observers are still alive.
export function scopeSnapshot(snapshot, caller) {
    if (snapshot.thread_id === caller)
        return snapshot;
    const owned = (record) => record.creator_thread_id === caller || record.creator_ancestors?.includes(caller);
    const records = (Array.isArray(snapshot.monitors) ? snapshot.monitors : Object.values(snapshot.monitors || {})).filter(owned);
    const ids = new Set(records.map(r => r.id));
    const events = (Array.isArray(snapshot.events) ? snapshot.events : Object.values(snapshot.events || {}))
        .filter((e) => (e.affected_monitor_ids || [e.monitor_id]).every((key) => ids.has(key)));
    const waits = Array.isArray(snapshot.delegated_waits) ? snapshot.delegated_waits : Object.values(snapshot.delegated_waits || {});
    return { ...snapshot, thread_id: caller, owner_thread_id: snapshot.thread_id, monitors: records, events,
        wait: waits.find(w => w.caller_thread_id === caller) ?? null, delegated_waits: waits.filter(w => w.caller_thread_id === caller),
        members: undefined, goal_pause: undefined,
        changes: (snapshot.changes || []).filter((c) => c.category === 'monitor' && ids.has(c.id) || c.category === 'event' && events.some(e => e.id === c.id) || c.category === 'delegated_wait' && c.caller_thread_id === caller),
        recovery: { enabled: false, state: 'managed_by_owner', owner_thread_id: snapshot.thread_id }, callback_hold: snapshot.callback_hold };
}
