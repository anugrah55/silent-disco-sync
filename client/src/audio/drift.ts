/**
 * Drift control policy (pure, unit-tested). Checked every 2 s while playing:
 *
 *   |drift| < 15 ms   leave it (unless already correcting, then until < 3 ms)
 *   15 - 80 ms        nudge playbackRate by up to ±0.3% until it is back
 *   > 80 ms           hard re-schedule at the next boundary
 *
 * A 0.3% rate change is about 5 cents of pitch, below what listeners notice
 * on music (the just-noticeable difference is ~10-25 cents), yet it removes
 * 6 ms of drift every 2 s.
 */
export const DRIFT = {
  checkEveryMs: 2000,
  ignoreBelowMs: 15,
  settleBelowMs: 3,
  rescheduleAboveMs: 80,
  maxRateDelta: 0.003,
  /** Aim to remove the drift over this long (before the rate cap applies). */
  correctOverSec: 5,
} as const;

export type DriftAction =
  { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'settle' } | { kind: 'reschedule' };

/** drift > 0 means this device is ahead of where it should be. */
export function decideDrift(driftMs: number, correcting: boolean): DriftAction {
  const abs = Math.abs(driftMs);
  if (abs > DRIFT.rescheduleAboveMs) return { kind: 'reschedule' };
  if (correcting && abs < DRIFT.settleBelowMs) return { kind: 'settle' };
  if (!correcting && abs < DRIFT.ignoreBelowMs) return { kind: 'none' };
  const delta = Math.max(
    -DRIFT.maxRateDelta,
    Math.min(DRIFT.maxRateDelta, driftMs / 1000 / DRIFT.correctOverSec),
  );
  // Ahead -> play slower; behind -> play faster.
  return { kind: 'rate', rate: 1 - delta };
}

/** Signed difference a - b on a loop of length `period` (seconds), in (-period/2, period/2]. */
export function wrappedDiff(a: number, b: number, period: number | null): number {
  const d = a - b;
  if (!period) return d;
  return d - period * Math.round(d / period);
}

export interface CorrectionLogEntry {
  at: number;
  kind: 'rate' | 'settle' | 'reschedule' | 'reanchor';
  driftMs: number;
  rate: number;
  source: 'track' | 'live';
}

/** Fixed-size ring buffer for the Sync Lab's corrections list. */
export class Ring<T> {
  private items: T[] = [];
  constructor(private readonly size: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.size) this.items.shift();
  }
  toArray(): T[] {
    return [...this.items];
  }
}

/** Every correction on this device (track and live), newest last. */
export const correctionLog = new Ring<CorrectionLogEntry>(100);
/** Measured drift every check, for the Sync Lab chart. */
export const driftLog = new Ring<{ at: number; driftMs: number; rate: number }>(180);
