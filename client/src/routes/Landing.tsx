import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_RE } from '@sds/shared';
import { ColdStartHint } from '../components/ColdStartHint';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { createRoom } from '../lib/api';
import { keys, local } from '../lib/storage';

const notAllowed = new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g');

export function Landing() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const slow = useDelayedFlag(creating, 3000);

  async function start() {
    setCreating(true);
    setError(null);
    try {
      const room = await createRoom();
      local.set(keys.hostToken(room.code), room.hostToken);
      navigate(`/r/${room.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a room.');
      setCreating(false);
    }
  }

  function join(e: FormEvent) {
    e.preventDefault();
    if (ROOM_CODE_RE.test(code)) navigate(`/r/${code}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center justify-between">
        <span className="font-display text-sm font-semibold tracking-[0.25em] text-haze uppercase">
          Silent Disco Sync
        </span>
        <Link to="/lab" className="rounded-full px-3 py-1 text-sm text-haze hover:text-white">
          Sync Lab
        </Link>
      </header>

      <section className="flex flex-1 flex-col justify-center py-10">
        <h1 className="font-display text-[clamp(2.75rem,13vw,4.5rem)] leading-[0.95] font-extrabold">
          Every phone.
          <br />
          <span className="text-gradient">One speaker.</span>
        </h1>
        <p className="mt-6 max-w-sm text-lg text-haze">
          Line up your phones and press play. They start on the same millisecond, so it sounds like
          one big sound system instead of an echo.
        </p>
        <ul className="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Features">
          {[
            'Join with a QR code',
            'Millisecond sync',
            'Play any tab, even YouTube',
            'No app to install',
          ].map((f) => (
            <li key={f} className="rounded-full border border-line bg-white/5 px-3 py-1 text-haze">
              {f}
            </li>
          ))}
        </ul>
      </section>

      {/* Actions sit at the bottom so they're reachable with one thumb. */}
      <section className="flex flex-col gap-3" aria-label="Get started">
        {slow && <ColdStartHint />}
        {error && (
          <p role="alert" className="rounded-2xl bg-bad/15 px-4 py-3 text-bad">
            {error}
          </p>
        )}
        <button type="button" className="btn-primary" onClick={start} disabled={creating}>
          {creating ? 'Opening room…' : 'Start a room'}
        </button>

        {joining ? (
          <form onSubmit={join} className="flex gap-2">
            <label htmlFor="code" className="sr-only">
              Room code
            </label>
            <input
              id="code"
              className="field text-center font-display text-2xl tracking-[0.5em] uppercase"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={ROOM_CODE_LENGTH}
              placeholder="CODE"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(notAllowed, ''))}
              autoFocus
            />
            <button
              type="submit"
              className="btn-ghost shrink-0"
              disabled={!ROOM_CODE_RE.test(code)}
            >
              Go
            </button>
          </form>
        ) : (
          <button type="button" className="btn-ghost" onClick={() => setJoining(true)}>
            Join a room
          </button>
        )}
        <p className="text-center text-sm text-haze">
          Got a QR code? Just scan it with your camera.
        </p>
      </section>
    </main>
  );
}
