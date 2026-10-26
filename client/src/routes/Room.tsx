import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { LIMITS, ROOM_CODE_RE } from '@sds/shared';
import { audioEngine } from '../audio/engine';
import { BeatFlash } from '../components/BeatFlash';
import { ConnectionPill } from '../components/ConnectionPill';
import { ListenerList } from '../components/ListenerList';
import { LiveShareCard } from '../components/LiveShareCard';
import { NowPlaying } from '../components/NowPlaying';
import { TrackPicker } from '../components/TrackPicker';
import { QrCode } from '../components/QrCode';
import { SoundOverlay } from '../components/SoundOverlay';
import { joinUrl, roomExists } from '../lib/api';
import { keys, local } from '../lib/storage';
import { getRoomSession } from '../room/session';
import { NotFound } from './NotFound';

type Check = 'checking' | 'ok' | 'missing' | 'offline';

export function RoomRoute() {
  const code = (useParams().code ?? '').toUpperCase();
  const valid = ROOM_CODE_RE.test(code);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; check: Check } | null>(null);
  // A result only counts for the code/attempt it was fetched for; anything else is still loading.
  const key = `${code}:${attempt}`;
  const check: Check = result?.key === key ? result.check : 'checking';

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    roomExists(code)
      .then((exists) => !cancelled && setResult({ key, check: exists ? 'ok' : 'missing' }))
      .catch(() => !cancelled && setResult({ key, check: 'offline' }));
    return () => {
      cancelled = true;
    };
  }, [code, valid, key]);

  if (!valid || check === 'missing') {
    return (
      <NotFound
        title="Room not found"
        message={`There's no room with code ${code || '—'}. It may have expired, or the code has a typo.`}
      />
    );
  }
  if (check === 'offline') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
        <h1 className="font-display text-3xl font-bold">Can't reach the server</h1>
        <p className="text-haze">Check your connection. Free hosting can take ~30 s to wake up.</p>
        <button type="button" className="btn-primary" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </button>
      </main>
    );
  }
  if (check === 'checking') {
    return (
      <main className="grid min-h-dvh place-items-center text-haze">Finding room {code}…</main>
    );
  }
  return <Room key={code} code={code} />;
}

function Room({ code }: { code: string }) {
  // Sessions persist across routes, so a trip to the Sync Lab keeps your seat.
  const session = useMemo(() => getRoomSession(code), [code]);
  const state = useSyncExternalStore(session.subscribe, session.getState);

  const hostToken = local.get(keys.hostToken(code)) ?? undefined;

  if (state.phase === 'idle') {
    return (
      <JoinGate
        code={code}
        isHost={!!hostToken}
        onJoin={(name) => session.start(name, hostToken)}
      />
    );
  }
  if (state.phase === 'error') {
    return (
      <NotFound title="Can't join" message={state.error?.message ?? 'Something went wrong.'} />
    );
  }

  const url = joinUrl(code);
  const me = state.room?.members.find((m) => m.id === state.clientId);
  const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <SoundOverlay />
      {state.room && <BeatFlash room={state.room} />}
      <header className="flex items-center justify-between">
        <Link
          to="/"
          className="text-haze hover:text-white"
          aria-label="Leave and go home"
          onClick={() => session.leave()}
        >
          ← Leave
        </Link>
        <ConnectionPill status={state.socket} />
      </header>

      {state.updateAvailable && (
        <div role="alert" className="flex items-center gap-3 rounded-2xl bg-neon-cyan/15 px-4 py-3">
          <p className="flex-1 text-sm">A new version is live. Reload to stay in sync.</p>
          <button
            type="button"
            className="rounded-xl bg-neon-cyan px-4 py-2 font-semibold text-night"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </div>
      )}

      <section className="text-center">
        <p className="text-sm tracking-[0.25em] text-haze uppercase">Room code</p>
        <p className="font-display text-6xl font-extrabold tracking-[0.2em] text-gradient">
          {code}
        </p>
        {state.isHost && <p className="mt-1 text-sm text-neon-cyan">You're the host</p>}
      </section>

      {state.room && <NowPlaying session={session} state={state} />}

      {state.isHost && state.room && <LiveShareCard session={session} state={state} />}

      {state.isHost && state.room && <TrackPicker session={session} state={state} />}

      {state.isHost && (
        <InviteCard
          url={url}
          code={code}
          onLocalhost={onLocalhost}
          // Big QR until the music starts; then it folds away to keep controls in reach.
          compact={!!state.room?.track || !!state.room?.live}
        />
      )}
      {!state.isHost && me && (
        <p className="text-center text-sm text-haze">
          You're in, {me.name}. Keep this screen open and the volume up.
        </p>
      )}

      <section className="card" aria-labelledby="listeners-h">
        <div className="flex items-baseline justify-between">
          <h2 id="listeners-h" className="font-display text-lg font-bold">
            Listeners
          </h2>
          <Link to="/lab" className="text-sm text-haze tabular-nums hover:text-white">
            {state.sync ? `RTT ${state.sync.rttMs.toFixed(0)} ms · ` : ''}Sync Lab →
          </Link>
        </div>
        {state.room ? (
          <ListenerList
            members={state.room.members}
            meId={state.clientId}
            trackId={state.room.playback.trackId}
          />
        ) : (
          <p className="py-4 text-haze">Connecting…</p>
        )}
      </section>

      {state.error && state.phase === 'joined' && state.error.code !== 'not_ready' && (
        <p role="alert" className="rounded-2xl bg-bad/15 px-4 py-3 text-bad">
          {state.error.message}
        </p>
      )}
    </main>
  );
}

