import { LEAD } from '@sds/shared';

/**
 * Lead time = how far in the future a command takes effect. It has to cover
 * the slowest client's one-way delay plus decode/scheduling slack, so we size
 * it from the worst round trip: max(1500, 4 * worstRtt + 500), capped at 4 s.
 * With no RTT data yet we fall back to the configured default.
 */
export function autoLeadMs(rtts: readonly number[], fallbackMs: number = LEAD.defaultMs): number {
  const valid = rtts.filter((r) => Number.isFinite(r) && r >= 0);
  if (valid.length === 0) return fallbackMs;
  const worst = Math.max(...valid);
  return Math.round(Math.min(LEAD.maxMs, Math.max(LEAD.minMs, 4 * worst + 500)));
}
