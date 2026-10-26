import { positionAt, type PlaybackState, type TrackInfo } from '@sds/shared';
import { serverToAudioTime, type ClockSync } from '../sync/clockSync';
import { audioEngine } from './engine';

/** A scheduled start closer than this is treated as already missed. */
const MIN_SCHEDULE_AHEAD_MS = 80;
/** Late joiners and slow clients start this far ahead of "now". */
const LATE_START_MS = 150;

export interface ActiveSource {
  source: AudioBufferSourceNode;
  trackId: string;
  seq: number;
  /** AudioContext time the source was scheduled to start. */
  ctxStart: number;
  /** Track offset (seconds) at ctxStart. */
  offset: number;
  /** Server time matching ctxStart. */
  serverStart: number;
  loop: boolean;
  duration: number;
}

/**
 * Turns the room's server-authoritative playback state into scheduled audio.
 *
 * Every transition carries a future server timestamp. apply() converts it to
 * this device's AudioContext time (via the synced clock and output latency)
 * and schedules start/stop at exactly that instant. If the instant has already
 * passed (late join, slow decode, reconnect), it computes where the track is
 * now and starts ~150 ms ahead at the matching offset.
 */
export class Player {
  current: ActiveSource | null = null;
  private appliedSeq = -1;
  private appliedTrack: string | null = null;

  constructor(
    private readonly clock: ClockSync,
    private readonly getNudgeMs: () => number,
    /** Told whether audio is (about to be) playing, so the clock slews instead of stepping. */
    private readonly onPlayingChange: (playing: boolean) => void,
  ) {}

  /** Force the next apply() to reschedule even if the state is unchanged. */
  invalidate(): void {
    this.appliedSeq = -1;
  }

  apply(state: PlaybackState, track: TrackInfo | null, buffer: AudioBuffer | null): void {
    const ctx = audioEngine.ctx;
    if (!ctx) return;

    const sameState = state.seq === this.appliedSeq && state.trackId === this.appliedTrack;
    // Same state and still sounding (or nothing should be sounding): nothing to do.
    if (sameState && (state.status !== 'playing' || this.current)) return;

    if (!track || !buffer || state.trackId !== track.id || state.status === 'idle') {
      this.stopAt(null);
      this.mark(state, false);
      return;
    }

    if (state.status === 'paused') {
      // Keep playing until the pause takes effect, then stop on the shared clock.
      const at =
        state.startServerMs > this.clock.serverNow() + 10 ? this.toCtx(state.startServerMs) : null;
      this.stopAt(at);
      this.mark(state, false);
      return;
    }

    // Playing.
    const nowServer = this.clock.serverNow();
    let startServer = state.startServerMs;
    if (startServer < nowServer + MIN_SCHEDULE_AHEAD_MS) startServer = nowServer + LATE_START_MS;
    const duration = buffer.duration;
    const offset = positionAt(state, startServer, duration, track.loop);
    if (!track.loop && offset >= duration - 0.01) {
      this.stopAt(null); // the track already ended for everyone else
      this.mark(state, false);
      return;
    }

    let ctxStart = this.toCtx(startServer);
    if (ctxStart < ctx.currentTime + 0.02) {
      // Audio clock is further along than the shared clock suggests (e.g. the
      // context just resumed). Start soon and correct the offset to match.
      const shift = ctx.currentTime + 0.05 - ctxStart;
      ctxStart += shift;
      startServer += shift * 1000;
    }
    const startOffset = positionAt(state, startServer, duration, track.loop);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = track.loop;
    source.connect(audioEngine.output);
    source.start(ctxStart, startOffset);
    // Hand over at the same instant, so seeks are gapless and echo-free.
    try {
      this.current?.source.stop(ctxStart);
    } catch {
      /* older Safari throws on a second stop() */
    }

    const active: ActiveSource = {
      source,
      trackId: track.id,
      seq: state.seq,
      ctxStart,
      offset: startOffset,
      serverStart: startServer,
      loop: track.loop,
      duration,
    };
    source.onended = () => {
      if (this.current === active) {
        this.current = null;
        this.onPlayingChange(false);
      }
    };
    this.current = active;
    this.mark(state, true);
  }

  stopNow(): void {
    this.stopAt(null);
    this.appliedSeq = -1;
    this.onPlayingChange(false);
  }

  /** Where this device's audio actually is in the track right now, if playing. */
  actualPosition(): number | null {
    const ctx = audioEngine.ctx;
    const cur = this.current;
    if (!ctx || !cur || ctx.currentTime < cur.ctxStart) return null;
    const pos = cur.offset + (ctx.currentTime - cur.ctxStart) * cur.source.playbackRate.value;
    return cur.loop ? pos % cur.duration : pos;
  }

  private toCtx(serverMs: number): number {
    const ctx = audioEngine.ctx!;
    return serverToAudioTime(serverMs, this.clock, ctx, () => performance.now(), this.getNudgeMs())
      .contextTime;
  }

  private stopAt(ctxTime: number | null): void {
    const cur = this.current;
    if (!cur) return;
    try {
      cur.source.stop(ctxTime ?? 0);
    } catch {
      /* already stopped */
    }
    if (ctxTime === null) {
      cur.source.onended = null;
      this.current = null;
    }
  }

  private mark(state: PlaybackState, playing: boolean): void {
    this.appliedSeq = state.seq;
    this.appliedTrack = state.trackId;
    this.onPlayingChange(playing);
  }
}
