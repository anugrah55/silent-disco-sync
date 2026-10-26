import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createSingleClick } from '../audio/clickTrack';
import { audioEngine } from '../audio/engine';
import { NUDGE_MAX, NUDGE_MIN, nudge } from '../lib/nudge';
import { getConnection } from '../net/connection';
import { median, serverToAudioTime } from '../sync/clockSync';

const BEAT_MS = 600;
const TAPS = 8;
/** Taps further than this from a beat are stray and ignored. */
const MAX_TAP_ERROR_MS = 250;

type Phase = 'idle' | 'visual' | 'audio' | 'done';

/**
 * Tap-along calibration. Round 1 flashes silently, round 2 clicks with no
 * flash. Your own tapping habit is the same in both rounds, so the difference
 * between them is the output delay the browser can't report (Bluetooth,
 * some phone audio paths). The suggested nudge cancels it.
 */
export function Calibration() {
  const clock = getConnection().clock;
  const [phase, setPhase] = useState<Phase>('idle');
  const [lags, setLags] = useState<number[]>([]);
  const [visualLag, setVisualLag] = useState<number | null>(null);
  const [audioLag, setAudioLag] = useState<number | null>(null);
  const baseRef = useRef(0);
  const dotRef = useRef<HTMLDivElement>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const stopClicks = () => {
    for (const s of sourcesRef.current) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    sourcesRef.current = [];
  };

  // Round 1: a silent flash on the beat grid.
  useEffect(() => {
    if (phase !== 'visual') return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = dotRef.current;
      if (!el) return;
      const since = (clock.serverNow() - baseRef.current) % BEAT_MS;
      el.style.opacity = clock.serverNow() >= baseRef.current && since < 110 ? '1' : '0.12';
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, clock]);

  useEffect(() => stopClicks, []);

  function begin(next: 'visual' | 'audio') {
    if (!clock.synced) return;
    // Start on a beat comfortably in the future, on the shared grid.
    baseRef.current = Math.ceil((clock.serverNow() + 1200) / BEAT_MS) * BEAT_MS;
    setLags([]);
    setPhase(next);
    if (next === 'audio') {
      const ctx = audioEngine.unlock(); // we're inside the click, so this may unlock audio
      const click = createSingleClick(ctx);
      for (let k = 0; k < TAPS + 6; k++) {
        const at = serverToAudioTime(
          baseRef.current + k * BEAT_MS,
          clock,
          ctx,
          () => performance.now(),
          0,
        );
        const src = ctx.createBufferSource();
        src.buffer = click;
        src.connect(audioEngine.output);
        src.start(Math.max(ctx.currentTime, at.contextTime));
        sourcesRef.current.push(src);
      }
    }
  }

  function tap(timeStamp: number) {
    if (phase !== 'visual' && phase !== 'audio') return;
    const t = clock.toServerTime(timeStamp);
    const beat = baseRef.current + Math.round((t - baseRef.current) / BEAT_MS) * BEAT_MS;
    const lag = t - beat;
    if (beat < baseRef.current || Math.abs(lag) > MAX_TAP_ERROR_MS) return;
    const next = [...lags, lag];
    if (next.length < TAPS) {
      setLags(next);
      return;
    }
    // Drop the first two taps: people settle into the beat.
    const m = median(next.slice(2));
    setLags([]);
    if (phase === 'visual') {
      setVisualLag(m);
      setPhase('idle');
    } else {
      stopClicks();
      setAudioLag(m);
      setPhase('done');
    }
  }

  const onPointerDown = (e: PointerEvent) => tap(e.timeStamp);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      tap(e.timeStamp);
    }
  };

  const extra = visualLag !== null && audioLag !== null ? audioLag - visualLag : null;
  const suggested =
    extra === null ? null : Math.round(Math.max(NUDGE_MIN, Math.min(NUDGE_MAX, -extra)));
  const tapping = phase === 'visual' || phase === 'audio';

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-ink p-4">
      <h3 className="font-display text-sm font-bold">Tap-along calibration</h3>
      {tapping ? (
        <>
          <p className="text-sm text-haze" role="status">
            {phase === 'visual'
              ? 'Round 1: tap the pad in time with the flash.'
              : 'Round 2: close your eyes and tap in time with the click.'}{' '}
            {lags.length}/{TAPS}
          </p>
          <button
            type="button"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            className="grid h-40 place-items-center rounded-2xl border border-line bg-panel select-none"
            aria-label="Tap pad"
            autoFocus
          >
            <div
              ref={dotRef}
              className={`size-20 rounded-full bg-neon-cyan ${phase === 'audio' ? 'opacity-10' : ''}`}
            />
          </button>
          <button
            type="button"
            className="text-sm text-haze underline"
            onClick={() => {
              stopClicks();
              setPhase('idle');
              setLags([]);
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-haze">
            Two rounds of 8 taps, about 20 s. Best with headphones or speaker you'll use, and
            nothing else playing.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-ghost min-h-11 flex-1 text-base"
              onClick={() => begin('visual')}
            >
              {visualLag === null ? 'Round 1: flash' : `Flash ✓ (${visualLag.toFixed(0)} ms)`}
            </button>
            <button
              type="button"
              className="btn-ghost min-h-11 flex-1 text-base"
              disabled={visualLag === null}
              onClick={() => begin('audio')}
            >
              {audioLag === null ? 'Round 2: click' : `Click ✓ (${audioLag.toFixed(0)} ms)`}
            </button>
          </div>
          {suggested !== null && extra !== null && (
            <div className="flex items-center gap-3 rounded-xl bg-neon-cyan/10 px-3 py-2 text-sm">
              <p className="flex-1">
                Sound reaches you {Math.abs(extra).toFixed(0)} ms {extra >= 0 ? 'later' : 'earlier'}{' '}
                than expected. Suggested nudge:{' '}
                <strong>
                  {suggested > 0 ? '+' : ''}
                  {suggested} ms
                </strong>
              </p>
              <button
                type="button"
                className="rounded-lg bg-neon-cyan px-3 py-1.5 font-semibold text-night"
                onClick={() => nudge.set(suggested)}
              >
                Apply
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
