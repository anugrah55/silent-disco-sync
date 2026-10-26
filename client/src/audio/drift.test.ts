import { describe, expect, it } from 'vitest';
import { DRIFT, Ring, decideDrift, wrappedDiff } from './drift';

describe('decideDrift', () => {
  it('ignores small drift', () => {
    expect(decideDrift(0, false)).toEqual({ kind: 'none' });
    expect(decideDrift(14.9, false)).toEqual({ kind: 'none' });
    expect(decideDrift(-14.9, false)).toEqual({ kind: 'none' });
  });

  it('slows down when ahead and speeds up when behind, capped at 0.3%', () => {
    const ahead = decideDrift(40, false);
    const behind = decideDrift(-40, false);
    expect(ahead).toEqual({ kind: 'rate', rate: 1 - DRIFT.maxRateDelta });
    expect(behind).toEqual({ kind: 'rate', rate: 1 + DRIFT.maxRateDelta });
    const gentle = decideDrift(10, true) as { kind: 'rate'; rate: number };
    expect(gentle.rate).toBeCloseTo(1 - 0.01 / DRIFT.correctOverSec, 9);
  });

  it('keeps correcting below 15 ms until settled under 3 ms (hysteresis)', () => {
    expect(decideDrift(8, true).kind).toBe('rate');
    expect(decideDrift(2, true)).toEqual({ kind: 'settle' });
  });

  it('re-schedules above 80 ms', () => {
    expect(decideDrift(81, false)).toEqual({ kind: 'reschedule' });
    expect(decideDrift(-500, true)).toEqual({ kind: 'reschedule' });
  });

  it('a capped correction removes 6 ms per 2 s check', () => {
    const r = decideDrift(50, false) as { kind: 'rate'; rate: number };
    expect((1 - r.rate) * DRIFT.checkEveryMs).toBeCloseTo(6, 9);
  });
});

describe('wrappedDiff', () => {
  it('takes the short way round a loop', () => {
    expect(wrappedDiff(7.99, 0.01, 8)).toBeCloseTo(-0.02, 9);
    expect(wrappedDiff(0.01, 7.99, 8)).toBeCloseTo(0.02, 9);
    expect(wrappedDiff(5, 3, null)).toBe(2);
  });
});

describe('Ring', () => {
  it('keeps only the newest entries', () => {
    const r = new Ring<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => r.push(n));
    expect(r.toArray()).toEqual([3, 4, 5]);
  });
});
