import { keys, local } from './storage';

export type FlashPref = 'on' | 'gentle' | 'off';

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function initial(): FlashPref {
  const saved = local.get(keys.flash);
  if (saved === 'on' || saved === 'gentle' || saved === 'off') return saved;
  // Respect the OS setting until the user picks something.
  return prefersReduced() ? 'gentle' : 'on';
}

let value = initial();
const listeners = new Set<() => void>();

export const flashPref = {
  get: (): FlashPref => value,
  set(v: FlashPref): void {
    value = v;
    local.set(keys.flash, v);
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
