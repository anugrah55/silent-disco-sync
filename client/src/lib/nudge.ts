import { keys, local } from './storage';

/** Per-device output nudge in ms (negative = play earlier), persisted per browser. */
export const NUDGE_MIN = -250;
export const NUDGE_MAX = 250;

const clamp = (v: number) => Math.round(Math.min(NUDGE_MAX, Math.max(NUDGE_MIN, v)));
let value = clamp(Number(local.get(keys.nudge)) || 0);
const listeners = new Set<() => void>();

export const nudge = {
  get: (): number => value,
  set(v: number): void {
    const next = clamp(v);
    if (next === value) return;
    value = next;
    local.set(keys.nudge, String(value));
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
