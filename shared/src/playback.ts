/**
 * Pure playback-state math shared by server (authoritative state) and client
 * (scheduling and display). Every transition takes effect at a future server
 * time, never "now", so every device can schedule it on its own audio clock.
 */
import type { PlaybackState } from './protocol';

export const IDLE: PlaybackState = {
  trackId: null,
  status: 'idle',
  startServerMs: 0,
  positionAtStartSec: 0,
  seq: 0,
};

/**
 * Track position (seconds) at server time `serverMs`.
 * - playing: positionAtStart + elapsed since startServerMs (frozen before it)
 * - paused:  positionAtStart (the position where playback stops)
 * Clamped to the duration when it is known. Looping tracks wrap.
 */
export function positionAt(
  state: PlaybackState,
  serverMs: number,
  durationSec: number | null = null,
  loop = false,
): number {
  let pos = state.positionAtStartSec;
  if (state.status === 'playing') pos += Math.max(0, serverMs - state.startServerMs) / 1000;
  if (durationSec && durationSec > 0) {
    pos = loop ? pos % durationSec : Math.min(pos, durationSec);
  }
  return pos;
}

/** True once a non-looping track has played past its end. */
export function hasEnded(
  state: PlaybackState,
  serverMs: number,
  durationSec: number | null,
): boolean {
  return (
    state.status === 'playing' &&
    durationSec !== null &&
    durationSec > 0 &&
    positionAt(state, serverMs) >= durationSec
  );
}

export type PlaybackCommand =
  | { action: 'load'; trackId: string }
  | { action: 'play'; positionSec?: number | undefined }
  | { action: 'pause' }
  | { action: 'seek'; positionSec: number };

export interface CommandContext {
  /** Server time the command arrived. */
  nowMs: number;
  /** Lead time: how far in the future the change takes effect. */
  leadMs: number;
  durationSec: number | null;
  loop?: boolean;
}

export type CommandResult =
  { ok: true; state: PlaybackState } | { ok: false; reason: 'no_track' | 'not_playing' };

/**
 * Apply a host command to the playback state. Effective times are always
 * nowMs + leadMs, so clients have time to receive, decode and schedule it.
 */
export function applyCommand(
  state: PlaybackState,
  cmd: PlaybackCommand,
  ctx: CommandContext,
): CommandResult {
  const effective = ctx.nowMs + ctx.leadMs;
  const clamp = (p: number) =>
    Math.max(0, ctx.durationSec && !ctx.loop ? Math.min(p, ctx.durationSec) : p);
  const seq = state.seq + 1;

  switch (cmd.action) {
    case 'load':
      // Loading is immediate: it stops whatever played and parks at 0.
      return {
        ok: true,
        state: {
          trackId: cmd.trackId,
          status: 'paused',
          startServerMs: ctx.nowMs,
          positionAtStartSec: 0,
          seq,
        },
      };

    case 'play': {
      if (!state.trackId) return { ok: false, reason: 'no_track' };
      let from = cmd.positionSec ?? positionAt(state, effective, ctx.durationSec, ctx.loop);
      // Pressing play at the end restarts the track.
      if (
        !ctx.loop &&
        ctx.durationSec &&
        from >= ctx.durationSec - 0.05 &&
        cmd.positionSec === undefined
      )
        from = 0;
      return {
        ok: true,
        state: {
          ...state,
          status: 'playing',
          startServerMs: effective,
          positionAtStartSec: clamp(from),
          seq,
        },
      };
    }

    case 'pause': {
      if (state.status !== 'playing') return { ok: false, reason: 'not_playing' };
      // Keep playing until `effective`, then stop exactly where the track is then.
      return {
        ok: true,
        state: {
          ...state,
          status: 'paused',
          startServerMs: effective,
          positionAtStartSec: clamp(positionAt(state, effective, ctx.durationSec, ctx.loop)),
          seq,
        },
      };
    }

    case 'seek': {
      if (!state.trackId) return { ok: false, reason: 'no_track' };
      if (state.status === 'playing') {
        return {
          ok: true,
          state: {
            ...state,
            startServerMs: effective,
            positionAtStartSec: clamp(cmd.positionSec),
            seq,
          },
        };
      }
      // Paused: nothing is sounding, so the new position applies immediately.
      return {
        ok: true,
        state: {
          ...state,
          status: 'paused',
          startServerMs: ctx.nowMs,
          positionAtStartSec: clamp(cmd.positionSec),
          seq,
        },
      };
    }
  }
}
