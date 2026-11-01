import { z } from 'zod';
const str = (max = 4096) => z.string().min(1).max(max).refine(x => Boolean(x.trim()), 'Must contain non-whitespace text');
const int = (min, max) => z.number().int().min(min).max(max);
const week = 604800000;
export const eventSchema = z.enum(['command_output', 'file_change', 'command_exit', 'process_exit', 'watchdog_stalled', 'watchdog_recovered', 'monitor_error', 'monitor_expired']);
export const defaultEvents = eventSchema.options.filter(x => x !== 'watchdog_recovered');
export const eventReviewSchema = z.strictObject({
    event_ids: z.array(z.string().uuid()).min(1).max(8).describe('Exact IDs from the native callback; at most eight events.'),
    resolution: str(1000).optional().describe('Omit to inspect. Supply only after handling or deliberately dismissing these events; acknowledges them and returns final status.'),
});
const shared = {
    cwd: str().describe('Absolute workload directory. Relative watched paths resolve here.'),
    timeout_ms: int(1, week).optional().describe('Finite observer lifetime in milliseconds; default 1800000.'),
    max_events: int(0, week).optional().describe('Stop after this many sensor events; 0 means no event-count limit.'),
    debounce_ms: int(0, week).optional(),
};
export const commandOptions = z.strictObject({ ...shared,
    timeout_ms: int(1, 1800000).optional().describe('Owned command lifetime; default and maximum 30 minutes.'),
    command: str(16000).describe('Shell command owned by this monitor; stopped on cancel or expiry.'),
    match: str(1000).optional().describe('Optional JavaScript regex for output events; omitted means exit-only monitoring.'),
    encoding: str().optional(),
});
export const watchdogOptions = z.strictObject({ ...shared,
    watch_file: str().optional(), watch_directory: str().optional(), recursive: z.boolean().optional(), pattern: str().optional(),
    file_backend: z.enum(['auto', 'native', 'polling']).optional(), poll_ms: int(10, week).optional(),
    stalled_for_ms: int(1, week).optional().describe('Time without file progress before suspected stall; requires a file/directory source.'),
    warmup_ms: int(0, week).optional(), pid: int(1, 2147483647).optional().describe('Existing PID to observe; never terminated.'),
    gpu_util_below: int(0, 100).optional(), gpu_recover_above: int(0, 100).optional(),
    gpu_below_for_ms: int(10, week).optional(), gpu_sample_ms: int(10, week).optional(),
    gpu_id: str(1000).optional(), gpu_match: z.enum(['all', 'any']).optional(), nvidia_smi: str().optional(),
    dead_if: z.enum(['all', 'any']).optional(), watchdog_only: z.boolean().optional(), report_recovery: z.boolean().optional(),
});
export const monitorSchema = z.strictObject({
    name: str(100), kind: z.enum(['command', 'watchdog']).optional().describe('Inferred from options.command when omitted.'),
    options: z.union([commandOptions, watchdogOptions]), instructions: str(2000),
    notify_on: z.array(eventSchema).min(1).optional(), event_ttl_ms: int(1000, week).optional(),
});
export const recoverySchema = z.strictObject({
    enabled: z.boolean(), authorization: str(2000).optional().describe('Quote applicable user authorization when enabling.'),
    retry_mode: z.enum(['transient', 'all_failed']).optional().describe('Default transient; all_failed requires authorization for unlisted failed-turn retries.'),
    retry_interval_ms: int(1000, 3600000).optional().describe('Fixed interval; default 300000 ms (5 minutes).'),
    max_elapsed_ms: int(1000, 86400000).optional().describe('Incident deadline; default 10800000 ms (3 hours).'),
    max_attempts: int(1, 86400).optional().describe('Optional earlier cap; default ceil(max_elapsed_ms / retry_interval_ms).'),
    lifetime_ms: int(1000, week).optional().describe('Supervisor lifetime; default 86400000 ms (24 hours).'),
    check_interval_ms: int(1000, 300000).optional(), retry_rate_limits: z.boolean().optional(),
    base_delay_ms: int(1000, 3600000).optional().describe('Deprecated alias for retry_interval_ms.'),
    max_delay_ms: int(1000, 3600000).optional().describe('Legacy validation only; must be at least the fixed interval.'),
});
export function recoveryPolicy(raw) {
    const config = recoverySchema.parse(raw);
    if (!config.enabled)
        return { config, policy: undefined };
    if (!config.authorization)
        throw Error('authorization must quote explicit user permission to retry this session');
    const interval = config.retry_interval_ms ?? config.base_delay_ms ?? 300000;
    const elapsed = config.max_elapsed_ms ?? 10800000;
    if (config.base_delay_ms != null && config.base_delay_ms !== interval)
        throw Error('base_delay_ms conflicts with retry_interval_ms');
    if (config.max_delay_ms != null && config.max_delay_ms < interval)
        throw Error('max_delay_ms must be >= retry_interval_ms');
    return { config, policy: { retry_mode: config.retry_mode ?? 'transient', retry_interval_ms: interval,
            max_elapsed_ms: elapsed, max_attempts: config.max_attempts ?? Math.ceil(elapsed / interval),
            lifetime_ms: config.lifetime_ms ?? 86400000, check_interval_ms: config.check_interval_ms ?? 30000,
            retry_rate_limits: config.retry_rate_limits ?? false } };
}
export const validationSchema = z.strictObject({
    request: z.discriminatedUnion('operation', [
        z.strictObject({ operation: z.literal('start'), config: monitorSchema }),
        z.strictObject({ operation: z.literal('recovery'), config: recoverySchema }),
    ]),
    check_host: z.boolean().optional().describe('Also verify local daemon and exact loaded thread; default true. Never resumes or starts a turn.'),
});
export const validationOutput = z.object({
    valid: z.boolean(), checked_at: z.number(), operation: z.enum(['start', 'recovery']),
    normalized: z.record(z.string(), z.unknown()).nullable(),
    checks: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'skipped']), message: z.string() })),
    errors: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })), warnings: z.array(z.string()),
});
