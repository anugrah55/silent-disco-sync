/**
 * Binary frame for one live-share chunk, sent host -> server -> everyone:
 *
 *   bytes 0-3   ASCII "SDSL"
 *   bytes 4-7   uint32 LE streamId
 *   bytes 8-11  uint32 LE chunk index
 *   bytes 12-   int16 LE mono PCM samples
 *
 * Raw PCM keeps it decodable on every browser (no codec support needed) and
 * makes the server a dumb relay.
 */
export const LIVE_MAGIC = 0x4c534453; // "SDSL" read as uint32 LE
export const LIVE_HEADER_BYTES = 12;

export function encodeLiveChunk(
  streamId: number,
  index: number,
  samples: Float32Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(LIVE_HEADER_BYTES + samples.length * 2);
  const view = new DataView(buf);
  view.setUint32(0, LIVE_MAGIC, true);
  view.setUint32(4, streamId >>> 0, true);
  view.setUint32(8, index >>> 0, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(LIVE_HEADER_BYTES + i * 2, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true);
  }
  return buf;
}

export interface LiveChunk {
  streamId: number;
  index: number;
  samples: Float32Array<ArrayBuffer>;
}

export function decodeLiveChunk(data: ArrayBuffer | Uint8Array): LiveChunk | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < LIVE_HEADER_BYTES || (bytes.byteLength - LIVE_HEADER_BYTES) % 2)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LIVE_MAGIC) return null;
  const n = (bytes.byteLength - LIVE_HEADER_BYTES) / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(LIVE_HEADER_BYTES + i * 2, true) / 0x8000;
  return { streamId: view.getUint32(4, true), index: view.getUint32(8, true), samples };
}

/** Peek at the header without decoding samples (used by the server relay). */
export function peekLiveHeader(
  bytes: Uint8Array,
): { streamId: number; index: number; samples: number } | null {
  if (bytes.byteLength < LIVE_HEADER_BYTES || (bytes.byteLength - LIVE_HEADER_BYTES) % 2)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LIVE_MAGIC) return null;
  return {
    streamId: view.getUint32(4, true),
    index: view.getUint32(8, true),
    samples: (bytes.byteLength - LIVE_HEADER_BYTES) / 2,
  };
}
