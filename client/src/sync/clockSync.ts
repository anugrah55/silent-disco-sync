/**
 * NTP-style clock synchronization against the Silent Disco server.
 *
 * Framework-free and DOM-free: time, timers and the transport are injected, so
 * the same module runs in the browser, in the Node simulator (/sim) and under
 * deterministic virtual time in the unit tests.
 *
 * One sample = one ping/pong round trip:
 *   t0  local send time (performance.now())
 *   ts  server time when it answered
 *   t1  local receive time
 *   rtt    = t1 - t0
 *   offset = ts - (t0 + rtt / 2)          // server - local, assuming symmetric paths
 *
 * Queueing delay is what breaks the symmetric-path assumption, and queueing only
 * ever adds delay. So the samples with the lowest RTT are the ones that waited in
 * the fewest queues and whose midpoint is closest to the truth. Each estimate is
 * the median offset of the K best samples in a 30 s sliding window, where
 * "best" is lowest rtt/2 plus an age penalty (NTP's growing dispersion): an old
 * sample has to be clearly better than a fresh one to keep its place, so the
 * estimate follows real clock changes without losing the low-RTT filtering.
 *
 * Applying a new estimate during playback would make the audio jump, so the
 * applied offset slews toward the target at a bounded rate (default 2 ms/s).
 * When nothing is playing the caller can allow a step instead (canStep).
 *
 * Two deliberate exceptions to "only ever slew":
 *  - Step detection. Every sample pins the true offset inside
 *    [offset - rtt/2, offset + rtt/2]. If a new burst's interval doesn't overlap
 *    the window's, a clock really stepped (some phones pause performance.now()
 *    during device sleep), so the stale window is dropped. A latency spike only
 *    widens the interval and never triggers this.
 *  - A gap larger than maxSlewGapMs is stepped even during playback: slewing
 *    100 ms at 2 ms/s would mean ~50 s of audible echo, while a step costs one
 *    re-schedule from the drift controller.
 */

export interface Scheduler {
  /** Local monotonic milliseconds (performance.now() in the browser). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ClockSyncOptions {
  /** Pings in the initial (and post-reconnect) burst. */
  burstSize: number;
  /** Pings in each background re-sync burst. */
  resyncBurstSize: number;
  /** Spacing between pings inside a burst. */
  burstIntervalMs: number;
  /** Background re-sync period. */
  resyncIntervalMs: number;
  /** How many lowest-RTT samples feed the median. */
  keep: number;
  /** Samples older than this are dropped from the window. */
  windowMs: number;
  /** Age penalty when ranking samples, in ms of half-RTT per second of age. */
  agePenaltyMsPerSec: number;
  /** A burst ends this long after its last ping even if pongs are missing. */
  pongTimeoutMs: number;
  /** Max rate at which the applied offset may move, in ms per second. */
  maxSlewMsPerSec: number;
  /** Gaps larger than this are stepped even while playing. */
  maxSlewGapMs: number;
  /** Entries kept in the history ring buffer (for the Sync Lab graphs). */
  historySize: number;
}

export const DEFAULT_CLOCK_SYNC_OPTIONS: ClockSyncOptions = {
  burstSize: 20,
  resyncBurstSize: 5,
  burstIntervalMs: 100,
  resyncIntervalMs: 10_000,
  keep: 5,
  windowMs: 30_000,
  agePenaltyMsPerSec: 0.25,
  pongTimeoutMs: 1500,
  maxSlewMsPerSec: 2,
  maxSlewGapMs: 50,
  historySize: 360,
};

export interface Sample {
  t0: number;
  t1: number;
  ts: number;
  rtt: number;
  offset: number;
}

export interface Estimate {
  /** Median offset of the kept samples (server - local, ms). */
  offsetMs: number;
  /** Lowest RTT in the window. */
  bestRttMs: number;
  /** Median RTT of the latest burst: a typical round trip, used for lead time. */
  rttMs: number;
  /** Standard deviation of the kept samples' offsets. */
  jitterMs: number;
  /** Worst-case offset error if the best path were fully asymmetric: bestRtt / 2. */
  boundMs: number;
  kept: Sample[];
  windowSize: number;
}

