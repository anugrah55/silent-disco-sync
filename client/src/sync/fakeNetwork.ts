/**
 * Deterministic virtual network for testing ClockSync: a seeded RNG, a
 * discrete-event clock, independent client and server clocks, and per-direction
 * delay with jitter, asymmetry, loss and time-varying spikes.
 */
import type { ClockSync, Scheduler } from './clockSync';

/** Small, fast, seedable PRNG (Mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Event {
  at: number;
  seq: number;
  fn: () => void;
}

/** Discrete-event time in "true" milliseconds. */
export class VirtualTime {
  t = 0;
  private queue: Event[] = [];
  private seq = 0;
  private cancelled = new Set<number>();

  schedule(fn: () => void, delayMs: number): number {
    const ev = { at: this.t + Math.max(0, delayMs), seq: this.seq++, fn };
    // Keep the queue sorted by (at, seq); queues stay small so insertion is fine.
    let i = this.queue.length;
    while (
      i > 0 &&
      (this.queue[i - 1]!.at > ev.at ||
        (this.queue[i - 1]!.at === ev.at && this.queue[i - 1]!.seq > ev.seq))
    )
      i--;
    this.queue.splice(i, 0, ev);
    return ev.seq;
  }

  cancel(id: number): void {
    this.cancelled.add(id);
  }

  /** Run events until (and including) true time `until`. */
  runUntil(until: number, onTick?: (t: number) => void): void {
    while (this.queue.length && this.queue[0]!.at <= until) {
      const ev = this.queue.shift()!;
      if (this.cancelled.delete(ev.seq)) continue;
      this.t = ev.at;
      ev.fn();
      onTick?.(this.t);
    }
    this.t = until;
  }

  runFor(ms: number, onTick?: (t: number) => void): void {
    this.runUntil(this.t + ms, onTick);
  }
}

export interface LinkProfile {
  /** Fixed one-way delays. Different values = asymmetric path. */
  upMs: number;
  downMs: number;
  /** Mean of the exponential queueing delay added to each direction. */
  jitterMeanMs: number;
  /** Per-direction overrides, e.g. queueing only on a congested uplink. */
  jitterUpMeanMs?: number;
  jitterDownMeanMs?: number;
  /** Probability that a packet is dropped (each direction). */
  loss: number;
  /** Extra delay as a function of true time, e.g. a latency spike. */
  extraUpMs?: (t: number) => number;
  extraDownMs?: (t: number) => number;
}

export interface ClockModel {
  /** Client clock = true time * (1 + driftPpm/1e6) + localOffsetMs. */
  localOffsetMs: number;
  driftPpm: number;
  /** Server clock = true time + serverOffsetMs (mutable to simulate a step). */
  serverOffsetMs: number;
  /** Server processing time between receipt and stamping ts. */
  serverProcessingMs: number;
}

export class FakeNetwork {
  readonly time = new VirtualTime();
  private readonly rng: () => number;
  profile: LinkProfile;
  clocks: ClockModel;
  sync: ClockSync | null = null;
  sent = 0;
  delivered = 0;

  constructor(seed: number, profile: Partial<LinkProfile> = {}, clocks: Partial<ClockModel> = {}) {
    this.rng = mulberry32(seed);
    this.profile = { upMs: 20, downMs: 20, jitterMeanMs: 0, loss: 0, ...profile };
    this.clocks = {
      localOffsetMs: 12_345.678,
      driftPpm: 0,
      serverOffsetMs: 1_700_000_000_000,
      serverProcessingMs: 0.05,
      ...clocks,
    };
  }

  localNow(): number {
    return this.time.t * (1 + this.clocks.driftPpm / 1e6) + this.clocks.localOffsetMs;
  }

  serverNow(): number {
    return this.time.t + this.clocks.serverOffsetMs;
  }

  /** The true server-minus-local offset right now. */
  trueOffset(): number {
    return this.serverNow() - this.localNow();
  }

  scheduler(): Scheduler {
    return {
      now: () => this.localNow(),
      setTimeout: (fn, ms) => this.time.schedule(fn, ms),
      clearTimeout: (h) => this.time.cancel(h as number),
    };
  }

  private exp(mean: number): number {
    return mean > 0 ? -Math.log(1 - this.rng()) * mean : 0;
  }

  private delay(dir: 'up' | 'down'): number | null {
    if (this.rng() < this.profile.loss) return null;
    const p = this.profile;
    const base = dir === 'up' ? p.upMs : p.downMs;
    const extra = (dir === 'up' ? p.extraUpMs : p.extraDownMs)?.(this.time.t) ?? 0;
    const jitter = (dir === 'up' ? p.jitterUpMeanMs : p.jitterDownMeanMs) ?? p.jitterMeanMs;
    return base + extra + this.exp(jitter);
  }

  /** The `send` function to hand to ClockSync. */
  send = (t0: number): void => {
    this.sent++;
    const up = this.delay('up');
    if (up === null) return;
    this.time.schedule(() => {
      const ts = this.serverNow() + this.clocks.serverProcessingMs;
      const down = this.delay('down');
      if (down === null) return;
      this.time.schedule(() => {
        this.delivered++;
        this.sync?.handlePong(t0, ts, this.localNow());
      }, down + this.clocks.serverProcessingMs);
    }, up);
  };
}
