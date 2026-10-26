/**
 * Clock-sync simulator: N virtual clients with their own clocks and network
 * links run the real ClockSync module against a real server (booted in this
 * process), and we measure how far their estimates are from the truth.
 *
 *   npm run sim -- --scenario wifi --clients 20 --seconds 60
 *   npm run sim -- --all            # every scenario, writes results/summary.md
 *
 * Why in-process: the server's clock is performance.timeOrigin +
 * performance.now() in this same process, and each client's clock is a known
 * transform of performance.now(), so every client's TRUE offset is exact.
 *
 * Each client's link adds, per direction and in TCP order (no reordering):
 *   base one-way latency  +/- half the asymmetry
 *   + exponential queueing jitter
 *   + rare retransmit spikes (stand-in for packet loss)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { serverMessageSchema, type ClientMessage, type ServerMessage } from '@sds/shared';
import { ClockSync, median, type Scheduler } from '../../client/src/sync/clockSync';
import { startServer } from '../../server/src/index';

// ---------------- configuration ----------------

interface Range {
  min: number;
  max: number;
}

interface Scenario {
  description: string;
  /** One-way base latency per client, drawn uniformly. */
  latencyMs: Range;
  /** Up minus down base latency per client (the part no RTT method can see). */
  asymmetryMs: Range;
  /** Mean of the exponential queueing delay per message, per client. */
  jitterMs: Range;
  /**
   * Share of the queueing that happens on the uplink (0.5 = symmetric).
   * Congested phones and home uplinks queue mostly on the way up, which biases
   * any estimator that trusts all samples equally.
   */
  uplinkQueueShare: number;
  /** Probability a message hits a retransmit spike. */
  spikeRate: number;
  spikeMs: number;
  /** Client clock drift vs the server, ppm, per client. */
  driftPpm: Range;
}

