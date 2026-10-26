import type { Member } from '@sds/shared';
import { qualityLabel, syncQuality, type Quality } from '../lib/quality';

const dot: Record<Quality, string> = {
  good: 'bg-good',
  ok: 'bg-ok',
  bad: 'bg-bad',
  unknown: 'bg-haze/50 animate-pulse',
};

export function ListenerList({
  members,
  meId,
  trackId = null,
}: {
  members: Member[];
  meId: string;
  /** The room's current track, to show who has it ready. */
  trackId?: string | null;
}) {
  const sorted = [...members].sort(
    (a, b) => Number(b.isHost) - Number(a.isHost) || a.name.localeCompare(b.name),
  );
  return (
    <ul className="flex flex-col divide-y divide-line" aria-label="Listeners">
      {sorted.map((m) => {
        const q = syncQuality(m.sync?.errorMs);
        return (
          <li
            key={m.id}
            className={`flex items-center gap-3 py-3 ${m.connected ? '' : 'opacity-50'}`}
          >
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-full bg-ink font-display text-sm font-bold"
            >
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {m.name}
                {m.id === meId && <span className="text-haze"> (you)</span>}
              </span>
              <span className="text-sm text-haze">
                {m.isHost ? 'Host' : 'Listener'}
                {!m.connected
                  ? ' · reconnecting'
                  : trackId && (m.readyTrackId === trackId ? ' · ready' : ' · loading track…')}
              </span>
            </span>
            <span
              className="flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-sm tabular-nums"
              title={
                m.sync
                  ? `Estimated error ±${m.sync.errorMs.toFixed(1)} ms · RTT ${m.sync.rttMs.toFixed(0)} ms · worst case ±${m.sync.boundMs.toFixed(0)} ms`
                  : 'Measuring…'
              }
            >
              <span aria-hidden className={`size-2.5 rounded-full ${dot[q]}`} />
              <span className="sr-only">Sync quality: </span>
              {m.sync ? `±${m.sync.errorMs.toFixed(1)} ms` : qualityLabel[q]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
