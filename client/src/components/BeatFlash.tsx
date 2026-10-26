import { useEffect, useRef, useSyncExternalStore } from 'react';
import { positionAt, type RoomSnapshot } from '@sds/shared';
import { flashPref } from '../lib/flashPref';
import { nudge } from '../lib/nudge';
import { getConnection } from '../net/connection';

/** Never flash more than this many times per second (WCAG 2.3.1 allows 3). */
const MAX_FLASHES_PER_SEC = 2.9;
const COLORS = ['#ff2bd6', '#22e6ff', '#8b5cf6', '#22e6ff'];

/**
 * Full-screen pulse on every beat, computed each frame from the shared clock,
 * so every phone in the room flashes at the same instant. Shifted by this
 * device's nudge so the flash lines up with the sound it actually plays.
 * Strong for the click track, a soft edge glow for music.
 */
export function BeatFlash({ room }: { room: RoomSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  const roomRef = useRef(room);
  const pref = useSyncExternalStore(flashPref.subscribe, flashPref.get);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    const el = ref.current;
    if (!el || pref === 'off') return;
    const clock = getConnection().clock;
    let raf = 0;
    let lastColor = '';
    const hide = () => {
      if (el.style.opacity !== '0') el.style.opacity = '0';
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { playback, track, live } = roomRef.current;
      if (
        live ||
        !track?.bpm ||
        playback.status !== 'playing' ||
        playback.trackId !== track.id ||
        !clock.synced
      ) {
        return hide();
      }
      // The sample this device emits now belongs to server time (now - nudge).
      const heard = clock.serverNow() - nudge.get();
      if (heard < playback.startServerMs) return hide();
      const pos = positionAt(playback, heard, track.durationSec, track.loop);
      if (!track.loop && track.durationSec && pos >= track.durationSec) return hide();
      const beats = (pos * track.bpm) / 60;
      const beat = Math.floor(beats);
      const every = Math.ceil(track.bpm / 60 / MAX_FLASHES_PER_SEC);
      if (beat % every !== 0) return hide();
      const phase = beats - beat;
      const decay = Math.max(0, 1 - phase / 0.35) ** 2;
      const click = track.source === 'builtin';
      const peak = (click ? 0.85 : 0.45) * (pref === 'gentle' ? 0.3 : 1);
      el.style.opacity = String(peak * decay);
      const color = COLORS[(beat / every) % COLORS.length]!;
      if (color !== lastColor) {
        lastColor = color;
        el.style.background = click
          ? color
          : `radial-gradient(ellipse at center, transparent 45%, ${color} 100%)`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      hide();
    };
  }, [pref]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-40 opacity-0 mix-blend-screen"
    />
  );
}

export function FlashToggle() {
  const pref = useSyncExternalStore(flashPref.subscribe, flashPref.get);
  const options: Array<[typeof pref, string]> = [
    ['on', 'On'],
    ['gentle', 'Gentle'],
    ['off', 'Off'],
  ];
  return (
    <fieldset className="flex items-center gap-3">
      <legend className="sr-only">Beat flash</legend>
      <span aria-hidden className="text-sm text-haze">
        Beat flash
      </span>
      <div className="flex flex-1 rounded-xl bg-ink p-1">
        {options.map(([v, label]) => (
          <label
            key={v}
            className={`flex-1 cursor-pointer rounded-lg py-1.5 text-center text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-neon-cyan ${
              pref === v ? 'bg-white/15 font-semibold' : 'text-haze'
            }`}
          >
            <input
              type="radio"
              name="flash"
              value={v}
              checked={pref === v}
              onChange={() => flashPref.set(v)}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
