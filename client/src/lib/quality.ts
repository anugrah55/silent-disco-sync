export type Quality = 'good' | 'ok' | 'bad' | 'unknown';

/** Badge thresholds on the estimated sync error bound. */
export function syncQuality(errorMs: number | null | undefined): Quality {
  if (errorMs == null || !Number.isFinite(errorMs)) return 'unknown';
  if (errorMs < 10) return 'good';
  if (errorMs < 30) return 'ok';
  return 'bad';
}

export const qualityLabel: Record<Quality, string> = {
  good: 'Tight',
  ok: 'Okay',
  bad: 'Loose',
  unknown: 'Syncing',
};
