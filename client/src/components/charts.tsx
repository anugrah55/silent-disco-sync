import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { SERIES, niceTicks, tickFormat } from './chartUtils';

const GRID = '#2a2545';
const TEXT = '#a59fc4';
const SURFACE = '#17142a';

const M = { top: 12, right: 14, bottom: 26, left: 44 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function extent(values: number[], pad = 0.08): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return [0, 1];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

export interface Point {
  x: number;
  y: number;
}

export interface Series {
  name: string;
  color: string;
  points: Point[];
  kind: 'line' | 'dots';
}

export function Legend({
  items,
}: {
  items: Array<{ name: string; color: string; kind: 'line' | 'dots' }>;
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-haze">
      {items.map((it) => (
        <li key={it.name} className="flex items-center gap-1.5">
          {it.kind === 'line' ? (
            <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: it.color }} />
          )}
          {it.name}
        </li>
      ))}
    </ul>
  );
}

function ChartFrame({
  title,
  subtitle,
  legend,
  children,
}: {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="card flex flex-col gap-3">
      <figcaption>
        <h3 className="font-display text-base font-bold">{title}</h3>
        {subtitle && <p className="text-sm text-haze">{subtitle}</p>}
      </figcaption>
      {legend}
      {children}
    </figure>
  );
}

interface Hover {
  px: number;
  py: number;
  rows: Array<{ name: string; color: string; value: string }>;
  heading: string;
}

function Tooltip({ hover, width }: { hover: Hover; width: number }) {
  const left = Math.min(Math.max(hover.px + 12, 0), width - 160);
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-40 rounded-xl border border-line bg-ink/95 px-3 py-2 text-xs shadow-lg"
      style={{ left, top: Math.max(0, hover.py - 20) }}
    >
      <p className="mb-1 text-haze">{hover.heading}</p>
      {hover.rows.map((r) => (
        <p key={r.name} className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: r.color }} />
          <strong className="font-semibold text-white tabular-nums">{r.value}</strong>
          <span className="truncate text-haze">{r.name}</span>
        </p>
      ))}
    </div>
  );
}

