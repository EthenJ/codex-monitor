import { z } from 'zod';

export const MONITOR_LIMIT = 32;
export const MONITOR_WARNING_AT = 24;
export const CAPACITY_ERROR = 'MONITOR_CAPACITY_EXCEEDED';
export const capacitySchema = z.object({
  used: z.number().int().min(0), limit: z.literal(MONITOR_LIMIT),
  warning_at: z.literal(MONITOR_WARNING_AT), remaining: z.number().int().min(0),
  state: z.enum(['normal', 'warning', 'full']),
});
export type Capacity = z.infer<typeof capacitySchema>;
export function monitorCapacity(used: number): Capacity {
  return { used, limit: MONITOR_LIMIT, warning_at: MONITOR_WARNING_AT,
    remaining: Math.max(0, MONITOR_LIMIT - used),
    state: used >= MONITOR_LIMIT ? 'full' : used >= MONITOR_WARNING_AT ? 'warning' : 'normal' };
}
export function capacityWarning(capacity?: Capacity | null): string {
  return capacity && capacity.state !== 'normal'
    ? `${capacity.used}/${capacity.limit} slots in use · review obsolete and overlapping monitors` : '';
}
export const consolidationGuidance = [
  'Inspect active monitor details and their source/rules before retrying. Reuse equivalent registrations and reconcile obsolete observers and handled events.',
  'Consolidate only compatible sources with the same workload and handling policy. Preserve per-workload inactivity detection, deadlines, pending evidence and wait guards; shared directories or similar names alone do not establish equivalence.',
  'Verify replacement coverage before stopping an observer. Stopping an owned command kills its command tree; do not stop required workloads to free slots. Deleting inactive history does not free observer slots.',
];
export class MonitorCapacityError extends Error {
  readonly code = CAPACITY_ERROR;
  readonly guidance = consolidationGuidance;
  constructor(public capacity: Capacity) {
    super(`Monitor limit reached (${capacity.used}/${capacity.limit}). Reuse an existing monitor, reconcile obsolete observers, or consolidate compatible sources before retrying. Do not stop required workloads to free slots.`);
  }
}
