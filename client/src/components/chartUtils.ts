/** Series colors validated for the dark panel surface (#17142a). */
export const SERIES = { blue: '#3987e5', orange: '#d95926', muted: '#6f6a8f' } as const;

/** Round, human tick values ("nice numbers") across [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

/** Formatter whose precision follows the tick step, so 0.5-steps never print as "1, 1". */
export function tickFormat(ticks: number[]): (v: number) => string {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 1;
  // Enough decimals that the step itself is exact (0.25 -> 2, 0.025 -> 3, 5 -> 0).
  let decimals = 0;
  while (
    decimals < 3 &&
    Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-6
  ) {
    decimals++;
  }
  return (v: number) => v.toFixed(decimals);
}
