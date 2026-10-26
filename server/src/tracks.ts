import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CLICK_TRACK, type TrackInfo } from '@sds/shared';

const manifestSchema = z.array(
  z.object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    title: z.string(),
    artist: z.string(),
    file: z.string().regex(/^[^/\\]+\.(mp3|m4a|wav)$/i),
    bpm: z.number().positive().nullable().optional(),
    durationSec: z.number().positive().nullable().optional(),
  }),
);

export interface LibraryTrack {
  info: TrackInfo;
  path: string;
  mime: string;
}

export const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

export const CLICK_TRACK_INFO: TrackInfo = {
  id: CLICK_TRACK.id,
  title: 'Sync test click',
  artist: `Built-in · ${CLICK_TRACK.bpm} BPM`,
  durationSec: CLICK_TRACK.durationSec,
  bpm: CLICK_TRACK.bpm,
  source: 'builtin',
  url: null,
  available: true,
  loop: true,
};

/**
 * Tracks listed in assets/tracks.json. Missing or unreadable files are kept in
 * the list as unavailable rather than crashing the server, so a fresh clone
 * without audio still boots.
 */
export class TrackLibrary {
  readonly tracks = new Map<string, LibraryTrack>();

  constructor(readonly dir: string) {
    const manifestPath = path.join(dir, 'tracks.json');
    if (!existsSync(manifestPath)) {
      console.warn(`[tracks] no manifest at ${manifestPath}; only the click track is available`);
      return;
    }
    let entries: z.infer<typeof manifestSchema>;
    try {
      entries = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch (err) {
      console.warn('[tracks] invalid tracks.json, ignoring it:', err);
      return;
    }
    for (const e of entries) {
      const file = path.join(dir, e.file);
      const available = existsSync(file) && statSync(file).size > 0;
      if (!available)
        console.warn(`[tracks] ${e.file} is missing; listing "${e.title}" as unavailable`);
      this.tracks.set(e.id, {
        path: file,
        mime: MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        info: {
          id: e.id,
          title: e.title,
          artist: e.artist,
          durationSec: e.durationSec ?? null,
          bpm: e.bpm ?? null,
          source: 'library',
          url: `/api/tracks/${encodeURIComponent(e.id)}`,
          available,
          loop: false,
        },
      });
    }
  }

  list(): TrackInfo[] {
    return [CLICK_TRACK_INFO, ...[...this.tracks.values()].map((t) => t.info)];
  }

  info(id: string): TrackInfo | undefined {
    return id === CLICK_TRACK_INFO.id ? CLICK_TRACK_INFO : this.tracks.get(id)?.info;
  }
}

/** Check the first bytes so a renamed .exe can't pose as audio. */
export function sniffAudio(head: Buffer): 'mp3' | 'm4a' | 'wav' | null {
  if (
    head.length >= 12 &&
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'wav';
  }
  if (head.length >= 8 && head.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (head.length >= 3 && head.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  // Bare MPEG audio frame sync: 11 set bits.
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}
