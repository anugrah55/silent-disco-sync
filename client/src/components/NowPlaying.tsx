import { useState } from 'react';
import { positionAt, type RoomSnapshot } from '@sds/shared';
import type { LoadState } from '../audio/trackStore';
import { useServerNow } from '../hooks/useServerNow';
import { formatTime } from '../lib/format';
import type { RoomSession, SessionState } from '../room/session';
import { FlashToggle } from './BeatFlash';
import { LiveBadge } from './LiveShareCard';
import { Visualizer } from './Visualizer';
import { VolumeControl } from './VolumeControl';

/** Track, progress, this device's load status, and (for the host) transport. */
export function NowPlaying({ session, state }: { session: RoomSession; state: SessionState }) {
  const room = state.room!;
  const { track, playback } = room;
  const now = useServerNow(100);
  const [dragging, setDragging] = useState<number | null>(null);

  const load = state.trackLoad;
  const duration = track?.durationSec ?? (load.status === 'ready' ? load.buffer.duration : null);
  const position = positionAt(playback, now, duration, track?.loop ?? false);
  const startsIn = playback.startServerMs - now;
  const playing = playback.status === 'playing';
  const ready = readyCount(room);

  let status: string;
  if (!track) status = state.isHost ? 'Pick a track below' : 'Waiting for the host to pick a track';
  else if (playing && startsIn > 0) status = `Starting in ${(startsIn / 1000).toFixed(1)} s`;
  else if (playing) status = track.loop ? 'Playing (looping)' : 'Playing';
  else if (playback.status === 'paused' && startsIn > 0) status = 'Pausing…';
  else status = position > 0 ? 'Paused' : 'Ready to play';

  if (room.live) return <LiveNowPlaying state={state} />;

  function commitSeek(v: number) {
    // Only after an actual drag/arrow change: a stray Tab keyup must not reschedule audio.
    if (dragging === null) return;
    setDragging(null);
    session.command({ action: 'seek', positionSec: v });
  }

  return (
    <section className="card flex flex-col gap-4" aria-labelledby="np-h">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-[0.2em] text-haze uppercase">Now playing</p>
          <h2 id="np-h" className="line-clamp-2 font-display text-xl font-bold break-words">
            {track?.title ?? 'Nothing yet'}
          </h2>
          {track && <p className="truncate text-sm text-haze">{track.artist}</p>}
        </div>
        <p
          role="status"
          className="shrink-0 rounded-full bg-white/5 px-3 py-1 text-sm tabular-nums"
        >
          {status}
        </p>
      </div>

      <Visualizer />

      {track && <DeviceLoad load={load} onRetry={() => session.retryTrack()} />}

      {track && (
        <div className="flex flex-col gap-1">
          {state.isHost && duration ? (
            <>
              <label htmlFor="seek" className="sr-only">
                Seek
              </label>
              <input
                id="seek"
                type="range"
                min={0}
                max={duration}
                step={0.1}
                value={dragging ?? position}
                onChange={(e) => setDragging(Number(e.target.value))}
                onPointerUp={(e) => commitSeek(Number(e.currentTarget.value))}
                onKeyUp={(e) => commitSeek(Number(e.currentTarget.value))}
                className="h-8 w-full accent-neon-cyan"
                aria-valuetext={formatTime(dragging ?? position)}
              />
            </>
          ) : (
            <div className="h-2 overflow-hidden rounded-full bg-white/10" aria-hidden>
              <div
                className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-cyan"
                style={{ width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }}
              />
            </div>
          )}
          <div className="flex justify-between text-xs text-haze tabular-nums">
            <span>{formatTime(dragging ?? position)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      )}

      {state.isHost && track && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              onClick={() => session.command(playing ? { action: 'pause' } : { action: 'play' })}
            >
              {playing
                ? 'Pause'
                : position > 0 && position < (duration ?? Infinity) - 0.05
                  ? 'Resume'
                  : 'Play'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => session.command({ action: 'seek', positionSec: 0 })}
              aria-label="Back to start"
            >
              ⏮
            </button>
          </div>
          <p className="text-center text-sm text-haze">
            {ready.ready}/{ready.total} devices ready · starts {(room.leadMs / 1000).toFixed(1)} s
            after you tap
          </p>
          {state.error?.code === 'not_ready' && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-2xl bg-ok/15 px-4 py-3 text-sm"
            >
              <p className="flex-1 text-ok">{state.error.message}</p>
              <button
                type="button"
                className="rounded-xl bg-ok px-3 py-2 font-semibold text-night"
                onClick={() => session.command({ action: 'play', force: true })}
              >
                Start anyway
              </button>
            </div>
          )}
        </div>
      )}

      {state.isHost && (
        <button
          type="button"
          className="btn-ghost min-h-11 text-base"
          onClick={() => session.syncTest()}
        >
          Sync test: everyone plays the click
        </button>
      )}
      <VolumeControl />
      <FlashToggle />
    </section>
  );
}

function LiveNowPlaying({ state }: { state: SessionState }) {
  const live = state.room!.live!;
  return (
    <section className="card flex flex-col gap-4" aria-labelledby="np-h">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-[0.2em] text-haze uppercase">Now playing</p>
          <h2 id="np-h" className="line-clamp-2 font-display text-xl font-bold break-words">
            {live.label}
          </h2>
          <p className="text-sm text-haze">Live from the host's browser</p>
        </div>
        <LiveBadge />
      </div>
      <Visualizer />
      <p className="text-sm text-haze" role="status">
        Every device plays the shared tab {(live.delayMs / 1000).toFixed(1)} s behind the source,
        all at the same moment.
        {state.isHost && ' Use the shared tab to change songs or pause.'}
      </p>
      <VolumeControl />
    </section>
  );
}

function DeviceLoad({ load, onRetry }: { load: LoadState; onRetry: () => void }) {
  if (load.status === 'ready' || load.status === 'idle') return null;
  if (load.status === 'error') {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-2xl bg-bad/15 px-4 py-3 text-sm">
        <p className="flex-1 text-bad">{load.message}</p>
        <button
          type="button"
          className="rounded-xl bg-bad px-3 py-2 font-semibold text-night"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }
  const pct =
    load.status === 'loading' && load.total ? Math.round((load.received / load.total) * 100) : null;
  return (
    <p className="text-sm text-haze" role="status">
      {load.status === 'decoding'
        ? 'Preparing audio on this device…'
        : `Downloading to this device${pct !== null ? ` · ${pct}%` : '…'}${
            load.status === 'loading' && load.attempt > 1 ? ` (retry ${load.attempt - 1})` : ''
          }`}
    </p>
  );
}

function readyCount(room: RoomSnapshot) {
  const connected = room.members.filter((m) => m.connected);
  return {
    total: connected.length,
    ready: connected.filter(
      (m) => m.readyTrackId !== null && m.readyTrackId === room.playback.trackId,
    ).length,
  };
}
