import type { TrackInfo } from '@sds/shared';
import { createClickBuffer } from './clickTrack';

export type LoadState =
  | { status: 'idle' }
  | { status: 'loading'; received: number; total: number | null; attempt: number }
  | { status: 'decoding' }
  | { status: 'ready'; buffer: AudioBuffer }
  | { status: 'error'; message: string };

const MAX_ATTEMPTS = 3;
/** Decoded audio is big (a 3-minute stereo track is ~70 MB as float32): keep two. */
const MAX_CACHED = 2;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Downloads and decodes tracks once, with retries and progress, and keeps a
 * tiny LRU of decoded buffers. Built-in tracks are synthesized instead.
 */
class TrackStore {
  private states = new Map<string, LoadState>();
  private inflight = new Map<string, Promise<AudioBuffer>>();
  private listeners = new Set<() => void>();

  get(id: string): LoadState {
    return this.states.get(id) ?? { status: 'idle' };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(id: string, state: LoadState): void {
    // Re-insert so Map order doubles as LRU order.
    this.states.delete(id);
    this.states.set(id, state);
    this.evict(id);
    this.listeners.forEach((l) => l());
  }

  private evict(keep: string): void {
    const ready = [...this.states.entries()].filter(([, s]) => s.status === 'ready');
    for (const [id] of ready.slice(0, Math.max(0, ready.length - MAX_CACHED))) {
      if (id !== keep) this.states.delete(id);
    }
  }

  load(track: TrackInfo, ctx: BaseAudioContext): Promise<AudioBuffer> {
    const current = this.get(track.id);
    if (current.status === 'ready') {
      this.set(track.id, current); // touch for LRU
      return Promise.resolve(current.buffer);
    }
    const pending = this.inflight.get(track.id);
    if (pending) return pending;

    const p = this.fetchAndDecode(track, ctx).finally(() => this.inflight.delete(track.id));
    this.inflight.set(track.id, p);
    return p;
  }

  /** Forget an error so the next load() starts over. */
  reset(id: string): void {
    if (this.get(id).status === 'error') this.states.delete(id);
    this.listeners.forEach((l) => l());
  }

  private async fetchAndDecode(track: TrackInfo, ctx: BaseAudioContext): Promise<AudioBuffer> {
    if (track.source === 'builtin') {
      const buffer = createClickBuffer(ctx);
      this.set(track.id, { status: 'ready', buffer });
      return buffer;
    }
    if (!track.url) throw this.fail(track.id, 'This track has no audio file.');

    let bytes: ArrayBuffer | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !bytes; attempt++) {
      try {
        bytes = await this.download(track, attempt);
      } catch (err) {
        const fatal = err instanceof HttpError && err.status >= 400 && err.status < 500;
        if (fatal || attempt === MAX_ATTEMPTS) {
          throw this.fail(
            track.id,
            err instanceof HttpError && err.status === 404
              ? 'This track is no longer on the server.'
              : 'Download failed. Check your connection.',
          );
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }

    this.set(track.id, { status: 'decoding' });
    try {
      const buffer = await ctx.decodeAudioData(bytes!);
      this.set(track.id, { status: 'ready', buffer });
      return buffer;
    } catch {
      throw this.fail(track.id, "This device can't decode that audio file.");
    }
  }

  private async download(track: TrackInfo, attempt: number): Promise<ArrayBuffer> {
    const res = await fetch(track.url!);
    if (!res.ok) throw new HttpError(res.status);
    const total = Number(res.headers.get('content-length')) || null;
    this.set(track.id, { status: 'loading', received: 0, total, attempt });
    if (!res.body) return res.arrayBuffer();

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received - lastReport > 256 * 1024) {
        lastReport = received;
        this.set(track.id, { status: 'loading', received, total, attempt });
      }
    }
    const out = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out.buffer;
  }

  private fail(id: string, message: string): Error {
    this.set(id, { status: 'error', message });
    return new Error(message);
  }
}

export const trackStore = new TrackStore();