export interface HistoryEntry {
  /** Local time the burst finished. */
  at: number;
  kind: 'initial' | 'resync';
  /** How the new estimate was applied. */
  applied: 'step' | 'slew';
  /** The window was discarded because the clock stepped. */
  stepDetected: boolean;
  /** New target offset from this burst. */
  estimateMs: number;
  /** Applied offset at the moment the burst finished. */
  appliedMs: number;
  rttMs: number;
  bestRttMs: number;
  jitterMs: number;
  errorMs: number;
  boundMs: number;
  received: number;
  sent: number;
}

export interface SyncStatsSnapshot {
  offsetMs: number;
  rttMs: number;
  jitterMs: number;
  errorMs: number;
  boundMs: number;
  samples: number;
}

type Listener = (sync: ClockSync) => void;

interface Burst {
  kind: 'initial' | 'resync';
  sent: number;
  target: number;
  received: Sample[];
  pending: Set<number>;
  timer: unknown;
  deadline: unknown;
}

export class ClockSync {
  readonly opts: ClockSyncOptions;

  private window: Sample[] = [];
  private burst: Burst | null = null;
  private resyncTimer: unknown = null;
  private running = false;
  private listeners = new Set<Listener>();

  /** Slew state: applied(t) moves from baseOffset toward targetOffset at maxSlew. */
  private baseOffset = 0;
  private baseAt = 0;
  private targetOffset = 0;
  private hasEstimate = false;

  /** EWMA of |change between consecutive estimates|: how steady the estimate is. */
  private stabilityMs: number | null = null;
  private last: Estimate | null = null;
  private lastBurstSamples: Sample[] = [];
  private lastBurstKept = new Set<Sample>();
  readonly history: HistoryEntry[] = [];

  constructor(
    private readonly send: (t0: number) => void,
    private readonly clock: Scheduler,
    options: Partial<ClockSyncOptions> = {},
    /** Return true when a jump in time is harmless (nothing is playing). */
    private readonly canStep: () => boolean = () => false,
  ) {
    this.opts = { ...DEFAULT_CLOCK_SYNC_OPTIONS, ...options };
  }

  // ---------- lifecycle ----------

  /** Run the full burst now, then re-sync in the background. */
  start(): void {
    this.running = true;
    this.runBurst('initial');
  }

  stop(): void {
    this.running = false;
    this.cancelBurst();
    if (this.resyncTimer !== null) this.clock.clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }

  /**
   * Start over after a reconnect: the network path may have changed, so drop
   * the old window and run a full burst. The applied offset is kept (and slewed)
   * unless stepping is allowed, so audio already playing doesn't jump.
   */
  restart(): void {
    this.cancelBurst();
    this.window = [];
    this.running = true;
    this.runBurst('initial');
  }

  /** Trigger a background-sized burst now (e.g. a "sync now" button). */
  resyncNow(): void {
    if (!this.running || this.burst) return;
    this.runBurst('resync');
  }

