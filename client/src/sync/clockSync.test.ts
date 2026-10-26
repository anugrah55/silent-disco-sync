import { describe, expect, it } from 'vitest';
import {
  ClockSync,
  audioTimeToServer,
  estimate,
  median,
  serverToAudioTime,
  stdDev,
  type ClockSyncOptions,
  type OutputClockLike,
  type Sample,
} from './clockSync';
import { FakeNetwork, mulberry32, type ClockModel, type LinkProfile } from './fakeNetwork';

function setup(
  seed: number,
  profile: Partial<LinkProfile> = {},
  clocks: Partial<ClockModel> = {},
  opts: Partial<ClockSyncOptions> = {},
  canStep: () => boolean = () => false,
) {
  const net = new FakeNetwork(seed, profile, clocks);
  const sync = new ClockSync(net.send, net.scheduler(), opts, canStep);
  net.sync = sync;
  return { net, sync, err: () => sync.offsetMs - net.trueOffset() };
}

/** Error after the initial burst for many seeds, sorted ascending by magnitude. */
function errorsAcrossSeeds(seeds: number, profile: Partial<LinkProfile>) {
  const filtered: number[] = [];
  const naive: number[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const { net, sync, err } = setup(seed, profile);
    sync.start();
    net.time.runFor(3500);
    filtered.push(Math.abs(err()));
    const all = sync.lastBurst();
    const mean = all.reduce((a, s) => a + s.offset, 0) / all.length;
    naive.push(Math.abs(mean - net.trueOffset()));
  }
  const sort = (a: number[]) => [...a].sort((x, y) => x - y);
  return { filtered: sort(filtered), naive: sort(naive) };
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

describe('helpers', () => {
  it('median and stdDev', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it('estimate prefers fresh samples unless an old one is clearly better', () => {
    const mk = (rtt: number, offset: number, t1: number): Sample => ({
      t0: 0,
      t1,
      ts: 0,
      rtt,
      offset,
    });
    // At now=20 s with 0.25 ms/s: the 20 s-old sample pays a 5 ms penalty.
    const window = [mk(40, 0, 0), mk(41, 10, 20_000), mk(20, 0, 0)];
    const est = estimate(window, window, 1, 20_000, 0.25);
    expect(est.kept[0]!.offset).toBe(0); // rtt 20 old (10 + 5) beats rtt 41 fresh (20.5)
    const est2 = estimate(window.slice(0, 2), window, 1, 20_000, 0.25);
    expect(est2.kept[0]!.offset).toBe(10); // rtt 41 fresh (20.5) beats rtt 40 old (25)
  });

  it('estimate keeps the lowest-RTT samples and takes their median offset', () => {
    const mk = (rtt: number, offset: number): Sample => ({ t0: 0, t1: rtt, ts: 0, rtt, offset });
    const window = [mk(50, 30), mk(10, 1), mk(12, 2), mk(80, -40), mk(11, 3)];
    const est = estimate(window, window, 3);
    expect(est.kept.map((s) => s.rtt)).toEqual([10, 11, 12]);
    expect(est.offsetMs).toBe(2);
    expect(est.bestRttMs).toBe(10);
    expect(est.boundMs).toBe(5);
  });

  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('ClockSync on a fake network', () => {
  it('stable network: sub-millisecond error after one burst', () => {
    const { net, sync, err } = setup(1, { upMs: 20, downMs: 20, jitterMeanMs: 0.3 });
    expect(sync.synced).toBe(false);
    sync.start();
    net.time.runFor(3500);
    expect(sync.synced).toBe(true);
    expect(net.sent).toBe(20);
    expect(Math.abs(err())).toBeLessThan(0.5);
    expect(sync.rttMs).toBeGreaterThan(39);
    expect(sync.rttMs).toBeLessThan(45);
    expect(sync.boundMs).toBeCloseTo(sync.bestRttMs / 2);
    // Option A badge: the estimate is steady, so it reads green even though
    // the worst-case bound (rtt/2 = 20 ms) would not.
    expect(sync.errorMs).toBeLessThan(10);
    expect(sync.history).toHaveLength(1);
  });

  it('high symmetric jitter: filtered estimate beats a naive mean', () => {
    const { filtered, naive } = errorsAcrossSeeds(40, { upMs: 15, downMs: 15, jitterMeanMs: 40 });
    expect(pct(filtered, 0.5)).toBeLessThan(3);
    expect(pct(filtered, 0.5)).toBeLessThan(pct(naive, 0.5));
  });

  it('uplink queueing: lowest-RTT filtering removes the one-sided bias', () => {
    // Queueing only on the way up biases every sample in one direction; a mean
    // inherits half the average queueing delay, the low-RTT samples don't.
    const profile = {
      upMs: 15,
      downMs: 15,
      jitterMeanMs: 0,
      jitterUpMeanMs: 40,
      jitterDownMeanMs: 1,
    };
    const { filtered, naive } = errorsAcrossSeeds(40, profile);
    expect(pct(naive, 0.5)).toBeGreaterThan(15);
    expect(pct(filtered, 0.5)).toBeLessThan(4);
    expect(pct(filtered, 0.9)).toBeLessThan(8);
  });

  it('fixed path asymmetry: error is (up - down) / 2 and stays inside the bound', () => {
    // No round-trip method can see a constant asymmetry; we document it and
    // make sure the reported worst-case bound covers it.
    const { net, sync, err } = setup(3, { upMs: 60, downMs: 20, jitterMeanMs: 0.2 });
    sync.start();
    net.time.runFor(3500);
    expect(err()).toBeCloseTo(20, 0);
    expect(sync.boundMs).toBeGreaterThanOrEqual(Math.abs(err()));
  });

  it('mid-session latency spike: the window keeps trusting earlier low-RTT samples', () => {
    const spikeFrom = 15_000;
    const spikeTo = 25_000;
    const inSpike = (t: number) => t >= spikeFrom && t < spikeTo;
    const { net, sync, err } = setup(7, {
      upMs: 25,
      downMs: 25,
      jitterMeanMs: 1,
      extraUpMs: (t) => (inSpike(t) ? 250 + 60 * Math.sin(t) ** 2 : 0),
      extraDownMs: (t) => (inSpike(t) ? 40 : 0),
    });
    sync.start();
    let worst = 0;
    let maxRtt = 0;
    net.time.runUntil(60_000, (t) => {
      if (t > 3000) worst = Math.max(worst, Math.abs(err()));
      if (inSpike(t)) maxRtt = Math.max(maxRtt, sync.rttMs);
    });
    // A naive estimate would be off by ~(250 - 40) / 2 = 105 ms during the spike.
    expect(worst).toBeLessThan(2);
    // ...while the reported RTT still rises, so the server lengthens lead time.
    expect(maxRtt).toBeGreaterThan(300);
  });

  it('slews at most 2 ms/s while playing, and keeps serverNow monotonic', () => {
    const { net, sync, err } = setup(11, { upMs: 20, downMs: 20, jitterMeanMs: 0.3 });
    sync.start();
    net.time.runFor(5000);
    expect(Math.abs(err())).toBeLessThan(0.5);

    net.clocks.serverOffsetMs += 40; // server clock steps forward 40 ms
    let prevOffset = sync.offsetMs;
    let prevLocal = net.localNow();
    let prevServer = sync.serverNow();
    let violations = 0;
    for (let i = 0; i < 900; i++) {
      net.time.runFor(100);
      const now = net.localNow();
      const off = sync.offsetMs;
      // 1 µs slack: offsets are ~1.7e12 ms, where one float step is ~0.24 µs.
      const allowed = (2 * (now - prevLocal)) / 1000 + 1e-3;
      if (Math.abs(off - prevOffset) > allowed) violations++;
      const s = sync.serverNow();
      expect(s).toBeGreaterThan(prevServer);
      prevOffset = off;
      prevLocal = now;
      prevServer = s;
      if (i === 150) {
        // 15 s later it has moved at most ~10 ms: still catching up, not jumped.
        expect(Math.abs(err())).toBeGreaterThan(20);
        expect(Math.abs(sync.targetOffsetMs - net.trueOffset())).toBeLessThan(1);
      }
    }
    expect(violations).toBe(0);
    // 40 ms is inside the RTT, so it can't be told apart from noise by the
    // interval test; the age penalty lets fresh samples take over instead.
    expect(sync.history.some((h) => h.stepDetected)).toBe(false);
    expect(sync.history.at(-1)!.applied).toBe('slew');
    // 40 ms at 2 ms/s = 20 s plus up to one 10 s re-sync period to notice.
    expect(Math.abs(err())).toBeLessThan(0.5);
  });

  it('steps a large gap even while playing instead of slewing for a minute', () => {
    const { net, sync, err } = setup(13, { upMs: 20, downMs: 20, jitterMeanMs: 0.3 });
    sync.start();
    net.time.runFor(5000);
    net.clocks.serverOffsetMs += 100; // e.g. performance.now() paused during sleep
    net.time.runFor(11_000);
    expect(Math.abs(err())).toBeLessThan(0.5);
    const last = sync.history.at(-1)!;
    expect(last.stepDetected).toBe(true);
    expect(last.applied).toBe('step');
  });

  it('steps immediately when nothing is playing', () => {
    let playing = false;
    const { net, sync, err } = setup(
      12,
      { upMs: 20, downMs: 20, jitterMeanMs: 0.3 },
      {},
      {},
      () => !playing,
    );
    sync.start();
    net.time.runFor(5000);
    net.clocks.serverOffsetMs += 100;
    net.time.runFor(11_000); // one re-sync
    expect(Math.abs(err())).toBeLessThan(0.5);

    playing = true;
    net.clocks.serverOffsetMs += 30; // under maxSlewGapMs: slews instead
    net.time.runFor(11_000);
    expect(Math.abs(err())).toBeGreaterThan(10);
    expect(sync.history.at(-1)!.applied).toBe('slew');
  });

  it('tracks a drifting local clock (50 ppm) within a millisecond', () => {
    const { net, sync, err } = setup(
      5,
      { upMs: 30, downMs: 30, jitterMeanMs: 2 },
      { driftPpm: 50 },
    );
    sync.start();
    let worst = 0;
    net.time.runUntil(300_000, (t) => {
      if (t > 3000) worst = Math.max(worst, Math.abs(err()));
    });
    // 50 ppm = 0.05 ms/s; a 30 s window carries up to ~1.5 ms of stale samples.
    expect(worst).toBeLessThan(2.5);
  });

  it('survives 30% packet loss and ignores stale or unknown pongs', () => {
    const { net, sync, err } = setup(9, { upMs: 20, downMs: 20, jitterMeanMs: 0.5, loss: 0.3 });
    sync.start();
    sync.handlePong(-1, 1e12, 0); // unknown ping id: ignored
    net.time.runFor(4000);
    expect(sync.synced).toBe(true);
    expect(Math.abs(err())).toBeLessThan(1);
    const h = sync.history[0]!;
    expect(h.received).toBeLessThan(h.sent);
  });

  it('retries when a burst gets no answers at all', () => {
    const { net, sync } = setup(2, { upMs: 20, downMs: 20, loss: 1 });
    sync.start();
    net.time.runFor(5000);
    expect(sync.synced).toBe(false);
    net.profile.loss = 0;
    net.time.runFor(6000);
    expect(sync.synced).toBe(true);
  });

  it('restart() runs a fresh full burst and drops the old window', () => {
    const { net, sync, err } = setup(4, { upMs: 10, downMs: 10, jitterMeanMs: 0.2 });
    sync.start();
    net.time.runFor(3000);
    const sentBefore = net.sent;
    net.profile.upMs = 80; // new network path after reconnect
    net.profile.downMs = 80;
    sync.restart();
    net.time.runFor(3000);
    expect(net.sent - sentBefore).toBe(20);
    expect(sync.rttMs).toBeGreaterThan(150);
    expect(Math.abs(err())).toBeLessThan(0.5);
  });

  it('toLocalTime inverts toServerTime, even mid-slew', () => {
    const { net, sync } = setup(6, { upMs: 20, downMs: 20, jitterMeanMs: 0.3 });
    sync.start();
    net.time.runFor(4000);
    net.clocks.serverOffsetMs += 40;
    net.time.runFor(12_000);
    const local = net.localNow() + 1234.5;
    expect(sync.toLocalTime(sync.toServerTime(local))).toBeCloseTo(local, 3);
  });

  it('stops sending after stop()', () => {
    const { net, sync } = setup(8);
    sync.start();
    net.time.runFor(3000);
    sync.stop();
    const sent = net.sent;
    net.time.runFor(60_000);
    expect(net.sent).toBe(sent);
  });
});

describe('server time -> AudioContext time', () => {
  // Server is exactly 1000 ms ahead of the local clock.
  const sync = { toLocalTime: (s: number) => s - 1000, toServerTime: (l: number) => l + 1000 };

  it('uses getOutputTimestamp when available (latency already inside the pair)', () => {
    const ctx: OutputClockLike = {
      currentTime: 10.2,
      outputLatency: 0.05,
      getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }),
    };
    // Server 7000 -> local 6000 -> 1000 ms after the output pair -> context 11.0
    const m = serverToAudioTime(7000, sync, ctx, () => 5100);
    expect(m.method).toBe('outputTimestamp');
    expect(m.contextTime).toBeCloseTo(11, 9);
    expect(serverToAudioTime(7000, sync, ctx, () => 5100, -40).contextTime).toBeCloseTo(10.96, 9);
    expect(audioTimeToServer(11, sync, ctx, () => 5100)).toBeCloseTo(7000, 6);
  });

  it('falls back to currentTime minus output latency', () => {
    const ctx: OutputClockLike = {
      currentTime: 2,
      outputLatency: 0.03,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    };
    const m = serverToAudioTime(7000, sync, ctx, () => 5500);
    expect(m.method).toBe('currentTime');
    // local 6000 is 500 ms from now; schedule 30 ms early to cover output latency
    expect(m.contextTime).toBeCloseTo(2 + 0.5 - 0.03, 9);
    expect(audioTimeToServer(m.contextTime, sync, ctx, () => 5500)).toBeCloseTo(7000, 6);
  });

  it('uses baseLatency when outputLatency is not reported', () => {
    const ctx: OutputClockLike = { currentTime: 1, baseLatency: 0.01 };
    expect(serverToAudioTime(7000, sync, ctx, () => 6000).contextTime).toBeCloseTo(0.99, 9);
  });
});
