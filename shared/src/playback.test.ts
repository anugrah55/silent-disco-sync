import { describe, expect, it } from 'vitest';
import { IDLE, applyCommand, hasEnded, positionAt, type CommandContext } from './playback';
import type { PlaybackState } from './protocol';

const ctx = (nowMs: number, extra: Partial<CommandContext> = {}): CommandContext => ({
  nowMs,
  leadMs: 2000,
  durationSec: 90,
  ...extra,
});

function run(state: PlaybackState, ...steps: Array<[Parameters<typeof applyCommand>[1], number]>) {
  let s = state;
  for (const [cmd, now] of steps) {
    const r = applyCommand(s, cmd, ctx(now));
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
  }
  return s;
}

describe('positionAt', () => {
  it('is 0 when idle and frozen while paused', () => {
    expect(positionAt(IDLE, 123_456)).toBe(0);
    const paused: PlaybackState = {
      ...IDLE,
      trackId: 't',
      status: 'paused',
      positionAtStartSec: 12.5,
      startServerMs: 1000,
    };
    expect(positionAt(paused, 99_999)).toBe(12.5);
  });

  it('advances in real time while playing, and holds before the start instant', () => {
    const playing: PlaybackState = {
      trackId: 't',
      status: 'playing',
      startServerMs: 10_000,
      positionAtStartSec: 5,
      seq: 1,
    };
    expect(positionAt(playing, 9_000)).toBe(5); // scheduled, not started yet
    expect(positionAt(playing, 10_000)).toBe(5);
    expect(positionAt(playing, 13_250)).toBeCloseTo(8.25, 9);
  });

  it('clamps at the duration, or wraps for looping tracks', () => {
    const playing: PlaybackState = {
      trackId: 't',
      status: 'playing',
      startServerMs: 0,
      positionAtStartSec: 0,
      seq: 1,
    };
    expect(positionAt(playing, 100_000, 90)).toBe(90);
    expect(positionAt(playing, 100_000, 8, true)).toBeCloseTo(4, 9);
    expect(hasEnded(playing, 100_000, 90)).toBe(true);
    expect(hasEnded(playing, 50_000, 90)).toBe(false);
  });
});

describe('applyCommand', () => {
  it('load parks the new track at 0 immediately', () => {
    const s = run(IDLE, [{ action: 'load', trackId: 'neon' }, 1000]);
    expect(s).toMatchObject({
      trackId: 'neon',
      status: 'paused',
      positionAtStartSec: 0,
      startServerMs: 1000,
      seq: 1,
    });
  });

  it('play starts lead time in the future, from the paused position', () => {
    const s = run(IDLE, [{ action: 'load', trackId: 'neon' }, 1000], [{ action: 'play' }, 5000]);
    expect(s).toMatchObject({
      status: 'playing',
      startServerMs: 7000,
      positionAtStartSec: 0,
      seq: 2,
    });
  });

  it('play refuses without a track', () => {
    expect(applyCommand(IDLE, { action: 'play' }, ctx(0))).toEqual({
      ok: false,
      reason: 'no_track',
    });
  });

  it('pause stops at the position reached at its effective time', () => {
    // Playing from 0 at t=7 s; pause pressed at t=17 s takes effect at t=19 s -> 12 s in.
    const s = run(
      IDLE,
      [{ action: 'load', trackId: 'neon' }, 1000],
      [{ action: 'play' }, 5000],
      [{ action: 'pause' }, 17_000],
    );
    expect(s).toMatchObject({ status: 'paused', startServerMs: 19_000, seq: 3 });
    expect(s.positionAtStartSec).toBeCloseTo(12, 9);
    expect(positionAt(s, 60_000)).toBeCloseTo(12, 9);
  });

  it('resume continues from the paused position', () => {
    const s = run(
      IDLE,
      [{ action: 'load', trackId: 'neon' }, 1000],
      [{ action: 'play' }, 5000],
      [{ action: 'pause' }, 17_000],
      [{ action: 'play' }, 30_000],
    );
    expect(s).toMatchObject({ status: 'playing', startServerMs: 32_000 });
    expect(s.positionAtStartSec).toBeCloseTo(12, 9);
    expect(positionAt(s, 42_000)).toBeCloseTo(22, 9);
  });

  it('seek while playing is scheduled; seek while paused is immediate', () => {
    const playing = run(IDLE, [{ action: 'load', trackId: 'neon' }, 0], [{ action: 'play' }, 0]);
    const seeked = run(playing, [{ action: 'seek', positionSec: 60 }, 10_000]);
    expect(seeked).toMatchObject({
      status: 'playing',
      startServerMs: 12_000,
      positionAtStartSec: 60,
    });

    const paused = run(
      playing,
      [{ action: 'pause' }, 10_000],
      [{ action: 'seek', positionSec: 30 }, 20_000],
    );
    expect(paused).toMatchObject({
      status: 'paused',
      startServerMs: 20_000,
      positionAtStartSec: 30,
    });
  });

  it('clamps seek to the track length and below zero', () => {
    const loaded = run(IDLE, [{ action: 'load', trackId: 'neon' }, 0]);
    expect(run(loaded, [{ action: 'seek', positionSec: 500 }, 1]).positionAtStartSec).toBe(90);
  });

  it('pressing play at the end restarts from 0', () => {
    const ended = run(
      IDLE,
      [{ action: 'load', trackId: 'neon' }, 0],
      [{ action: 'play' }, 0],
      [{ action: 'pause' }, 200_000],
    );
    expect(ended.positionAtStartSec).toBe(90);
    expect(run(ended, [{ action: 'play' }, 300_000]).positionAtStartSec).toBe(0);
  });

  it('late joiner computes the live position from the room state alone', () => {
    // Play started at t=7 s from 0; someone joins at t=47.3 s.
    const s = run(IDLE, [{ action: 'load', trackId: 'neon' }, 1000], [{ action: 'play' }, 5000]);
    expect(positionAt(s, 47_300, 90)).toBeCloseTo(40.3, 9);
  });

  it('pause before playback has even started stops at the start position', () => {
    const s = run(
      IDLE,
      [{ action: 'load', trackId: 'neon' }, 0],
      [{ action: 'play' }, 10_000],
      [{ action: 'pause' }, 10_500],
    );
    // play effective at 12 s, pause effective at 12.5 s -> 0.5 s in
    expect(s.positionAtStartSec).toBeCloseTo(0.5, 9);
  });
});
