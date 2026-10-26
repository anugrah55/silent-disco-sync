import { useEffect, useRef, useState } from 'react';
import { LIMITS, type TrackInfo } from '@sds/shared';
import { listTracks } from '../lib/api';
import { formatTime } from '../lib/format';
import type { RoomSession, SessionState } from '../room/session';

const ACCEPT = '.mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav';

/** Host-only: the library, this room's uploads, and an upload button. */
export function TrackPicker({ session, state }: { session: RoomSession; state: SessionState }) {
  const [library, setLibrary] = useState<TrackInfo[] | null>(null);
  const [libraryError, setLibraryError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listTracks()
      .then((t) => !cancelled && setLibrary(t))
      .catch(() => !cancelled && setLibraryError(true));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const room = state.room!;
  const tracks = [...(library ?? []), ...room.uploads];

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    if (file.size > LIMITS.maxUploadBytes) {
      setUploadError('That file is over the 12 MB limit.');
      return;
    }
    setUploading(true);
    try {
      await session.upload(file);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <section className="card flex flex-col gap-3" aria-labelledby="tracks-h">
      <h2 id="tracks-h" className="font-display text-lg font-bold">
        Tracks
      </h2>

      {libraryError && (
        <div role="alert" className="flex items-center gap-3 text-sm text-bad">
          <p className="flex-1">Couldn't load the track list.</p>
          <button
            type="button"
            className="rounded-xl bg-white/10 px-3 py-2 text-white"
            onClick={() => {
              setLibraryError(false);
              setAttempt((a) => a + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!library && !libraryError && <p className="text-sm text-haze">Loading tracks…</p>}

      <ul className="flex flex-col gap-2">
        {tracks.map((t) => {
          const selected = room.track?.id === t.id;
          return (
            <li key={t.id}>
              <button
                type="button"
                disabled={!t.available}
                aria-pressed={selected}
                onClick={() => session.command({ action: 'load', trackId: t.id })}
                className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:opacity-40 ${
                  selected
                    ? 'border-neon-cyan bg-neon-cyan/10'
                    : 'border-line bg-ink hover:bg-white/5'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.title}</span>
                  <span className="block truncate text-sm text-haze">
                    {t.available ? t.artist : 'File missing on the server'}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-haze tabular-nums">
                  {t.bpm ? `${t.bpm} BPM` : t.source === 'upload' ? 'Upload' : ''}
                  <br />
                  {t.loop ? 'loops' : formatTime(t.durationSec)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        tabIndex={-1}
        aria-hidden
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button
        type="button"
        className="btn-ghost text-base"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? 'Uploading…' : 'Upload a track (mp3, m4a, wav · 12 MB)'}
      </button>
      {uploadError && (
        <p role="alert" className="text-sm text-bad">
          {uploadError}
        </p>
      )}
      <p className="text-xs text-haze">
        WAV gives the tightest sync: mp3 and m4a carry encoder padding that some browsers trim
        differently.
      </p>
    </section>
  );
}
