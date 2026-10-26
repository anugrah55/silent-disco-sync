import { describe, expect, it } from 'vitest';
import { upsampleChunk } from './receiver';

describe('upsampleChunk', () => {
  it('produces exactly chunk-duration samples at the target rate', () => {
    expect(upsampleChunk(new Float32Array(2400), 0, 24000, 48000, 0.1)).toHaveLength(4800);
    expect(upsampleChunk(new Float32Array(2400), 0, 24000, 44100, 0.1)).toHaveLength(4410);
  });

  it('joins consecutive chunks of a sine without a step at the boundary', () => {
    const from = 24000;
    const to = 44100;
    const sine = (k: number) => 0.5 * Math.sin((2 * Math.PI * 440 * k) / from);
    let prev = 0;
    const out: number[] = [];
    for (let c = 0; c < 5; c++) {
      const chunk = Float32Array.from({ length: 2400 }, (_, i) => sine(c * 2400 + i));
      out.push(...upsampleChunk(chunk, prev, from, to, 0.1));
      prev = chunk[2399]!;
    }
    let maxStep = 0;
    for (let i = 4411; i < out.length; i++)
      maxStep = Math.max(maxStep, Math.abs(out[i]! - out[i - 1]!));
    // A 440 Hz, 0.5-amplitude sine moves at most 2*pi*440/44100*0.5 ~= 0.031 per sample.
    expect(maxStep).toBeLessThan(0.0315);
  });
});
