import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ConnectionPill } from '../components/ConnectionPill';
import { ScatterChart, TimeChart } from '../components/charts';
import { SERIES } from '../components/chartUtils';
import { NUDGE_MAX, NUDGE_MIN, nudge } from '../lib/nudge';
import { qualityLabel, syncQuality, type Quality } from '../lib/quality';
import { getConnection } from '../net/connection';
import { currentRoomSession } from '../room/session';

const qualityDot: Record<Quality, string> = {
  good: 'bg-good',
  ok: 'bg-ok',
  bad: 'bg-bad',
  unknown: 'bg-haze/50',
};

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Lab() {
  const conn = useMemo(() => getConnection(), []);
  const { clock, socket } = conn;
  // Render time lives in state so render stays pure; ticking it also refreshes live values.
  const [now, setNow] = useState(() => performance.now());
  const status = useSyncExternalStore(
    (cb) => socket.onStatus(cb),
    () => socket.status,
  );
  const nudgeMs = useSyncExternalStore(nudge.subscribe, nudge.get);

  useEffect(() => {
    const tick = () => setNow(performance.now());
    const off = clock.onUpdate(tick);
    // Live values (slew in progress, error) change between bursts too.
    const timer = window.setInterval(tick, 500);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [clock]);

  const room = currentRoomSession();
  const history = clock.history;
  const first = history[0];
  const x = (at: number) => (first ? (at - first.at) / 1000 : 0);
  const rel = (offset: number) => (first ? offset - first.estimateMs : 0);

  const offsetSeries = [
    {
      name: 'Applied offset',
      color: SERIES.blue,
      kind: 'line' as const,
      points: first
        ? [
            ...history.map((h) => ({ x: x(h.at), y: rel(h.appliedMs) })),
            { x: x(now), y: rel(clock.offsetMs) },
          ]
        : [],
    },
    {
      name: 'Burst estimate',
      color: SERIES.orange,
      kind: 'dots' as const,
      points: history.map((h) => ({ x: x(h.at), y: rel(h.estimateMs) })),
    },
  ];
  const rttSeries = [
    {
      name: 'Median RTT',
      color: SERIES.blue,
      kind: 'line' as const,
      points: history.map((h) => ({ x: x(h.at), y: h.rttMs })),
    },
    {
      name: 'Best RTT',
      color: SERIES.orange,
      kind: 'line' as const,
      points: history.map((h) => ({ x: x(h.at), y: h.bestRttMs })),
    },
  ];
  const errorSeries = [
    {
      name: 'Estimated error',
      color: SERIES.blue,
      kind: 'line' as const,
      points: history.map((h) => ({ x: x(h.at), y: h.errorMs })),
    },
    {
      name: 'Worst-case bound (RTT/2)',
      color: SERIES.orange,
      kind: 'line' as const,
      points: history.map((h) => ({ x: x(h.at), y: h.boundMs })),
    },
  ];
  const samples = clock.windowSamples();
  const target = clock.targetOffsetMs;
  const scatter = samples.map((s) => ({
    x: s.rtt,
    y: s.offset - target,
    group: s.kept ? 'kept' : 'dropped',
  }));

  const error = clock.errorMs;
  const q = syncQuality(clock.synced ? error : null);
  const slewLeft = clock.synced ? target - clock.offsetMs : Number.NaN;

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-5 px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-10">
      <header className="flex items-center justify-between">
        <Link to={room ? `/r/${room.code}` : '/'} className="text-haze hover:text-white">
          ← {room ? `Room ${room.code}` : 'Home'}
        </Link>
        <ConnectionPill status={status} />
      </header>

      <section>
        <h1 className="font-display text-4xl font-bold">
          Sync <span className="text-gradient">Lab</span>
        </h1>
        <p className="mt-2 max-w-prose text-haze">
          Live view of this device's clock synchronization. Every 10 s the phone pings the server a
          few times, trusts the fastest round trips, and eases its clock toward the new estimate at
          no more than 2 ms per second.
        </p>
      </section>

      <section aria-label="Current sync" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Estimated error" value={clock.synced ? `±${fmt(error)} ms` : '…'} hero>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${qualityDot[q]}`} />
            {qualityLabel[q]}
          </span>
        </Stat>
        <Stat label="Worst-case bound" value={`±${fmt(clock.boundMs, 0)} ms`}>
          if the network path were fully one-sided
        </Stat>
        <Stat label="Round trip" value={`${fmt(clock.rttMs, 0)} ms`}>
          best {fmt(clock.bestRttMs, 0)} ms
        </Stat>
        <Stat label="Jitter" value={`${fmt(clock.jitterMs, 2)} ms`}>
          spread of trusted samples
        </Stat>
        <Stat label="Slew remaining" value={`${fmt(slewLeft, 2)} ms`}>
          eased at ≤ {clock.opts.maxSlewMsPerSec} ms/s
        </Stat>
        <Stat label="Samples in window" value={String(clock.stats().samples)}>
          {history.length} bursts so far
        </Stat>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-ghost min-h-11 text-base"
          onClick={() => clock.resyncNow()}
        >
          Re-sync now
        </button>
        <button
          type="button"
          className="btn-ghost min-h-11 text-base"
          onClick={() => clock.restart()}
        >
          Full 20-ping burst
        </button>
      </div>

      <TimeChart
        title="Clock offset"
        subtitle="Change since the first estimate. Dots are new estimates; the line is what playback actually uses."
        series={offsetSeries}
        xFormat={mmss}
        yFormat={(v) => v.toFixed(2)}
      />
      <ScatterChart
        title="Why fast pings are trusted"
        subtitle="Every ping from the last 30 s. Slow pings sat in network queues, which skews their offset; the fastest few (fresh ones favored) set the clock."
        points={scatter}
        groups={[
          { key: 'kept', name: 'Trusted (lowest RTT)', color: SERIES.blue },
          { key: 'dropped', name: 'Discarded', color: SERIES.muted },
        ]}
        xLabel="RTT (ms)"
        yLabel="Offset vs estimate (ms)"
      />
      <TimeChart
        title="Round-trip time"
        series={rttSeries}
        xFormat={mmss}
        yFormat={(v) => v.toFixed(0)}
        includeZero
      />
      <TimeChart
        title="Estimated error vs worst-case bound"
        subtitle="The badge uses the estimate. The bound only applies if all delay were on one side of the trip."
        series={errorSeries}
        xFormat={mmss}
        includeZero
      />

      <section className="card flex flex-col gap-3" aria-labelledby="nudge-h">
        <h2 id="nudge-h" className="font-display text-base font-bold">
          Output nudge
        </h2>
        <p className="text-sm text-haze">
          Bluetooth speakers and some phones add delay the browser can't measure. Shift this device
          until it lines up with the others. Saved on this device.
        </p>
        <div className="flex items-center gap-3">
          <label htmlFor="nudge" className="sr-only">
            Output nudge in milliseconds
          </label>
          <input
            id="nudge"
            type="range"
            min={NUDGE_MIN}
            max={NUDGE_MAX}
            step={1}
            value={nudgeMs}
            onChange={(e) => nudge.set(Number(e.target.value))}
            className="h-11 flex-1 accent-neon-cyan"
            aria-valuetext={`${nudgeMs} milliseconds ${nudgeMs < 0 ? 'earlier' : nudgeMs > 0 ? 'later' : ''}`}
          />
          <output htmlFor="nudge" className="w-20 text-right font-semibold tabular-nums">
            {nudgeMs > 0 ? '+' : ''}
            {nudgeMs} ms
          </output>
        </div>
        <div className="flex items-center justify-between text-xs text-haze">
          <span>← earlier</span>
          <button
            type="button"
            className="rounded-full px-3 py-1 hover:bg-white/10"
            onClick={() => nudge.set(0)}
          >
            Reset
          </button>
          <span>later →</span>
        </div>
      </section>

      <section className="card" aria-labelledby="drift-h">
        <h2 id="drift-h" className="font-display text-base font-bold">
          Drift corrections
        </h2>
        <p className="mt-1 text-sm text-haze">
          No corrections logged yet. While a track plays, every playback-rate nudge and re-schedule
          is listed here.
        </p>
      </section>

      <details className="card">
        <summary className="cursor-pointer font-display text-base font-bold">Data table</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-right text-sm tabular-nums">
            <thead className="text-haze">
              <tr>
                <th className="py-1 text-left font-medium">Time</th>
                <th className="font-medium">Kind</th>
                <th className="font-medium">Estimate Δ</th>
                <th className="font-medium">RTT</th>
                <th className="font-medium">Jitter</th>
                <th className="font-medium">Error</th>
                <th className="font-medium">Bound</th>
                <th className="font-medium">Pongs</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().map((h) => (
                <tr key={h.at} className="border-t border-line">
                  <td className="py-1 text-left">{mmss(x(h.at))}</td>
                  <td>
                    {h.kind}
                    {h.stepDetected ? ' · step' : ''}
                  </td>
                  <td>{fmt(rel(h.estimateMs), 2)}</td>
                  <td>{fmt(h.rttMs, 0)}</td>
                  <td>{fmt(h.jitterMs, 2)}</td>
                  <td>{fmt(h.errorMs, 2)}</td>
                  <td>{fmt(h.boundMs, 0)}</td>
                  <td>
                    {h.received}/{h.sent}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </main>
  );
}

function Stat({
  label,
  value,
  hero,
  children,
}: {
  label: string;
  value: string;
  hero?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`card flex flex-col gap-1 ${hero ? 'col-span-2 sm:col-span-1' : ''}`}>
      <p className="text-sm text-haze">{label}</p>
      <p className={`font-semibold ${hero ? 'text-4xl' : 'text-2xl'}`}>{value}</p>
      {children && <div className="text-xs text-haze">{children}</div>}
    </div>
  );
}
