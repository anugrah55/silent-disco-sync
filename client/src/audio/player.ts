import { positionAt, type PlaybackState, type TrackInfo } from '@sds/shared';
import { audioTimeToServer, serverToAudioTime, type ClockSync } from '../sync/clockSync';
import { DRIFT, correctionLog, decideDrift, driftLog, wrappedDiff } from './drift';
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
  /** Rate bookkeeping: position = ratePos + (ctxTime - rateCtx) * rate. */
  rate: number;
  rateCtx: number;
  ratePos: number;
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
  private last: { state: PlaybackState; track: TrackInfo; buffer: AudioBuffer } | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private correcting = false;

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
    this.last = track && buffer && state.trackId === track.id ? { state, track, buffer } : null;

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
      rate: 1,
      rateCtx: ctxStart,
      ratePos: startOffset,
    };
    this.correcting = false;
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
    this.last = null;
    this.stopDriftLoop();
    this.onPlayingChange(false);
  }

  /** Where this device's audio is in the track at context time `c`. */
  private positionAtCtx(cur: ActiveSource, c: number): number {
    return cur.ratePos + (c - cur.rateCtx) * cur.rate;
  }

  /**
   * One drift check: compare the position of the sample leaving the speaker
   * right now with where the room says the track should be at that moment.
   */
  checkDrift(): void {
    const ctx = audioEngine.ctx;
    const cur = this.current;
    const last = this.last;
    if (!ctx || !cur || !last || last.state.status !== 'playing' || ctx.state !== 'running') return;
    const ts = ctx.getOutputTimestamp?.();
    const c = ts?.contextTime && ts.contextTime > 0 ? ts.contextTime : ctx.currentTime;
    if (c < cur.ctxStart) return; // scheduled, not sounding yet
    const heardServer = audioTimeToServer(
      c,
      this.clock,
      ctx,
      () => performance.now(),
      this.getNudgeMs(),
    );
    if (heardServer < last.state.startServerMs) return; // a handover is still pending
    const actual = this.positionAtCtx(cur, c);
    if (!cur.loop && actual >= cur.duration) return;
    const expected = positionAt(last.state, heardServer);
    const driftMs = wrappedDiff(actual, expected, cur.loop ? cur.duration : null) * 1000;
    driftLog.push({ at: Date.now(), driftMs, rate: cur.rate });

    const action = decideDrift(driftMs, this.correcting);
    if (action.kind === 'none') return;
    if (action.kind === 'reschedule') {
      correctionLog.push({ at: Date.now(), kind: 'reschedule', driftMs, rate: 1, source: 'track' });
      this.invalidate();
      this.apply(last.state, last.track, last.buffer);
      return;
    }
    const rate = action.kind === 'settle' ? 1 : action.rate;
    this.setRate(cur, rate, ctx.currentTime);
    this.correcting = action.kind === 'rate';
    correctionLog.push({ at: Date.now(), kind: action.kind, driftMs, rate, source: 'track' });
  }

  private setRate(cur: ActiveSource, rate: number, now: number): void {
    if (rate === cur.rate) return;
    cur.ratePos = this.positionAtCtx(cur, now);
    cur.rateCtx = now;
    cur.rate = rate;
    cur.source.playbackRate.setValueAtTime(rate, now);
  }

  private startDriftLoop(): void {
    this.driftTimer ??= setInterval(() => this.checkDrift(), DRIFT.checkEveryMs);
  }

  private stopDriftLoop(): void {
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = null;
    this.correcting = false;
  }

  /** Where this device's audio actually is in the track right now, if playing. */
  actualPosition(): number | null {
    const ctx = audioEngine.ctx;
    const cur = this.current;
    if (!ctx || !cur || ctx.currentTime < cur.ctxStart) return null;
    const pos = this.positionAtCtx(cur, ctx.currentTime);
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
    if (playing) this.startDriftLoop();
    else this.stopDriftLoop();
    this.onPlayingChange(playing);
  }
}
