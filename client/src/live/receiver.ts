import { decodeLiveChunk, type LiveState } from '@sds/shared';
import { correctionLog, decideDrift } from '../audio/drift';
import { audioEngine } from '../audio/engine';
import { serverToAudioTime, type ClockSync } from '../sync/clockSync';

/**
 * Plays the host's live tab audio on this device.
 *
 * Chunk n of a stream belongs at  ideal(n) = ctxTime(startServerMs + delayMs) + n * chunk,
 * a time every device computes from the shared clock. Chunks are scheduled
 * back to back from a cursor (each starts exactly where the previous ended, so
 * there are no clicks), and the cursor is steered toward ideal(n) with the same
 * policy as file playback: leave < 15 ms alone, ease playbackRate by up to
 * ±0.3% for 15-80 ms, jump only beyond 80 ms or after a gap in the stream.
 */
export class LiveReceiver {
  private live: LiveState | null = null;
  /** Scheduled chunks and the context-time span each one covers. */
  private sources = new Map<AudioBufferSourceNode, { start: number; end: number }>();
  /** Context time where the next chunk should start, for gapless playback. */
  private cursor: number | null = null;
  private expectedIndex = -1;
  private rate = 1;
  private correcting = false;
  /** Last source sample of the previous chunk, for seamless interpolation. */
  private prevSample = 0;
  /** Chunks that arrived after their play time. */
  late = 0;
  received = 0;

  constructor(
    private readonly clock: ClockSync,
    private readonly getNudgeMs: () => number,
  ) {}

  get active(): boolean {
    return this.live !== null;
  }

  setLive(live: LiveState | null): void {
    if (live?.streamId === this.live?.streamId) {
      this.live = live;
      return;
    }
    if (!live) {
      // The share ended (host stopped it or switched to a file): silence now.
      this.stopAll();
    }
    // A new stream from the same host (re-anchor, host reconnect) starts where
    // the old one's audio ends, so already-scheduled chunks are kept, not cut.
    this.live = live;
    this.cursor = null;
    this.expectedIndex = -1;
    this.late = 0;
    this.received = 0;
  }

  /** Re-derive the schedule from the shared clock on the next chunk (nudge change, clock step). */
  invalidate(): void {
    this.cursor = null;
  }

  /**
   * After the AudioContext was suspended, everything already scheduled would
   * play shifted by the length of the suspension: drop it and rejoin live.
   */
  hardReset(): void {
    this.stopAll();
    this.cursor = null;
  }

  onFrame(data: ArrayBuffer): void {
    const live = this.live;
    const ctx = audioEngine.ctx;
    if (!live || !ctx || ctx.state !== 'running' || !this.clock.synced) return;
    const chunk = decodeLiveChunk(data);
    if (!chunk || chunk.streamId !== live.streamId) return;
    this.received++;

    const chunkSec = live.chunkSamples / live.sampleRate;
    const ideal = this.idealStart(live, chunk.index, chunkSec);
    const contiguous = this.cursor !== null && chunk.index === this.expectedIndex;

    if (!contiguous) {
      // First chunk, or a gap in the stream: start fresh on the shared timeline,
      // trimming anything still queued (e.g. an older stream) that would overlap.
      this.cursor = ideal;
      this.setRate(1);
      this.correcting = false;
      this.trimAfter(ideal);
    } else {
      // Positive drift = we're ahead (cursor earlier than ideal).
      const driftMs = (ideal - this.cursor!) * 1000;
      const action = decideDrift(driftMs, this.correcting);
      if (action.kind === 'reschedule') {
        correctionLog.push({ at: Date.now(), kind: 'reanchor', driftMs, rate: 1, source: 'live' });
        this.cursor = ideal;
        this.setRate(1);
        this.correcting = false;
        this.trimAfter(ideal);
      } else if (action.kind === 'rate' || action.kind === 'settle') {
        const rate = action.kind === 'rate' ? action.rate : 1;
        if (rate !== this.rate) {
          correctionLog.push({ at: Date.now(), kind: action.kind, driftMs, rate, source: 'live' });
        }
        this.setRate(rate);
        this.correcting = action.kind === 'rate';
      }
    }

    const when = this.cursor!;
    if (when < ctx.currentTime + 0.005) {
      this.late++;
      this.cursor = null; // fall back to the shared timeline on the next chunk
      return;
    }

    // Resample to the context rate ourselves, continuing from the previous
    // chunk's last sample: per-buffer browser resampling dips at every edge,
    // which would tick 10 times a second on sustained notes.
    const prev = contiguous ? this.prevSample : (chunk.samples[0] ?? 0);
    const out = upsampleChunk(chunk.samples, prev, live.sampleRate, ctx.sampleRate, chunkSec);
    this.prevSample = chunk.samples[chunk.samples.length - 1] ?? 0;
    this.expectedIndex = chunk.index + 1;

    const buffer = ctx.createBuffer(1, out.length, ctx.sampleRate);
    buffer.copyToChannel(out, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.rate;
    src.connect(audioEngine.output);
    src.onended = () => this.sources.delete(src);
    src.start(when);
    const end = when + buffer.duration / this.rate;
    this.sources.set(src, { start: when, end });
    this.cursor = end;
  }

  /** Stop queued chunks from context time `t` on, so a new timeline doesn't double up. */
  private trimAfter(t: number): void {
    for (const [src, span] of this.sources) {
      if (span.end <= t) continue;
      try {
        src.stop(Math.max(t, span.start));
      } catch {
        /* already stopped */
      }
    }
  }

  stopAll(): void {
    for (const s of this.sources.keys()) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* never started */
      }
    }
    this.sources.clear();
  }

  private setRate(rate: number): void {
    this.rate = rate;
  }

  private idealStart(live: LiveState, index: number, chunkSec: number): number {
    const ctx = audioEngine.ctx!;
    const anchor = serverToAudioTime(
      live.startServerMs + live.delayMs,
      this.clock,
      ctx,
      () => performance.now(),
      this.getNudgeMs(),
    ).contextTime;
    return anchor + index * chunkSec;
  }
}

/**
 * Linear-interpolate one chunk from `fromRate` to `toRate`. Output sample j
 * sits at source position j * fromRate / toRate - 1, i.e. one source sample
 * late, so every point lies between known samples (`prev` is sample -1). The
 * one-sample delay is identical on every device.
 */
export function upsampleChunk(
  samples: Float32Array,
  prev: number,
  fromRate: number,
  toRate: number,
  chunkSec: number,
): Float32Array<ArrayBuffer> {
  const n = Math.round(chunkSec * toRate);
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let j = 0; j < n; j++) {
    const p = j * step - 1;
    const i = Math.floor(p);
    const frac = p - i;
    const a = i < 0 ? prev : samples[i]!;
    const b = samples[Math.min(i + 1, samples.length - 1)]!;
    out[j] = a + (b - a) * frac;
  }
  return out;
}
