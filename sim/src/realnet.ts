/**
 * Real-network clock sync experiment. Runs several groups of ClockSync clients
 * (the real module, one WebSocket each) from this machine against a server.
 * All clients share this machine's clock, so they share one true offset: any
 * disagreement between their estimates is pure estimation error, the same
 * error that makes two phones on one Wi-Fi sound apart.
 *
 *   npx tsx sim/src/realnet.ts https://silent-disco-sync.onrender.com 120
 */
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { ClockSync, type ClockSyncOptions, type Scheduler } from '../../client/src/sync/clockSync';

const base = process.argv[2] ?? 'http://localhost:3000';
const seconds = Number(process.argv[3] ?? 90);
const perGroup = Number(process.argv[4] ?? 6);

const variants: Record<string, Partial<ClockSyncOptions>> = {
  current: {},
  'keep3-age0.1': { keep: 3, agePenaltyMsPerSec: 0.1 },
  'min-rtt': { keep: 1, agePenaltyMsPerSec: 0.1 },
  'keep5-noage-60s': { agePenaltyMsPerSec: 0, windowMs: 60_000 },
};

const scheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface Client {
  group: string;
  sync: ClockSync;
  ws: WebSocket;
}

function connect(group: string, opts: Partial<ClockSyncOptions>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { origin: base });
    const sync = new ClockSync(
      (t0) => ws.send(JSON.stringify({ type: 'ping', t0 })),
      scheduler,
      opts,
    );
    ws.on('message', (data) => {
      const t1 = performance.now();
      const msg = JSON.parse(data.toString()) as { type: string; t0: number; ts: number };
      if (msg.type === 'pong') sync.handlePong(msg.t0, msg.ts, t1);
    });
    ws.once('open', () => {
      sync.start();
      resolve({ group, sync, ws });
    });
    ws.once('error', reject);
  });
}

const clients: Client[] = [];
for (const [name, opts] of Object.entries(variants)) {
  for (let i = 0; i < perGroup; i++) clients.push(await connect(name, opts));
}
console.log(`${clients.length} clients connected to ${base}; sampling for ${seconds}s`);

// Every second after warm-up, record each group's spread of applied offsets.
const spreads: Record<string, number[]> = Object.fromEntries(
  Object.keys(variants).map((k) => [k, []]),
);
const vsAll: Record<string, number[]> = Object.fromEntries(
  Object.keys(variants).map((k) => [k, []]),
);
const start = Date.now();
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed < 4) return; // first burst
    const now = performance.now();
    const all = clients.filter((c) => c.sync.synced).map((c) => c.sync.toServerTime(now));
    const sorted = [...all].sort((a, b) => a - b);
    const globalMedian = sorted[sorted.length >> 1]!;
    for (const g of Object.keys(variants)) {
      const xs = clients
        .filter((c) => c.group === g && c.sync.synced)
        .map((c) => c.sync.toServerTime(now));
      if (xs.length < 2) continue;
      spreads[g]!.push(Math.max(...xs) - Math.min(...xs));
      for (const x of xs) vsAll[g]!.push(Math.abs(x - globalMedian));
    }
    if (elapsed >= seconds) {
      clearInterval(timer);
      resolve();
    }
  }, 1000);
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? NaN;
};
console.log(
  '\nvariant            pair spread (max-min across group)    |err vs all-client median|',
);
console.log('                   median    p90     max                   median   p90');
for (const g of Object.keys(variants)) {
  const s = spreads[g]!;
  const e = vsAll[g]!;
  console.log(
    `${g.padEnd(18)} ${pct(s, 0.5).toFixed(2).padStart(6)}  ${pct(s, 0.9).toFixed(2).padStart(6)}  ${Math.max(
      ...s,
    )
      .toFixed(2)
      .padStart(6)}` +
      `                  ${pct(e, 0.5).toFixed(2).padStart(6)}  ${pct(e, 0.9).toFixed(2).padStart(6)}`,
  );
}
const rtts = clients.map((c) => c.sync.bestRttMs);
console.log(
  `\nbest RTT across clients: ${Math.min(...rtts).toFixed(1)}-${Math.max(...rtts).toFixed(1)} ms`,
);
for (const c of clients) c.ws.close();
process.exit(0);
