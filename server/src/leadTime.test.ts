import { describe, expect, it } from 'vitest';
import { autoLeadMs } from './leadTime';

describe('autoLeadMs', () => {
  it('falls back to the default with no RTT data', () => {
    expect(autoLeadMs([], 2000)).toBe(2000);
  });
  it('never goes below 1500 ms on fast networks', () => {
    expect(autoLeadMs([5, 12, 20])).toBe(1500);
  });
  it('scales as 4 x worst RTT + 500', () => {
    expect(autoLeadMs([50, 300, 120])).toBe(1700);
    expect(autoLeadMs([600])).toBe(2900);
  });
  it('caps at 4000 ms', () => {
    expect(autoLeadMs([2000])).toBe(4000);
  });
  it('ignores invalid samples', () => {
    expect(autoLeadMs([Number.NaN, -1, 400])).toBe(2100);
  });
});
