import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bounded } from './common.js';
import { Health } from './health.js';
import { SshFailure, SshSession, sshReadinessMs } from './ssh-session.js';
import { checkRemote, fileSample, gpuSample, processSample } from './ssh-samples.js';
export class SshPool {
    incident;
    connections = new Map();
    constructor(incident) {
        this.incident = incident;
    }
    start(id, kind, options, transport, emit, ended, update) {
        const key = JSON.stringify([transport.host, transport.user, transport.port, transport.identity_file, transport.config_file]);
        let connection = this.connections.get(key);
        if (connection?.reconnecting)
            throw Error('SSH target is reconnecting; reconcile its incident before registering more observers');
        if (connection && JSON.stringify(connection.transport) !== JSON.stringify(transport))
            throw Error('Shared SSH target has a different connection policy');
        if (!connection) {
            connection = new RemoteConnection(transport, this.incident, () => { if (this.connections.get(key) === connection)
                this.connections.delete(key); });
            this.connections.set(key, connection);
        }
        return connection.add(id, kind, options, emit, ended, update);
    }
    async close() { await Promise.allSettled([...this.connections.values()].map(c => c.close())); }
}
class RemoteConnection {
    transport;
    notify;
    removed;
    id = randomUUID();
    subscriptions = new Map();
    session;
    timer;
    incidentTimer;
    running = false;
    closed = false;
    closing;
    draining = Promise.resolve();
    nextConnect = 0;
    attempts = 0;
    incident;
    gpuCache = new Map();
    constructor(transport, notify, removed) {
        this.transport = transport;
        this.notify = notify;
        this.removed = removed;
    }
    get reconnecting() { return Boolean(this.incident && this.incident.stableAt === undefined); }
    add(id, kind, o, emit, ended, update) {
        let resolve, reject;
        const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
        const sub = { id, kind, o, emit, ended, update, resolve, reject, ready: false, stopped: false,
            deadline: performance.now() + o.timeout_ms, next: 0, gpuNext: 0, lastSample: 0, health: new Health(o, performance.now()), count: 0, fileNotifications: new Map(),
            timer: setTimeout(() => { this.send(sub, { event_type: 'monitor_expired' }); void this.stop(sub, 'deadline'); }, o.timeout_ms) };
        sub.readinessTimer = setTimeout(() => this.fail(sub, Error('SSH registration deadline reached before the initial sample')), sshReadinessMs(this.transport));
        this.subscriptions.set(id, sub);
        this.schedule(0);
        return { ready, stop: reason => this.stop(sub, reason || 'cancelled') };
    }
    send(sub, event) {
        if (sub.stopped)
            return;
        sub.emit({ ...event, remote: { host: this.transport.host, connection_id: this.id, generation: this.session?.generation }, sampled: true });
        sub.count++;
        if (sub.o.max_events && sub.count >= sub.o.max_events)
            void this.stop(sub, 'max_events');
    }
    state(sub, state, extra = {}) {
        if (!sub.stopped)
            sub.update({ state, connection: { id: this.id, host: this.transport.host,
                    state: state === 'armed' ? 'ready' : state, ...extra } });
    }
    fileChange(sub, event) {
        if (sub.stopped || sub.o.watchdog_only)
            return;
        const at = performance.now();
        if (event.change === 'deleted')
            sub.fileNotifications.delete(event.path);
        else {
            if (at - (sub.fileNotifications.get(event.path) ?? -Infinity) < sub.o.debounce_ms)
                return;
            sub.fileNotifications.set(event.path, at);
            if (sub.fileNotifications.size > 4096)
                sub.fileNotifications.delete(sub.fileNotifications.keys().next().value);
        }
        this.send(sub, event);
    }
    detach(sub, reason) {
        this.state(sub, 'stopping');
        sub.stopped = true;
        clearTimeout(sub.timer);
        clearTimeout(sub.readinessTimer);
        this.subscriptions.delete(sub.id);
        if (!sub.ready)
            sub.reject(Error(`SSH monitor ended before readiness: ${reason}`));
        return () => sub.ended({ reason, event_count: sub.count });
    }
    stop(sub, reason) {
        if (sub.stopped)
            return sub.stopping || Promise.resolve();
        const finish = this.detach(sub, reason);
        sub.stopping = (this.subscriptions.size ? Promise.resolve() : this.close()).then(finish);
        return sub.stopping;
    }
    schedule(ms) {
        clearTimeout(this.timer);
        if (!this.closed && !this.running)
            this.timer = setTimeout(() => void this.run(), Math.max(0, ms));
    }
    lost(session, error) {
        if (this.closed || this.session !== session)
            return;
        this.session = undefined;
        this.draining = Promise.all([this.draining, session.close()]).then(() => undefined);
        this.gpuCache.clear();
        // A start RPC must not wait for the incident's potentially long retry
        // budget and later attach an observer after the caller has timed out.
        for (const sub of [...this.subscriptions.values()])
            if (!sub.ready)
                this.fail(sub, error);
        if (this.closed)
            return;
        const ready = [...this.subscriptions.values()].filter(s => s.ready);
        // A failed initial registration is not a loss of established observation.
        if (!ready.length)
            return;
        const first = !this.incident;
        this.incident ??= { id: randomUUID(), start: performance.now() };
        this.incident.stableAt = undefined;
        clearTimeout(this.incidentTimer);
        this.incidentTimer = setTimeout(() => {
            if (!this.closed && this.incident && this.incident.stableAt === undefined)
                this.exhaust('SSH reconnect incident deadline reached');
        }, Math.max(0, this.incident.start + this.transport.reconnect.max_elapsed_ms - performance.now()));
        for (const sub of this.subscriptions.values())
            this.state(sub, 'reconnecting', { incident_id: this.incident.id, error: bounded(error) });
        if (first)
            this.notify(ready.map(s => s.id), { event_type: error.reason === 'connection_unresponsive' ? error.reason : 'connection_lost',
                connection_id: this.id, incident_id: this.incident.id, host: this.transport.host, reason: error.reason, error: bounded(error), workload_state: 'unknown' });
        if (!this.transport.reconnect.enabled || ['protocol_error', 'authentication_error'].includes(error.reason)) {
            this.exhaust(bounded(error));
            return;
        }
        const delays = [5000, 15000, 30000, 60000], delay = delays[Math.min(this.attempts++, 3)];
        this.nextConnect = performance.now() + delay * (0.9 + Math.random() * 0.2);
        this.schedule(this.nextConnect - performance.now());
    }
    fail(sub, error) {
        this.send(sub, { event_type: 'monitor_error', error: bounded(error) });
        void this.stop(sub, 'monitor_error');
    }
    exhaust(reason) {
        this.notify([...this.subscriptions.keys()], { event_type: 'monitor_error', connection_id: this.id,
            incident_id: this.incident?.id, host: this.transport.host, reason: 'reconnect_stopped', error: reason });
        for (const sub of [...this.subscriptions.values()])
            void this.stop(sub, 'connection_failed');
    }
    async run() {
        if (this.closed || this.running)
            return;
        this.running = true;
        try {
            if (this.incident && !this.session && performance.now() - this.incident.start >= this.transport.reconnect.max_elapsed_ms) {
                this.exhaust('SSH reconnect incident deadline reached');
                return;
            }
            if (!this.session) {
                if (performance.now() < this.nextConnect)
                    return;
                const session = new SshSession(this.transport);
                this.session = session;
                session.on('lost', e => this.lost(session, e));
                try {
                    await session.open();
                }
                catch (e) {
                    this.lost(session, e instanceof SshFailure ? e : new SshFailure(bounded(e), 'protocol_error'));
                    return;
                }
                if (this.closed || this.session !== session)
                    return;
            }
            const session = this.session;
            for (const [key, value] of this.gpuCache)
                if (performance.now() - value.at >= 1000)
                    this.gpuCache.delete(key);
            for (const sub of [...this.subscriptions.values()]) {
                if (this.closed || this.session !== session)
                    break;
                if (sub.stopped || performance.now() < sub.next && sub.generation === session.generation)
                    continue;
                try {
                    await this.sample(sub, session);
                }
                catch (e) {
                    if (e instanceof SshFailure) {
                        this.lost(session, e);
                        break;
                    }
                    else
                        this.fail(sub, e);
                }
            }
            if (this.closed || this.session !== session)
                return;
            if (performance.now() - session.lastResponseAt >= this.transport.heartbeat_ms) {
                const reply = await session.request('printf alive');
                if (reply.code || reply.data.toString() !== 'alive')
                    throw new SshFailure('SSH idle probe failed', 'protocol_error');
            }
            if (this.incident) {
                this.incident.stableAt ??= performance.now();
                if (performance.now() - this.incident.stableAt >= 60000) {
                    this.notify([...this.subscriptions.keys()], { event_type: 'connection_restored', connection_id: this.id,
                        incident_id: this.incident.id, host: this.transport.host, observation_gap: true });
                    clearTimeout(this.incidentTimer);
                    this.incident = undefined;
                    this.attempts = 0;
                }
            }
        }
        catch (e) {
            if (this.session)
                this.lost(this.session, e instanceof SshFailure ? e : new SshFailure(bounded(e)));
        }
        finally {
            this.running = false;
            const next = this.session ? Math.min(...[...this.subscriptions.values()].map(s => s.next), this.session.lastResponseAt + this.transport.heartbeat_ms) : this.nextConnect;
            const cap = this.incident && !this.session ? this.incident.start + this.transport.reconnect.max_elapsed_ms : Infinity;
            this.schedule(Math.max(100, Math.min(next, cap) - performance.now()));
        }
    }
    async sample(sub, session) {
        const o = sub.o;
        const metadataInterval = sub.kind === 'connection' ? this.transport.heartbeat_ms
            : o.watch_file || o.watch_directory || o.pid ? o.poll_ms : Infinity;
        const interval = Math.min(metadataInterval, o.gpu_util_below != null ? o.gpu_sample_ms : Infinity);
        // The process can be suspended while a query is outstanding. Check again
        // after awaited reads, before using their data as proof of continuous dwell.
        const hasGap = () => sub.ready && (sub.generation !== session.generation || performance.now() - sub.lastSample > interval * 2 + this.transport.query_timeout_ms * 4);
        let gap = hasGap();
        if (sub.generation !== session.generation)
            await checkRemote(session, sub.kind, o);
        if (sub.stopped || this.session !== session)
            return;
        if (sub.kind === 'connection') {
            const response = await session.request('printf alive');
            if (response.code || response.data.toString() !== 'alive')
                throw new SshFailure('SSH connection probe failed', 'protocol_error');
            if (sub.stopped || this.session !== session)
                return;
        }
        gap ||= hasGap();
        let gpuValues;
        let processState;
        if (o.pid) {
            processState = await processSample(session, o.pid);
            if (sub.stopped)
                return;
            gap ||= hasGap();
            if (!sub.ready && (!processState || ['Z', 'X'].includes(processState.state)))
                throw Error('Remote PID is not running');
            if (sub.identity && (!processState || processState.identity !== sub.identity || ['Z', 'X'].includes(processState.state))) {
                this.send(sub, { event_type: 'process_exit', pid: o.pid, identity: sub.identity, observation_gap: gap, exit_code: null });
                await this.stop(sub, 'process_exit');
                return;
            }
            sub.identity = processState?.identity;
        }
        if (o.watch_file || o.watch_directory) {
            const files = await fileSample(session, o);
            if (sub.stopped)
                return;
            gap ||= hasGap();
            if (gap)
                sub.fileNotifications.clear();
            if (sub.files && sub.files.identity !== files.identity)
                throw Error('Remote watch root identity changed; inspect before rearming');
            if (sub.files) {
                for (const [file, meta] of files.entries)
                    if (sub.files.entries.get(file) !== meta) {
                        if (meta.startsWith('f:') && !gap)
                            sub.health.progress(performance.now());
                        this.fileChange(sub, { event_type: 'file_change', path: file, change: sub.files.entries.has(file) ? 'modified' : 'created', observation_gap: gap });
                    }
                for (const file of sub.files.entries.keys())
                    if (!files.entries.has(file))
                        this.fileChange(sub, { event_type: 'file_change', path: file, change: 'deleted', observation_gap: gap });
            }
            sub.files = files;
        }
        if (sub.stopped || this.session !== session)
            return;
        gap ||= hasGap();
        if (gap)
            sub.gpuNext = 0;
        if (o.gpu_util_below != null && performance.now() >= sub.gpuNext) {
            const key = JSON.stringify([o.cwd, o.nvidia_smi, o.gpu_id]);
            let cached = this.gpuCache.get(key);
            if (!cached || performance.now() - cached.at >= Math.min(o.gpu_sample_ms, 1000)) {
                const data = await gpuSample(session, o);
                cached = { at: performance.now(), data };
                this.gpuCache.set(key, cached);
            }
            if (sub.stopped)
                return;
            gpuValues = cached.data;
            sub.gpuNext = performance.now() + o.gpu_sample_ms;
        }
        if (sub.stopped || this.session !== session)
            return;
        gap ||= hasGap();
        // Initial enumeration and reconnect never count as continuous progress.
        if (!sub.ready || gap)
            sub.health = new Health(o, performance.now());
        if (gpuValues)
            sub.health.gpu(performance.now(), gpuValues);
        if (sub.ready && !gap) {
            const event = sub.health.tick(performance.now());
            if (event && (event.event_type === 'watchdog_stalled' || o.report_recovery))
                this.send(sub, { ...event, observation_gap: gap });
        }
        if (sub.stopped)
            return;
        sub.generation = session.generation;
        sub.lastSample = performance.now();
        sub.next = sub.lastSample + Math.min(metadataInterval, o.gpu_util_below != null ? Math.max(0, sub.gpuNext - sub.lastSample) : Infinity);
        this.state(sub, 'armed', { generation: session.generation, last_sample_at: Date.now(), observation_gap: gap });
        if (!sub.ready) {
            sub.ready = true;
            clearTimeout(sub.readinessTimer);
            sub.resolve({ backend: 'ssh-polling', connection_id: this.id, observed_pid: o.pid });
        }
    }
    close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        clearTimeout(this.timer);
        clearTimeout(this.incidentTimer);
        this.removed();
        const pending = [...this.subscriptions.values()].map(sub => ({ sub, finish: this.detach(sub, 'service_shutdown') }));
        const session = this.session;
        this.session = undefined;
        const cleanup = Promise.all([this.draining, session?.close()]).then(() => undefined);
        for (const { sub, finish } of pending)
            sub.stopping = cleanup.then(finish);
        this.closing = Promise.all([cleanup, ...pending.map(({ sub }) => sub.stopping)]).then(() => undefined);
        return this.closing;
    }
}