function JoinGate({
  code,
  isHost,
  onJoin,
}: {
  code: string;
  isHost: boolean;
  onJoin: (name: string) => void;
}) {
  const [name, setName] = useState(() => local.get(keys.name) ?? '');
  const trimmed = name.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    // Must run synchronously inside the tap: this is what unlocks audio on iOS.
    audioEngine.unlock();
    local.set(keys.name, trimmed);
    onJoin(trimmed);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-end gap-6 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex-1" />
      <p className="text-sm tracking-[0.25em] text-haze uppercase">Room {code}</p>
      <h1 className="font-display text-5xl leading-none font-extrabold">
        {isHost ? (
          <>
            Your room <span className="text-gradient">is ready.</span>
          </>
        ) : (
          <>
            You're <span className="text-gradient">invited.</span>
          </>
        )}
      </h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="name" className="text-haze">
          Your display name
        </label>
        <input
          id="name"
          className="field"
          value={name}
          maxLength={LIMITS.maxNameLength}
          autoComplete="nickname"
          placeholder="e.g. DJ Nova"
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <button type="submit" className="btn-primary min-h-16 text-xl" disabled={!trimmed}>
          {isHost ? 'Open the room' : 'Join the party'}
        </button>
        <p className="text-center text-sm text-haze">
          Tapping this also turns on sound for this page.
        </p>
      </form>
    </main>
  );
}

function InviteCard({
  url,
  code,
  onLocalhost,
  compact,
}: {
  url: string;
  code: string;
  onLocalhost: boolean;
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const showQr = !compact || expanded;
  return (
    <section className="card flex flex-col items-center gap-4" aria-label="Invite listeners">
      {compact && (
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="font-display text-lg font-bold">Invite more people</span>
          <span className="text-sm text-haze">{expanded ? 'Hide QR' : 'Show QR'}</span>
        </button>
      )}
      {showQr && (
        <>
          <QrCode value={url} />
          <p className="text-center text-sm break-all text-haze">{url}</p>
          {onLocalhost && !import.meta.env.VITE_PUBLIC_ORIGIN && (
            <p role="note" className="rounded-xl bg-ok/15 px-3 py-2 text-sm text-ok">
              This QR points at localhost, which phones can't reach. Open this page via your
              laptop's LAN IP (Vite prints it as "Network"), or set VITE_PUBLIC_ORIGIN.
            </p>
          )}
        </>
      )}
      <ShareButton url={url} code={code} />
    </section>
  );
}

function ShareButton({ url, code }: { url: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my silent disco', text: `Room ${code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* user cancelled share, or clipboard blocked on insecure origin */
    }
  }
  return (
    <button type="button" className="btn-ghost w-full" onClick={share}>
      {copied ? 'Link copied' : 'Share invite link'}
    </button>
  );
}