  onUpdate(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- reading the clock ----------

  get synced(): boolean {
    return this.hasEstimate;
  }

  /** A ping burst is in flight (heavy uploads should pause so pings aren't queued). */
  get bursting(): boolean {
    return this.burst !== null;
  }

  /** Offset currently applied (server - local), including any slew in progress. */
  get offsetMs(): number {
    return this.appliedAt(this.clock.now());
  }

  /** Offset the slew is heading toward (the latest estimate). */
  get targetOffsetMs(): number {
    return this.targetOffset;
  }

  get rttMs(): number {
    return this.last?.rttMs ?? Number.NaN;
  }

  get bestRttMs(): number {
    return this.last?.bestRttMs ?? Number.NaN;
  }

  get jitterMs(): number {
    return this.last?.jitterMs ?? Number.NaN;
  }

  /** Worst-case error bound: half the best round trip. */
  get boundMs(): number {
    return this.last?.boundMs ?? Number.NaN;
  }

  /**
   * Estimated error of the applied offset. Combines the spread of the trusted
   * samples (jitter), how much consecutive estimates disagree (stability), and
   * any slew still in progress. It deliberately does not include path
   * asymmetry, which no round-trip method can observe; boundMs covers that.
   */
  get errorMs(): number {
    if (!this.last) return Number.NaN;
    const stability = this.stabilityMs ?? this.initialStability(this.last);
    const pendingSlew = Math.abs(this.targetOffset - this.offsetMs);
    return Math.hypot(this.last.jitterMs, stability) + pendingSlew;
  }

  serverNow(): number {
    return this.toServerTime(this.clock.now());
  }

  toServerTime(localMs: number): number {
    return localMs + this.appliedAt(localMs);
  }

  toLocalTime(serverMs: number): number {
    // Solve local + applied(local) = serverMs by fixed-point iteration. The
    // applied offset moves at most maxSlew (2 ms/s), so each step shrinks the
    // error ~500x; two refinements are accurate to nanoseconds.
    let local = serverMs - this.offsetMs;
    for (let i = 0; i < 2; i++) local = serverMs - this.appliedAt(local);
    return local;
  }

  stats(): SyncStatsSnapshot {
    return {
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      jitterMs: this.jitterMs,
      errorMs: this.errorMs,
      boundMs: this.boundMs,
      samples: this.last?.windowSize ?? 0,
    };
  }

  /** Every sample in the current window, flagged with whether it was trusted. */
  windowSamples(): Array<Sample & { kept: boolean }> {
    return this.window.map((s) => ({ ...s, kept: this.lastBurstKept.has(s) }));
  }

  /** Samples of the most recent burst, flagged with whether they were trusted. */
  lastBurst(): Array<Sample & { kept: boolean }> {
    return this.lastBurstSamples.map((s) => ({ ...s, kept: this.lastBurstKept.has(s) }));
  }

  // ---------- transport ----------

  /** Feed a pong. t1 must be taken as early as possible on receipt. */
  handlePong(t0: number, ts: number, t1: number): void {
    const burst = this.burst;
    if (!burst || !burst.pending.has(t0)) return; // stale, duplicate, or from a cancelled burst
    burst.pending.delete(t0);
    const rtt = t1 - t0;
    if (!(rtt >= 0) || !Number.isFinite(ts)) return;
    burst.received.push({ t0, t1, ts, rtt, offset: ts - (t0 + rtt / 2) });
    if (burst.sent === burst.target && burst.pending.size === 0) this.finishBurst();
  }

  // ---------- internals ----------

  private runBurst(kind: 'initial' | 'resync'): void {
    if (this.resyncTimer !== null) this.clock.clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    const burst: Burst = {
      kind,
      sent: 0,
      target: kind === 'initial' ? this.opts.burstSize : this.opts.resyncBurstSize,
      received: [],
      pending: new Set(),
      timer: null,
      deadline: null,
    };
    this.burst = burst;
    const sendOne = () => {
      if (this.burst !== burst) return;
      let t0 = this.clock.now();
      // t0 doubles as the ping id, so make sure it's unique within the burst.
      while (burst.pending.has(t0)) t0 += 1e-6;
      burst.pending.add(t0);
      burst.sent++;
      this.send(t0);
      if (burst.sent < burst.target) {
        burst.timer = this.clock.setTimeout(sendOne, this.opts.burstIntervalMs);
      } else {
        burst.deadline = this.clock.setTimeout(() => this.finishBurst(), this.opts.pongTimeoutMs);
      }
    };
    sendOne();
  }

  private cancelBurst(): void {
    if (!this.burst) return;
    if (this.burst.timer !== null) this.clock.clearTimeout(this.burst.timer);
    if (this.burst.deadline !== null) this.clock.clearTimeout(this.burst.deadline);
    this.burst = null;
  }

  private finishBurst(): void {
    const burst = this.burst;
    if (!burst) return;
    this.cancelBurst();
    const now = this.clock.now();

    const fresh = burst.received;
    let window = this.window.filter((s) => s.t1 >= now - this.opts.windowMs);
    let stepDetected = false;
    if (
      fresh.length > 0 &&
      window.length > 0 &&
      !intervalsOverlap(fresh, window, this.opts.keep, now, this.opts.agePenaltyMsPerSec)
    ) {
      window = [];
      stepDetected = true;
    }
    this.window = window.concat(fresh);

    if (fresh.length > 0) {
      const est = estimate(this.window, fresh, this.opts.keep, now, this.opts.agePenaltyMsPerSec);
      const applied = this.apply(est, now);
      this.lastBurstSamples = burst.received;
      this.lastBurstKept = new Set(est.kept);
      this.history.push({
        at: now,
        kind: burst.kind,
        applied,
        stepDetected,
        estimateMs: est.offsetMs,
        appliedMs: this.appliedAt(now),
        rttMs: est.rttMs,
        bestRttMs: est.bestRttMs,
        jitterMs: est.jitterMs,
        errorMs: this.errorMs,
        boundMs: est.boundMs,
        received: burst.received.length,
        sent: burst.sent,
      });
      if (this.history.length > this.opts.historySize) this.history.shift();
    }

    if (this.running) {
      // Nothing came back at all: retry soon instead of waiting a full period.
      const delay = burst.received.length === 0 ? 2000 : this.opts.resyncIntervalMs;
      const retryKind = this.hasEstimate ? 'resync' : 'initial';
      this.resyncTimer = this.clock.setTimeout(() => this.runBurst(retryKind), delay);
    }
    this.listeners.forEach((l) => l(this));
  }

  private apply(est: Estimate, now: number): 'step' | 'slew' {
    const current = this.appliedAt(now);
    const step =
      !this.hasEstimate ||
      this.canStep() ||
      Math.abs(est.offsetMs - current) > this.opts.maxSlewGapMs;
    if (this.hasEstimate) this.updateStability(est.offsetMs);
    this.baseOffset = step ? est.offsetMs : current;
    this.baseAt = now;
    this.targetOffset = est.offsetMs;
    this.hasEstimate = true;
    this.last = est;
    return step ? 'step' : 'slew';
  }

  private updateStability(newOffset: number): void {
    const delta = Math.abs(newOffset - this.targetOffset);
    this.stabilityMs = this.stabilityMs === null ? delta : 0.7 * this.stabilityMs + 0.3 * delta;
  }

  /** Before a second estimate exists, use the RTT spread of the trusted samples. */
  private initialStability(est: Estimate): number {
    const rtts = est.kept.map((s) => s.rtt);
    return (Math.max(...rtts) - Math.min(...rtts)) / 2;
  }

  private appliedAt(localMs: number): number {
    if (!this.hasEstimate) return 0;
    const gap = this.targetOffset - this.baseOffset;
    if (gap === 0) return this.targetOffset;
    const maxMove = (this.opts.maxSlewMsPerSec * Math.max(0, localMs - this.baseAt)) / 1000;
    return Math.abs(gap) <= maxMove
      ? this.targetOffset
      : this.baseOffset + Math.sign(gap) * maxMove;
  }
}

// ---------- pure helpers (exported for tests and the simulator) ----------

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}