/** Time-series chart: lines and/or dot series sharing one x (time) and one y axis. */
export function TimeChart({
  title,
  subtitle,
  series,
  height = 180,
  yUnit = 'ms',
  xFormat = (x: number) => `${x.toFixed(0)}s`,
  yFormat = (y: number) => y.toFixed(1),
  includeZero = false,
}: {
  title: string;
  subtitle?: string;
  series: Series[];
  height?: number;
  yUnit?: string;
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  includeZero?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const all = series.flatMap((s) => s.points);
  const [x0, x1] = extent(
    all.map((p) => p.x),
    0,
  );
  let [y0, y1] = extent(all.map((p) => p.y));
  if (includeZero) {
    y0 = Math.min(0, y0);
    y1 = Math.max(0, y1);
  }
  const w = Math.max(10, width - M.left - M.right);
  const h = height - M.top - M.bottom;
  const sx = (x: number) => M.left + ((x - x0) / (x1 - x0 || 1)) * w;
  const sy = (y: number) => M.top + h - ((y - y0) / (y1 - y0 || 1)) * h;
  const yTicks = niceTicks(y0, y1, 4).filter((t) => t >= y0 && t <= y1);
  const yTickFmt = tickFormat(yTicks);
  const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor(w / 80))).filter(
    (t) => t >= x0 && t <= x1,
  );

  function onMove(e: PointerEvent<SVGSVGElement>) {
    if (all.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const xVal = x0 + ((px - M.left) / w) * (x1 - x0);
    // Snap to the nearest data x across all series.
    let nearest = all[0]!.x;
    for (const p of all) if (Math.abs(p.x - xVal) < Math.abs(nearest - xVal)) nearest = p.x;
    const rows = series.flatMap((s) => {
      let best: Point | null = null;
      for (const p of s.points)
        if (!best || Math.abs(p.x - nearest) < Math.abs(best.x - nearest)) best = p;
      return best ? [{ name: s.name, color: s.color, value: `${yFormat(best.y)} ${yUnit}` }] : [];
    });
    setHover({ px: sx(nearest), py: e.clientY - rect.top, rows, heading: xFormat(nearest) });
  }

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      legend={series.length > 1 ? <Legend items={series} /> : undefined}
    >
      <div ref={ref} className="relative">
        {all.length === 0 ? (
          <p className="grid place-items-center text-sm text-haze" style={{ height }}>
            Waiting for data…
          </p>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title}. Use the data table below for exact values.`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            className="touch-pan-y"
          >
            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line
                  x1={M.left}
                  x2={M.left + w}
                  y1={sy(t)}
                  y2={sy(t)}
                  stroke={GRID}
                  strokeWidth={1}
                />
                <text
                  x={M.left - 6}
                  y={sy(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill={TEXT}
                  className="tabular-nums"
                >
                  {yTickFmt(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text
                key={`x${t}`}
                x={sx(t)}
                y={height - 6}
                textAnchor="middle"
                fontSize={11}
                fill={TEXT}
                className="tabular-nums"
              >
                {xFormat(t)}
              </text>
            ))}
            {hover && (
              <line
                x1={hover.px}
                x2={hover.px}
                y1={M.top}
                y2={M.top + h}
                stroke={TEXT}
                strokeWidth={1}
                opacity={0.5}
              />
            )}
            {series.map((s) =>
              s.kind === 'line' ? (
                <polyline
                  key={s.name}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
                />
              ) : (
                <g key={s.name}>
                  {s.points.map((p, i) => (
                    <circle
                      key={i}
                      cx={sx(p.x)}
                      cy={sy(p.y)}
                      r={4}
                      fill={s.color}
                      stroke={SURFACE}
                      strokeWidth={2}
                    />
                  ))}
                </g>
              ),
            )}
          </svg>
        )}
        {hover && <Tooltip hover={hover} width={width} />}
      </div>
    </ChartFrame>
  );
}

export interface ScatterGroup {
  key: string;
  name: string;
  color: string;
}

/** Scatter of (x, y) points colored by group, with nearest-point hover. */
export function ScatterChart({
  title,
  subtitle,
  points,
  groups,
  xLabel,
  yLabel,
  height = 200,
}: {
  title: string;
  subtitle?: string;
  points: Array<Point & { group: string }>;
  groups: ScatterGroup[];
  xLabel: string;
  yLabel: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const [x0, x1] = extent(points.map((p) => p.x));
  const [y0, y1] = extent(points.map((p) => p.y));
  const w = Math.max(10, width - M.left - M.right);
  const h = height - M.top - M.bottom - 12;
  const sx = (x: number) => M.left + ((x - x0) / (x1 - x0 || 1)) * w;
  const sy = (y: number) => M.top + h - ((y - y0) / (y1 - y0 || 1)) * h;
  const syTicks = niceTicks(y0, y1, 4).filter((t) => t >= y0 && t <= y1);
  const sxTicks = niceTicks(x0, x1, Math.max(2, Math.floor(w / 70))).filter(
    (t) => t >= x0 && t <= x1,
  );
  const syFmt = tickFormat(syTicks);
  const sxFmt = tickFormat(sxTicks);
  const color = (g: string) => groups.find((x) => x.key === g)?.color ?? SERIES.muted;
  const name = (g: string) => groups.find((x) => x.key === g)?.name ?? g;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: (Point & { group: string }) | null = null;
    let bestD = 24 ** 2; // 24 px hit radius
    for (const p of points) {
      const d = (sx(p.x) - px) ** 2 + (sy(p.y) - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    setHover(
      best
        ? {
            px: sx(best.x),
            py: sy(best.y),
            heading: name(best.group),
            rows: [
              { name: xLabel, color: color(best.group), value: best.x.toFixed(1) },
              { name: yLabel, color: color(best.group), value: best.y.toFixed(2) },
            ],
          }
        : null,
    );
  }

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      legend={<Legend items={groups.map((g) => ({ ...g, kind: 'dots' as const }))} />}
    >
      <div ref={ref} className="relative">
        {points.length === 0 ? (
          <p className="grid place-items-center text-sm text-haze" style={{ height }}>
            Waiting for data…
          </p>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title}. ${xLabel} against ${yLabel}.`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            className="touch-pan-y"
          >
            {syTicks.map((t) => (
              <g key={`y${t}`}>
                <line
                  x1={M.left}
                  x2={M.left + w}
                  y1={sy(t)}
                  y2={sy(t)}
                  stroke={GRID}
                  strokeWidth={1}
                />
                <text
                  x={M.left - 6}
                  y={sy(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill={TEXT}
                >
                  {syFmt(t)}
                </text>
              </g>
            ))}
            {sxTicks.map((t) => (
              <text
                key={`x${t}`}
                x={sx(t)}
                y={M.top + h + 16}
                textAnchor="middle"
                fontSize={11}
                fill={TEXT}
              >
                {sxFmt(t)}
              </text>
            ))}
            <text x={M.left + w} y={height - 2} textAnchor="end" fontSize={11} fill={TEXT}>
              {xLabel} →
            </text>
            {/* Draw the de-emphasized group first so trusted samples sit on top. */}
            {[...groups]
              .reverse()
              .flatMap((g) =>
                points
                  .filter((p) => p.group === g.key)
                  .map((p, i) => (
                    <circle
                      key={`${g.key}${i}`}
                      cx={sx(p.x)}
                      cy={sy(p.y)}
                      r={hover && hover.px === sx(p.x) && hover.py === sy(p.y) ? 6 : 4.5}
                      fill={g.color}
                      stroke={SURFACE}
                      strokeWidth={2}
                    />
                  )),
              )}
          </svg>
        )}
        {hover && <Tooltip hover={hover} width={width} />}
      </div>
    </ChartFrame>
  );
}
