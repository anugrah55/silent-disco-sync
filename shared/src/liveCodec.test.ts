import { describe, expect, it } from 'vitest';
import { decodeLiveChunk, encodeLiveChunk, peekLiveHeader } from './liveCodec';

describe('live chunk codec', () => {
  it('round-trips header and samples within 16-bit precision', () => {
    const samples = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 10) * 0.8);
    const frame = encodeLiveChunk(7, 123_456, samples);
    expect(frame.byteLength).toBe(12 + 4800);
    const back = decodeLiveChunk(frame)!;
    expect(back.streamId).toBe(7);
    expect(back.index).toBe(123_456);
    expect(back.samples.length).toBe(2400);
    for (let i = 0; i < samples.length; i++)
      expect(Math.abs(back.samples[i]! - samples[i]!)).toBeLessThan(1 / 16384);
    expect(peekLiveHeader(new Uint8Array(frame))).toEqual({
      streamId: 7,
      index: 123_456,
      samples: 2400,
    });
  });

  it('clips out-of-range samples and rejects foreign frames', () => {
    const back = decodeLiveChunk(encodeLiveChunk(1, 0, Float32Array.of(2, -2)))!;
    expect(back.samples[0]).toBeCloseTo(1, 3);
    expect(back.samples[1]).toBe(-1);
    expect(decodeLiveChunk(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeLiveChunk(new Uint8Array(14))).toBeNull(); // wrong magic
  });
});
