import { describe, expect, it } from 'vitest';
import { niceTicks, tickFormat } from './chartUtils';

describe('chart ticks', () => {
  it('picks round steps', () => {
    expect(niceTicks(0, 10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(-0.3, 0.4, 4)).toEqual([-0.2, 0, 0.2, 0.4]);
  });
  it('formats with as many decimals as the step needs', () => {
    expect([0, 0.25, 0.5, 0.75].map(tickFormat([0, 0.25]))).toEqual([
      '0.00',
      '0.25',
      '0.50',
      '0.75',
    ]);
    expect([0, 0.025].map(tickFormat([0, 0.025]))).toEqual(['0.000', '0.025']);
    expect([0, 50].map(tickFormat([0, 50]))).toEqual(['0', '50']);
  });
});
