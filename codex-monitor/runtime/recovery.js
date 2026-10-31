import { getGoal, latestTurn, loaded, sameGoal, submit, RpcError } from './bridge.js';
import { bounded, id, integer, now, text } from './common.js';
export function retryable(error, allowRateLimit = false) {
    const code = error?.codexErrorInfo;
    if (typeof code === 'string') {
        // Codex 0.166.0 can flatten transport failures and provider-busy stream
        // errors into `other`. Accept only observed signatures, not arbitrary text.
        if (code === 'other') {
            const message = error?.message;
            if (typeof message !== 'string')
                return false;
            if (/^stream disconnected before completion: Transport error: network error: /i.test(message))
                return true;
            if (message === 'stream disconnected before completion: Our servers are currently busy. Please try again in a moment.')
                return true;
        }
        return ['serverOverloaded', 'internalServerError', 'flexUnavailable', ...(allowRateLimit ? ['rateLimitExceeded'] : [])].includes(code);
    }
    if (!code || typeof code !== 'object')
        return false;
    const keys = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'];
    const key = keys.find(k => k in code);
    if (!key)
        return false;
    const status = code[key]?.httpStatusCode;
    return status == null || status === 408 || (status >= 500 && status <= 599) || (allowRateLimit && status === 429);
}
export class Recovery {
    threadId;
    connect;
    save;
    waiting;
    state = { enabled: false, state: 'disabled' };
    timer;
    busy = false;
    epoch = 0;
    currentRetry;
    constructor(threadId, connect, save, waiting, restored) {
        this.threadId = threadId;
        this.connect = connect;
        this.save = save;
        this.waiting = waiting;
        if (restored)
            this.state = { ...restored, enabled: false, state: 'interrupted', reason: 'Service restarted; explicit re-enable required', next_retry_at: null };
    }
    async configure(config) {
        if (!config.enabled) {
            this.epoch++;
            clearTimeout(this.timer);
            this.state = { ...this.state, enabled: false, state: 'disabled', next_retry_at: null };
            this.save();
            return this.snapshot();
        }
        const authorization = text(config.authorization, 'Explicit authorization to retry this session');
        const policy = {
            max_attempts: integer(config.max_attempts ?? 5, 'max_attempts', 1, 20),
            base_delay_ms: integer(config.base_delay_ms ?? 15000, 'base_delay_ms', 1000, 3600000),
            max_delay_ms: integer(config.max_delay_ms ?? 300000, 'max_delay_ms', 1000, 3600000),
            max_elapsed_ms: integer(config.max_elapsed_ms ?? 1800000, 'max_elapsed_ms', 1000, 86400000),
            lifetime_ms: integer(config.lifetime_ms ?? 86400000, 'lifetime_ms', 1000, 604800000),
            check_interval_ms: integer(config.check_interval_ms ?? 30000, 'check_interval_ms', 1000, 300000),
            retry_rate_limits: config.retry_rate_limits === true,
        };
        if (policy.max_delay_ms < policy.base_delay_ms)
            throw Error('max_delay_ms must be >= base_delay_ms');
        const epoch = ++this.epoch;
        clearTimeout(this.timer);
        this.state = { ...this.state, enabled: false, state: 'configuring', next_retry_at: null };
        this.save();
        const bridge = await this.connect();
        await loaded(bridge, this.threadId);
        const latest = await latestTurn(bridge, this.threadId);
        if (epoch !== this.epoch)
            return this.snapshot();
        this.currentRetry = undefined;
        this.state = { enabled: true, state: 'observing', policy, authorization, attempts: 0,
            deadline: now() + policy.lifetime_ms, configured_at: now(), baseline_turn: latest?.id, next_retry_at: null };
        // Enabling after a manual interrupt does not restart that old turn.
        if (latest?.status === 'interrupted')
            this.state.ignore_turn = latest.id;
        this.save();
        this.schedule(0);
        return this.snapshot();
    }
    snapshot() { const { authorization, ...state } = this.state; return structuredClone(state); }
    schedule(ms) { clearTimeout(this.timer); if (this.state.enabled)
        this.timer = setTimeout(() => void this.check(), ms); }
    halt(reason, state = 'stopped') {
        this.epoch++;
        clearTimeout(this.timer);
        Object.assign(this.state, { enabled: false, state, reason, next_retry_at: null });
        this.save();
    }
    notice(method, params) {
        if (!this.state.enabled || params.threadId !== this.threadId)
            return;
        if (method === 'turn/completed' && params.turn?.status === 'interrupted') {
            this.halt('Turn interrupted; never retry an interruption', 'cancelled');
            return;
        }
        if (method === 'thread/goal/updated' && params.goal?.status !== 'active') {
            if (this.waiting()) {
                this.state.state = 'waiting';
                this.save();
                return;
            }
            this.halt(`Goal is ${params.goal?.status}; re-enable explicitly after resuming`, 'cancelled');
            return;
        }
        if (method === 'thread/goal/cleared' || method === 'thread/closed' || method === 'thread/archived') {
            this.halt('Thread or goal was closed', 'cancelled');
            return;
        }
        if (method === 'turn/completed' || method === 'turn/started')
            this.schedule(0);
        // willRetry=true is handled by Codex. Only a verified terminal failed turn qualifies.
    }
    async check() {
        if (!this.state.enabled || this.busy)
            return;
        this.busy = true;
        const epoch = this.epoch;
        try {
            if (now() >= this.state.deadline) {
                this.halt('Recovery lifetime expired', 'expired');
                return;
            }
            if (this.waiting()) {
                this.state.state = 'waiting';
                return;
            }
            const bridge = await this.connect();
            await loaded(bridge, this.threadId);
            const [turn, goal, meta] = await Promise.all([latestTurn(bridge, this.threadId), getGoal(bridge, this.threadId), bridge.rpc('thread/read', { threadId: this.threadId })]);
            if (epoch !== this.epoch || !this.state.enabled)
                return;
            if (goal && (goal.status !== 'active' || (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget))) {
                this.halt('Goal paused, ended, edited to a terminal state, or budget exhausted', 'cancelled');
                return;
            }
            if (this.state.incident_started_at && !sameGoal(this.state.goal, goal)) {
                this.halt('Goal changed during recovery; re-enable explicitly', 'cancelled');
                return;
            }
            if (turn?.status === 'interrupted' && turn.id !== this.state.ignore_turn) {
                this.halt('Turn interrupted; user intent takes precedence', 'cancelled');
                return;
            }
            if (meta.thread?.status?.type === 'active' || turn?.status === 'inProgress') {
                this.state.state = 'observing';
                return;
            }
            if (turn?.id === this.state.submitted_for_turn) {
                // A successful write is not permission to submit it again while the
                // host's latest-turn snapshot catches up. Only a new failure can retry.
                this.state.state = 'awaiting_host';
                this.state.next_retry_at = null;
                return;
            }
            if (!turn || turn.id === this.state.ignore_turn || turn.status !== 'failed') {
                if (turn?.status === 'completed') {
                    this.state.attempts = 0;
                    this.state.incident_started_at = null;
                    this.state.failed_turn = null;
                }
                this.state.state = 'observing';
                this.state.next_retry_at = null;
                return;
            }
            if (!retryable(turn.error, this.state.policy.retry_rate_limits)) {
                this.state.state = 'not_retryable';
                this.state.reason = 'Terminal error is outside the transient-error allowlist';
                this.state.next_retry_at = null;
                return;
            }
            if (this.state.failed_turn !== turn.id) {
                const continuation = turn.id === this.currentRetry || turn.rootTurnId === this.state.root_turn;
                if (!continuation) {
                    this.state.attempts = 0;
                    this.state.incident_started_at = now();
                }
                Object.assign(this.state, { failed_turn: turn.id, root_turn: turn.rootTurnId || turn.id,
                    incident_started_at: this.state.incident_started_at || now(), goal,
                    next_retry_at: now() + Math.min(this.state.policy.max_delay_ms, this.state.policy.base_delay_ms * 2 ** this.state.attempts) });
            }
            if (this.state.attempts >= this.state.policy.max_attempts || now() - this.state.incident_started_at >= this.state.policy.max_elapsed_ms) {
                this.halt('Retry count or incident time limit reached', 'exhausted');
                return;
            }
            this.state.state = 'backoff';
            if (now() < this.state.next_retry_at)
                return;
            // Recheck immediately before writing. There is no host atomic compare-and-start API.
            const [current, currentGoal, currentMeta] = await Promise.all([latestTurn(bridge, this.threadId), getGoal(bridge, this.threadId), bridge.rpc('thread/read', { threadId: this.threadId })]);
            if (epoch !== this.epoch || this.waiting() || !this.state.enabled)
                return;
            if (!current || current.id !== turn.id || current.status !== 'failed' || currentMeta.thread?.status?.type === 'active' || !sameGoal(goal, currentGoal)) {
                this.state.next_retry_at = null;
                this.state.failed_turn = null;
                return;
            }
            this.state.attempts++;
            this.state.state = 'submitting';
            this.state.next_retry_at = null;
            this.state.retry_id = id();
            this.save();
            try {
                const result = await submit(bridge, this.threadId, { type: 'session_recovery', recovery_id: this.state.retry_id,
                    failed_turn_id: turn.id, error: turn.error, attempt: this.state.attempts,
                    instruction: 'Resume the existing task after a transient host error. Reconcile completed tools and external effects before retrying work. Do not restart a training process merely because the conversation failed.' }, this.state.root_turn);
                if (epoch !== this.epoch || !this.state.enabled)
                    return;
                this.currentRetry = result.turn?.id;
                Object.assign(this.state, { state: 'submitted', submitted_for_turn: turn.id, submitted_turn: this.currentRetry, last_submission_at: now() });
            }
            catch (e) {
                // A timeout may already have started a turn. Never repeat uncertain lifecycle writes.
                if (epoch === this.epoch)
                    this.halt(bounded(e), e instanceof RpcError && e.uncertain ? 'unknown' : 'failed');
            }
        }
        catch (e) {
            if (epoch === this.epoch && this.state.enabled) {
                this.state.connection_error = bounded(e);
                this.state.state = 'connection_unavailable';
            }
            // These timer retries only reconnect/read the host, and never call the model blindly.
        }
        finally {
            this.busy = false;
            this.save();
            if (this.state.enabled)
                this.schedule(Math.max(100, Math.min(this.state.policy.check_interval_ms, this.state.next_retry_at ? this.state.next_retry_at - now() : this.state.policy.check_interval_ms)));
        }
    }
    close() { clearTimeout(this.timer); this.epoch++; this.state.enabled = false; }
}