/**
 * Each sample says the true offset lies within offset ± rtt/2. Do the trusted
 * samples of `a` and `b` agree on a common value (with 1 ms of slack)?
 */
export function intervalsOverlap(
  a: readonly Sample[],
  b: readonly Sample[],
  keep: number,
  now = 0,
  agePenaltyMsPerSec = 0,
): boolean {
  const ea = estimate(a, a, keep, now, agePenaltyMsPerSec);
  const eb = estimate(b, b, keep, now, agePenaltyMsPerSec);
  const halfA = Math.max(...ea.kept.map((s) => s.rtt)) / 2;
  const halfB = Math.max(...eb.kept.map((s) => s.rtt)) / 2;
  return Math.abs(ea.offsetMs - eb.offsetMs) <= halfA + halfB + 1;
}

/**
 * Median offset of the `keep` best samples in `window`, ranked by
 * rtt/2 + age * agePenaltyMsPerSec (age measured against `now`).
 */
export function estimate(
  window: readonly Sample[],
  latest: readonly Sample[],
  keep: number,
  now = 0,
  agePenaltyMsPerSec = 0,
): Estimate {
  const score = (s: Sample) => s.rtt / 2 + (agePenaltyMsPerSec * Math.max(0, now - s.t1)) / 1000;
  const ranked = [...window].sort((a, b) => score(a) - score(b));
  const kept = ranked.slice(0, Math.max(1, Math.min(keep, ranked.length)));
  const best = Math.min(...kept.map((s) => s.rtt));
  return {
    offsetMs: median(kept.map((s) => s.offset)),
    bestRttMs: best,
    rttMs: median((latest.length ? latest : kept).map((s) => s.rtt)),
    jitterMs: stdDev(kept.map((s) => s.offset)),
    boundMs: best / 2,
    kept,
    windowSize: window.length,
  };
}

