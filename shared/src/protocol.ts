/**
 * Wire protocol for Silent Disco Sync. Every WebSocket message is JSON with a
 * `type` discriminator. Both sides validate incoming messages with these zod
 * schemas, and the TypeScript types are inferred from them so they can't drift.
 *
 * Time convention: every `*ServerMs` / `ts` value is SERVER time in epoch
 * milliseconds (performance.timeOrigin + performance.now() on the server, so
 * sub-millisecond resolution and immune to wall-clock steps). Client-side
 * `t0` is the client's own performance.now() and is echoed back untouched.
 */
import { z } from 'zod';
import { LEAD, LIMITS, ROOM_CODE_RE } from './limits';

const finite = z.number().finite();
const roomCode = z.string().regex(ROOM_CODE_RE);
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const trackId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

// ---------- shared shapes ----------

export const syncStatsSchema = z.object({
  offsetMs: finite,
  /** Typical (median) round trip of the latest burst; drives lead time. */
  rttMs: finite.nonnegative(),
  /** Std deviation of the trusted samples' offsets. */
  jitterMs: finite.nonnegative(),
  /** Estimated error of the offset (jitter + stability + pending slew). */
  errorMs: finite.nonnegative(),
  /** Worst-case error if the path were fully asymmetric: best RTT / 2. */
  boundMs: finite.nonnegative(),
  samples: z.number().int().nonnegative(),
});
export type SyncStats = z.infer<typeof syncStatsSchema>;

export const playbackStatusSchema = z.enum(['idle', 'playing', 'paused']);
export type PlaybackStatus = z.infer<typeof playbackStatusSchema>;

/**
 * Server-authoritative playback state. While playing, the track position at
 * server time T is positionAtStartSec + (T - startServerMs) / 1000.
 */
export const playbackStateSchema = z.object({
  trackId: trackId.nullable(),
  status: playbackStatusSchema,
  startServerMs: finite,
  positionAtStartSec: finite.nonnegative(),
  /** Increments on every command so clients can ignore stale state. */
  seq: z.number().int().nonnegative(),
});
export type PlaybackState = z.infer<typeof playbackStateSchema>;

export const trackInfoSchema = z.object({
  id: trackId,
  title: z.string(),
  artist: z.string(),
  durationSec: finite.nonnegative().nullable(),
  bpm: finite.positive().nullable(),
  /** 'builtin' tracks are synthesized on the client (the click track). */
  source: z.enum(['library', 'upload', 'builtin']),
  url: z.string().nullable(),
  available: z.boolean(),
});
export type TrackInfo = z.infer<typeof trackInfoSchema>;

export const memberSchema = z.object({
  id: clientId,
  name: z.string(),
  isHost: z.boolean(),
  connected: z.boolean(),
  readyTrackId: trackId.nullable(),
  nudgeMs: finite,
  sync: syncStatsSchema.nullable(),
});
export type Member = z.infer<typeof memberSchema>;

export const roomSnapshotSchema = z.object({
  code: roomCode,
  members: z.array(memberSchema),
  playback: playbackStateSchema,
  track: trackInfoSchema.nullable(),
  leadMs: finite,
});
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

// ---------- client -> server ----------

export const pingMsg = z.object({ type: z.literal('ping'), t0: finite });

export const joinMsg = z.object({
  type: z.literal('join'),
  code: roomCode,
  clientId,
  name: z.string().trim().min(1).max(LIMITS.maxNameLength),
  hostToken: z.string().max(64).optional(),
});

export const leaveMsg = z.object({ type: z.literal('leave') });

export const trackReadyMsg = z.object({ type: z.literal('trackReady'), trackId });

export const commandMsg = z.discriminatedUnion('action', [
  z.object({
    type: z.literal('command'),
    action: z.literal('load'),
    trackId,
  }),
  z.object({
    type: z.literal('command'),
    action: z.literal('play'),
    /** Optional start position; defaults to the current/paused position. */
    positionSec: finite.nonnegative().optional(),
    force: z.boolean().optional(),
  }),
  z.object({ type: z.literal('command'), action: z.literal('pause') }),
  z.object({
    type: z.literal('command'),
    action: z.literal('seek'),
    positionSec: finite.nonnegative(),
  }),
  z.object({
    type: z.literal('command'),
    action: z.literal('setLead'),
    /** null = automatic lead time from the worst RTT. */
    leadMs: z.number().int().min(LEAD.minMs).max(LEAD.maxMs).nullable(),
  }),
]);

export const syncReportMsg = z.object({ type: z.literal('syncReport'), sync: syncStatsSchema });

export const nudgeReportMsg = z.object({
  type: z.literal('nudgeReport'),
  nudgeMs: z.number().min(-250).max(250),
});

export const clientMessageSchema = z.union([
  pingMsg,
  joinMsg,
  leaveMsg,
  trackReadyMsg,
  commandMsg,
  syncReportMsg,
  nudgeReportMsg,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type CommandMessage = z.infer<typeof commandMsg>;

// ---------- server -> client ----------

export const pongMsg = z.object({ type: z.literal('pong'), t0: finite, ts: finite });

export const welcomeMsg = z.object({
  type: z.literal('welcome'),
  clientId,
  isHost: z.boolean(),
  room: roomSnapshotSchema,
});

export const roomStateMsg = z.object({ type: z.literal('roomState'), room: roomSnapshotSchema });

export const presenceMsg = z.object({
  type: z.literal('presence'),
  members: z.array(memberSchema),
});

export const errorCodeSchema = z.enum([
  'bad_message',
  'room_not_found',
  'room_full',
  'not_joined',
  'not_host',
  'track_not_found',
  'not_ready',
  'rate_limited',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorMsg = z.object({
  type: z.literal('error'),
  code: errorCodeSchema,
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  pongMsg,
  welcomeMsg,
  roomStateMsg,
  presenceMsg,
  errorMsg,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------- REST ----------

export const createRoomResponseSchema = z.object({ code: roomCode, hostToken: z.string() });
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;
