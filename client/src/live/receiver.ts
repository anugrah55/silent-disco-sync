import { decodeLiveChunk, type LiveState } from '@sds/shared';
import { correctionLog } from '../audio/drift';
import { audioEngine } from '../audio/engine';
import { serverToAudioTime, type ClockSync } from '../sync/clockSync';

/** Re-check the anchor this often (chunks); move it only if it drifted further than this. */
const REANCHOR_EVERY = 20;
const REANCHOR_THRESHOLD_SEC = 0.015;

/**
 * Plays the host's live tab audio on this device. Chunk n of a stream is
 * scheduled at  anchor + n * chunkDuration,  where the anchor is the
 * AudioContext time of (startServerMs + delayMs) on the shared clock. Using one
 * anchor for the whole stream keeps chunks sample-adjacent (no clicks), and
 * every device computes the same instants, so they all sound together.
 */
export class LiveReceiver {
  private live: LiveState | null = null;
  private anchor: number | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private sinceCheck = 0;
  /** Last source sample of the previous chunk, for seamless interpolation. */
  private prevSample = 0;
  private prevIndex = -1;
  /** Chunks that arrived after their play time (shown in the Sync Lab later). */
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
    this.stopAll();
    this.live = live;
    this.anchor = null;
    this.late = 0;
    this.received = 0;
    this.prevSample = 0;
    this.prevIndex = -1;
  }

  /** Recompute the anchor on the next chunk (after a nudge change or context resume). */
  invalidate(): void {
    this.anchor = null;
  }

  onFrame(data: ArrayBuffer): void {
    const live = this.live;
    const ctx = audioEngine.ctx;
    if (!live || !ctx || ctx.state !== 'running' || !this.clock.synced) return;
    const chunk = decodeLiveChunk(data);
    if (!chunk || chunk.streamId !== live.streamId) return;
    this.received++;

    const chunkSec = live.chunkSamples / live.sampleRate;
    if (this.anchor === null || ++this.sinceCheck >= REANCHOR_EVERY) {
      this.sinceCheck = 0;
      const fresh = this.computeAnchor(live);
      if (this.anchor === null) {
        this.anchor = fresh;
      } else if (Math.abs(fresh - this.anchor) > REANCHOR_THRESHOLD_SEC) {
        // Same sign convention as tracks: positive = this device was ahead.
        correctionLog.push({
          at: Date.now(),
          kind: 'reanchor',
          driftMs: (fresh - this.anchor) * 1000,
          rate: 1,
          source: 'live',
        });
        this.anchor = fresh;
      }
    }
    const when = this.anchor + chunk.index * chunkSec;
    if (when < ctx.currentTime + 0.005) {
      this.late++;
      return;
    }

    // Resample to the context rate ourselves, continuing from the previous
    // chunk's last sample: per-buffer browser resampling dips at every edge,
    // which would tick 10 times a second on sustained notes.
    const prev = chunk.index === this.prevIndex + 1 ? this.prevSample : (chunk.samples[0] ?? 0);
    const out = upsampleChunk(chunk.samples, prev, live.sampleRate, ctx.sampleRate, chunkSec);
    this.prevSample = chunk.samples[chunk.samples.length - 1] ?? 0;
    this.prevIndex = chunk.index;
    const buffer = ctx.createBuffer(1, out.length, ctx.sampleRate);
    buffer.copyToChannel(out, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioEngine.output);
    src.onended = () => this.sources.delete(src);
    src.start(when);
    this.sources.add(src);
  }

  stopAll(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* never started */
      }
    }
    this.sources.clear();
  }

  private computeAnchor(live: LiveState): number {
    const ctx = audioEngine.ctx!;
    return serverToAudioTime(
      live.startServerMs + live.delayMs,
      this.clock,
      ctx,
      () => performance.now(),
      this.getNudgeMs(),
    ).contextTime;
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