const SCENARIOS: Record<string, Scenario> = {
  lan: {
    description: 'Same Wi-Fi as a local server',
    latencyMs: { min: 1, max: 4 },
    asymmetryMs: { min: -0.5, max: 0.5 },
    jitterMs: { min: 0.2, max: 2 },
    uplinkQueueShare: 0.5,
    spikeRate: 0,
    spikeMs: 0,
    driftPpm: { min: -30, max: 30 },
  },
  wifi: {
    description: 'Home Wi-Fi to a nearby cloud region',
    latencyMs: { min: 10, max: 40 },
    asymmetryMs: { min: -4, max: 4 },
    jitterMs: { min: 1, max: 10 },
    uplinkQueueShare: 0.6,
    spikeRate: 0.005,
    spikeMs: 120,
    driftPpm: { min: -50, max: 50 },
  },
  mobile: {
    description: '4G/5G phones, busy cell',
    latencyMs: { min: 30, max: 90 },
    asymmetryMs: { min: -10, max: 10 },
    jitterMs: { min: 5, max: 30 },
    uplinkQueueShare: 0.75,
    spikeRate: 0.01,
    spikeMs: 250,
    driftPpm: { min: -50, max: 50 },
  },
  hostile: {
    description: 'Congested uplinks, big one-sided delay',
    latencyMs: { min: 50, max: 150 },
    asymmetryMs: { min: -30, max: 30 },
    jitterMs: { min: 20, max: 60 },
    uplinkQueueShare: 0.85,
    spikeRate: 0.02,
    spikeMs: 400,
    driftPpm: { min: -100, max: 100 },
  },
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const CLIENTS = Math.min(30, Number(arg('clients', '20')));
const SECONDS = Number(arg('seconds', '60'));
const SEED = Number(arg('seed', '42'));
const ALL = process.argv.includes('--all');
const SCENARIO_NAMES = ALL ? Object.keys(SCENARIOS) : [arg('scenario', 'wifi')];
const OUT_DIR = path.resolve(import.meta.dirname, '../results');

// ---------------- helpers ----------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r: () => number, range: Range) => range.min + r() * (range.max - range.min);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function pct(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

/** One direction of a client's link: random delay, delivered in order like TCP. */
class Lane {
  private lastDelivery = 0;
  constructor(
    private readonly r: () => number,
    private readonly baseMs: number,
    private readonly jitterMs: number,
    private readonly spikeRate: number,
    private readonly spikeMs: number,
  ) {}

  send(fn: () => void): void {
    const queueing = -Math.log(1 - this.r()) * this.jitterMs;
    const spike = this.r() < this.spikeRate ? this.spikeMs * (0.5 + this.r()) : 0;
    const now = performance.now();
    const at = Math.max(now + this.baseMs + queueing + spike, this.lastDelivery);
    this.lastDelivery = at;
    setTimeout(fn, at - now);
  }
}

interface ClientProfile {
  latencyMs: number;
  asymmetryMs: number;
  jitterMs: number;
  driftPpm: number;
  /** Local clock = perf * (1 + ppm) + offsetMs: deliberately far from the server's. */
  offsetMs: number;
}

class VirtualClient {
  readonly sync: ClockSync;
  private ws!: WebSocket;
  private readonly up: Lane;
  private readonly down: Lane;
  private handlers = new Map<string, Array<(m: ServerMessage, t1: number) => void>>();

  constructor(
    readonly id: number,
    readonly profile: ClientProfile,
    r: () => number,
    scenario: Scenario,
  ) {
    const upMs = Math.max(0.1, profile.latencyMs + profile.asymmetryMs / 2);
    const downMs = Math.max(0.1, profile.latencyMs - profile.asymmetryMs / 2);
    // Same total queueing as a symmetric link, split by the scenario's uplink share.
    const upJitter = 2 * profile.jitterMs * scenario.uplinkQueueShare;
    const downJitter = 2 * profile.jitterMs * (1 - scenario.uplinkQueueShare);
    this.up = new Lane(r, upMs, upJitter, scenario.spikeRate, scenario.spikeMs);
    this.down = new Lane(r, downMs, downJitter, scenario.spikeRate, scenario.spikeMs);
    const scheduler: Scheduler = {
      now: () => this.localNow(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
    this.sync = new ClockSync((t0) => this.send({ type: 'ping', t0 }), scheduler);
    this.on('pong', (m, t1) => {
      if (m.type === 'pong') this.sync.handlePong(m.t0, m.ts, t1);
    });
  }

  localNow(): number {
    return performance.now() * (1 + this.profile.driftPpm / 1e6) + this.profile.offsetMs;
  }

  /** Exact server-minus-local offset right now. */
  trueOffset(): number {
    const p = performance.now();
    return (
      performance.timeOrigin + p - (p * (1 + this.profile.driftPpm / 1e6) + this.profile.offsetMs)
    );
  }

  /** Server time at the real moment this client's clock reads `local`. */
  serverTimeAtLocal(local: number): number {
    const p = (local - this.profile.offsetMs) / (1 + this.profile.driftPpm / 1e6);
    return performance.timeOrigin + p;
  }

  connect(url: string, origin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, { origin });
      this.ws.on('message', (data) => {
        const msg = serverMessageSchema.parse(JSON.parse(data.toString()));
        // Delay delivery on the way down; t1 is stamped on (simulated) arrival.
        this.down.send(() => {
          const t1 = this.localNow();
          for (const h of this.handlers.get(msg.type) ?? []) h(msg, t1);
        });
      });
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMessage): void {
    this.up.send(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    });
  }

  on(type: ServerMessage['type'], h: (m: ServerMessage, t1: number) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }

  close(): void {
    this.sync.stop();
    this.ws.close();
  }
}

// ---------------- one scenario ----------------

interface ScenarioResult {
  name: string;
  scenario: Scenario;
  clients: number;
  offsetAbs: number[];
  naiveAbs: number[];
  spreads: number[];
  boundCovered: number;
  boundTotal: number;
  estimateRatio: number[];
  startAbs: number[];
  startSigned: number[];
  lateArrivals: number;
  plays: number;
  leadMs: number[];
}

async function runScenario(name: string, seedOffset: number): Promise<ScenarioResult> {
  const scenario = SCENARIOS[name];
  if (!scenario)
    throw new Error(`unknown scenario "${name}" (try: ${Object.keys(SCENARIOS).join(', ')})`);
  const r = rng(SEED + seedOffset);
  const server = await startServer({
    port: 0,
    clientDist: '/nonexistent',
    uploadDir: mkdtempSync(path.join(os.tmpdir(), 'sds-sim-')),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const wsUrl = `ws://127.0.0.1:${server.port}/ws`;

  const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
  const { code, hostToken } = (await res.json()) as { code: string; hostToken: string };

  const clients: VirtualClient[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    const profile: ClientProfile = {
      latencyMs: pick(r, scenario.latencyMs),
      asymmetryMs: pick(r, scenario.asymmetryMs),
      jitterMs: pick(r, scenario.jitterMs),
      driftPpm: pick(r, scenario.driftPpm),
      offsetMs: (r() - 0.5) * 7_200_000, // up to +/- 1 h away from the server
    };
    const c = new VirtualClient(i, profile, r, scenario);
    await c.connect(wsUrl, base);
    c.send({
      type: 'join',
      code,
      clientId: `sim-client-${String(i).padStart(3, '0')}`,
      name: `Sim ${i}`,
      ...(i === 0 && { hostToken }),
    });
    // Report sync stats like the app does, so the server's auto lead time is realistic.
    c.sync.onUpdate((s) => {
      if (!s.synced) return;
      const st = s.stats();
      c.send({
        type: 'syncReport',
        sync: {
          offsetMs: st.offsetMs,
          rttMs: st.rttMs,
          jitterMs: st.jitterMs,
          errorMs: st.errorMs,
          boundMs: st.boundMs,
          samples: st.samples,
        },
      });
    });
    c.sync.start();
    clients.push(c);
  }

  // Scheduled-play measurement: for every play, each client converts the
  // server start time to its own clock on arrival; we check what real server
  // time that local moment corresponds to.
  const startSigned: number[] = [];
  let lateArrivals = 0;
  const leadMs: number[] = [];
  let lastSeq = -1;
  for (const c of clients) {
    c.on('roomState', (m, t1) => {
      if (m.type !== 'roomState' || m.room.playback.status !== 'playing') return;
      const { startServerMs, seq } = m.room.playback;
      if (c.id === 0 && seq !== lastSeq) {
        lastSeq = seq;
        leadMs.push(m.room.leadMs);
      }
      const localStart = c.sync.toLocalTime(startServerMs);
      // The app treats a start closer than 80 ms as missed and joins late.
      if (localStart - t1 < 80) lateArrivals++;
      startSigned.push(c.serverTimeAtLocal(localStart) - startServerMs);
    });
  }

  const rows: string[] = [
    'time_s,client,latency_ms,asymmetry_ms,jitter_ms,drift_ppm,offset_error_ms,naive_error_ms,estimated_error_ms,bound_ms,rtt_ms',
  ];
  const offsetAbs: number[] = [];
  const naiveAbs: number[] = [];
  const spreads: number[] = [];
  const estimateRatio: number[] = [];
  let boundCovered = 0;
  let boundTotal = 0;
  const t0 = performance.now();
  let plays = 0;
  const host = clients[0]!;

  for (let s = 1; s <= SECONDS; s++) {
    await sleep(1000 - ((performance.now() - t0) % 1000));
    if (s === 6) host.send({ type: 'command', action: 'load', trackId: 'click' });
    // A play every 10 s after warm-up (pause in between so each play is new).
    if (s >= 8 && s % 10 === 8 && s + 4 < SECONDS) {
      host.send({ type: 'command', action: 'play', force: true });
      plays++;
    }
    if (s >= 8 && s % 10 === 3) host.send({ type: 'command', action: 'pause' });
    if (s < 5) continue; // first burst still settling

    const errs: number[] = [];
    for (const c of clients) {
      if (!c.sync.synced) continue;
      const err = c.sync.offsetMs - c.trueOffset();
      const burst = c.sync.lastBurst();
      const naive = burst.length
        ? burst.reduce((a, b) => a + b.offset, 0) / burst.length - c.trueOffset()
        : Number.NaN;
      errs.push(err);
      offsetAbs.push(Math.abs(err));
      if (Number.isFinite(naive)) naiveAbs.push(Math.abs(naive));
      boundTotal++;
      if (Math.abs(err) <= c.sync.boundMs + 0.5) boundCovered++;
      if (c.sync.errorMs > 0) estimateRatio.push(Math.abs(err) / c.sync.errorMs);
      const p = c.profile;
      rows.push(
        [
          s,
          c.id,
          p.latencyMs,
          p.asymmetryMs,
          p.jitterMs,
          p.driftPpm,
          err,
          naive,
          c.sync.errorMs,
          c.sync.boundMs,
          c.sync.rttMs,
        ]
          .map((v) => (typeof v === 'number' ? +v.toFixed(3) : v))
          .join(','),
      );
    }
    if (errs.length > 1) spreads.push(Math.max(...errs) - Math.min(...errs));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, `${name}.csv`), rows.join('\n') + '\n');
  for (const c of clients) c.close();
  await server.close();

  return {
    name,
    scenario,
    clients: CLIENTS,
    offsetAbs,
    naiveAbs,
    spreads,
    boundCovered,
    boundTotal,
    estimateRatio,
    startAbs: startSigned.map(Math.abs),
    startSigned,
    lateArrivals,
    plays,
    leadMs,
  };
}

// ---------------- report ----------------

const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '–');

function summarize(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push(
    `Simulated with ${CLIENTS} clients per scenario, ${SECONDS} s each, seed ${SEED} (\`npm run sim -- --all\`).`,
    '',
    '| Scenario | One-way latency | Asymmetry | Queueing (mean, % uplink) | Offset error median | p90 | p99 | Naive mean, median | Spread (max-min) median | Start error median | p90 | max | Late arrivals | Within rtt/2 bound |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of results) {
    const s = r.scenario;
    lines.push(
      `| **${r.name}** | ${s.latencyMs.min}-${s.latencyMs.max} ms | ±${s.asymmetryMs.max} ms | ${s.jitterMs.min}-${s.jitterMs.max} ms, ${Math.round(s.uplinkQueueShare * 100)}% | ` +
        `${f(pct(r.offsetAbs, 0.5))} ms | ${f(pct(r.offsetAbs, 0.9))} ms | ${f(pct(r.offsetAbs, 0.99))} ms | ` +
        `${f(pct(r.naiveAbs, 0.5))} ms | ${f(pct(r.spreads, 0.5))} ms | ` +
        `${f(pct(r.startAbs, 0.5))} ms | ${f(pct(r.startAbs, 0.9))} ms | ${f(Math.max(...r.startAbs))} ms | ` +
        `${r.lateArrivals}/${r.startAbs.length} | ${f((100 * r.boundCovered) / Math.max(1, r.boundTotal), 1)}% |`,
    );
  }
  lines.push('');
  for (const r of results) {
    lines.push(
      `- **${r.name}** (${r.scenario.description}): ${r.plays} scheduled plays, lead time ${r.leadMs.map((l) => `${Math.round(l)} ms`).join(' / ') || '–'}; ` +
        `actual error / estimated error median ${f(median(r.estimateRatio))}.`,
    );
  }
  return lines.join('\n');
}

const results: ScenarioResult[] = [];
for (const [i, name] of SCENARIO_NAMES.entries()) {
  process.stdout.write(`running ${name} (${CLIENTS} clients, ${SECONDS} s)… `);
  const r = await runScenario(name, i * 1000);
  results.push(r);
  console.log(
    `offset |err| median ${f(pct(r.offsetAbs, 0.5))} ms, p99 ${f(pct(r.offsetAbs, 0.99))} ms; ` +
      `start |err| median ${f(pct(r.startAbs, 0.5))} ms, max ${f(Math.max(...r.startAbs))} ms`,
  );
}
const md = summarize(results);
console.log('\n' + md);
writeFileSync(
  path.join(OUT_DIR, ALL ? 'summary.md' : `summary-${SCENARIO_NAMES[0]}.md`),
  md + '\n',
);
console.log(`\nCSV per scenario and the summary are in ${path.relative(process.cwd(), OUT_DIR)}/`);
process.exit(0);
