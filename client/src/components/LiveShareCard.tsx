import { canShareTabAudio } from '../live/capture';
import type { RoomSession, SessionState } from '../room/session';

/** Host-only: share a browser tab's audio (YouTube, Spotify Web, ...) with the room. */
export function LiveShareCard({ session, state }: { session: RoomSession; state: SessionState }) {
  const capture = state.liveCapture;
  const delaySec = ((state.room?.live?.delayMs ?? 2500) / 1000).toFixed(1);

  if (!canShareTabAudio()) {
    return (
      <section className="card flex flex-col gap-2" aria-labelledby="live-h">
        <h2 id="live-h" className="font-display text-lg font-bold">
          Live share a tab
        </h2>
        <p className="text-sm text-haze">
          To play YouTube or any other site to the room, open this room as host in Chrome, Edge or
          Brave on a computer. Phones and Safari can't share tab audio.
        </p>
      </section>
    );
  }

  return (
    <section className="card flex flex-col gap-3" aria-labelledby="live-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="live-h" className="font-display text-lg font-bold">
          Live share a tab
        </h2>
        {capture.state === 'live' && <LiveBadge />}
      </div>

      {capture.state === 'live' ? (
        <>
          <p className="text-sm">
            Sharing <strong>{capture.label}</strong>. Control the music in that tab as usual;
            everyone hears it in sync, about {delaySec} s later.
          </p>
          <button type="button" className="btn-ghost" onClick={() => session.stopLiveShare()}>
            Stop sharing
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-haze">
            Play anything in another tab (YouTube, Spotify Web, SoundCloud) and every phone plays it
            in sync. In the browser's picker choose the tab and keep{' '}
            <strong className="text-white">Also share tab audio</strong> on.
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={capture.state === 'picking'}
            // Synchronous call inside the click: the capture context needs the gesture.
            onClick={() => session.startLiveShare()}
          >
            {capture.state === 'picking' ? 'Choose a tab…' : 'Share tab audio'}
          </button>
          {capture.state === 'error' && (
            <p role="alert" className="text-sm text-bad">
              {capture.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function LiveBadge() {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-bad/20 px-3 py-1 text-xs font-bold tracking-widest text-bad">
      <span
        aria-hidden
        className="size-2 animate-pulse rounded-full bg-bad motion-reduce:animate-none"
      />
      LIVE
    </span>
  );
}