// ---------- server time -> AudioContext time ----------

/** The subset of AudioContext this mapping needs (keeps the module DOM-free). */
export interface OutputClockLike {
  readonly currentTime: number;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

export interface AudioTimeMapping {
  /** AudioContext time (seconds) at which a sample must be scheduled. */
  contextTime: number;
  method: 'outputTimestamp' | 'currentTime';
  /** Output latency subtracted in the fallback path, in seconds. */
  latencySec: number;
}

/**
 * Convert a server timestamp into the AudioContext time at which a source must
 * start so that its first sample *leaves the speaker* at that server instant.
 *
 * Preferred path: getOutputTimestamp() pairs a context time with the
 * performance.now() moment that sample reaches the output, so output latency is
 * already inside the pair. Fallback (older Safari, or before the context has
 * rendered): currentTime is "now" at the render head, and the sound reaches the
 * speaker outputLatency later, so subtract it.
 *
 * nudgeMs shifts this device on top (negative = earlier), for Bluetooth and
 * other latency the browser can't report.
 */
export function serverToAudioTime(
  serverMs: number,
  sync: Pick<ClockSync, 'toLocalTime'>,
  ctx: OutputClockLike,
  perfNow: () => number,
  nudgeMs = 0,
): AudioTimeMapping {
  const localMs = sync.toLocalTime(serverMs) + nudgeMs;
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.contextTime && ts.performanceTime && ts.contextTime > 0 && ts.performanceTime > 0) {
    return {
      contextTime: ts.contextTime + (localMs - ts.performanceTime) / 1000,
      method: 'outputTimestamp',
      latencySec: 0,
    };
  }
  const latencySec = ctx.outputLatency || ctx.baseLatency || 0;
  return {
    contextTime: ctx.currentTime + (localMs - perfNow()) / 1000 - latencySec,
    method: 'currentTime',
    latencySec,
  };
}

/** Inverse of serverToAudioTime: which server instant a context time is heard at. */
export function audioTimeToServer(
  contextTime: number,
  sync: Pick<ClockSync, 'toServerTime'>,
  ctx: OutputClockLike,
  perfNow: () => number,
  nudgeMs = 0,
): number {
  const ts = ctx.getOutputTimestamp?.();
  let localMs: number;
  if (ts && ts.contextTime && ts.performanceTime && ts.contextTime > 0 && ts.performanceTime > 0) {
    localMs = ts.performanceTime + (contextTime - ts.contextTime) * 1000;
  } else {
    const latencySec = ctx.outputLatency || ctx.baseLatency || 0;
    localMs = perfNow() + (contextTime - ctx.currentTime + latencySec) * 1000;
  }
  return sync.toServerTime(localMs - nudgeMs);
}
