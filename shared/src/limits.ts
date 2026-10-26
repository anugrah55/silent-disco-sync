/** Hard caps and timing defaults shared by client and server. */
export const LIMITS = {
  maxRooms: 50,
  maxClientsPerRoom: 30,
  maxUploadBytes: 12 * 1024 * 1024,
  maxUploadsPerRoom: 5,
  maxNameLength: 24,
  roomIdleMs: 2 * 60 * 60 * 1000,
  wsMaxPayloadBytes: 16 * 1024,
  /** 200 ms at 24 kHz; keeps one binary frame well under wsMaxPayloadBytes. */
  maxLiveChunkSamples: 4800,
} as const;

export const LEAD = {
  defaultMs: 2000,
  minMs: 1500,
  maxMs: 4000,
} as const;

/** 4-char room codes avoid look-alike characters (0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export const WS_PATH = '/ws';

/** The built-in sync test signal, synthesized on each device (no download). */
export const CLICK_TRACK = {
  id: 'click',
  bpm: 120,
  bars: 4,
  get durationSec() {
    return (this.bars * 4 * 60) / this.bpm;
  },
} as const;

/** Live share audio format: mono 16-bit PCM, 100 ms per chunk (~384 kbit/s). */
export const LIVE = {
  sampleRate: 24_000,
  chunkSamples: 2_400,
  minDelayMs: 2_000,
  maxDelayMs: 5_000,
} as const;
