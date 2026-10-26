import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { WebSocket } from 'ws';
import {
  LIMITS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type Member,
  type PlaybackState,
  type RoomSnapshot,
  type SyncStats,
  type TrackInfo,
} from '@sds/shared';
import { serverNow } from './clock';
import { autoLeadMs } from './leadTime';
import type { TrackLibrary } from './tracks';

/** How long a dropped client keeps its seat so a reconnect looks seamless. */
export const DISCONNECT_GRACE_MS = 2 * 60 * 1000;

export interface Client {
  id: string;
  name: string;
  isHost: boolean;
  ws: WebSocket | null;
  readyTrackId: string | null;
  nudgeMs: number;
  sync: SyncStats | null;
  disconnectedAt: number | null;
}

export interface Room {
  code: string;
  hostToken: string;
  clients: Map<string, Client>;
  playback: PlaybackState;
  track: TrackInfo | null;
  /** null = automatic lead time from worst RTT. */
  leadOverrideMs: number | null;
  lastActivity: number;
  /** Host uploads; files live in the OS temp dir and are deleted with the room. */
  uploads: Map<string, Upload>;
}

export interface Upload {
  info: TrackInfo;
  path: string;
  mime: string;
}

export type JoinResult =
  | { ok: true; client: Client; replaced: WebSocket | null }
  | { ok: false; code: 'room_not_found' | 'room_full' };

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private changeListeners = new Set<(room: Room) => void>();

  /** Subscribe to "room state changed outside the socket layer" (e.g. an HTTP upload). */
  onChange(fn: (room: Room) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  changed(room: Room): void {
    this.changeListeners.forEach((fn) => fn(room));
  }

  constructor(
    private readonly opts: {
      leadMsDefault: number;
      library?: TrackLibrary;
      onExpire?: (room: Room) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  create(): Room | null {
    if (this.rooms.size >= LIMITS.maxRooms) {
      this.sweep();
      if (this.rooms.size >= LIMITS.maxRooms) return null;
    }
    let code: string;
    do {
      code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)],
      ).join('');
    } while (this.rooms.has(code));

    const room: Room = {
      code,
      hostToken: randomBytes(24).toString('base64url'),
      clients: new Map(),
      playback: {
        trackId: null,
        status: 'idle',
        startServerMs: serverNow(),
        positionAtStartSec: 0,
        seq: 0,
      },
      track: null,
      leadOverrideMs: null,
      lastActivity: this.now(),
      uploads: new Map(),
    };
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  touch(room: Room): void {
    room.lastActivity = this.now();
  }

  join(
    code: string,
    params: { clientId: string; name: string; hostToken?: string | undefined; ws: WebSocket },
  ): JoinResult {
    const room = this.get(code);
    if (!room) return { ok: false, code: 'room_not_found' };
    this.pruneDisconnected(room);

    const isHost = params.hostToken !== undefined && tokenEquals(params.hostToken, room.hostToken);
    const existing = room.clients.get(params.clientId);
    if (existing) {
      const replaced = existing.ws && existing.ws !== params.ws ? existing.ws : null;
      existing.ws = params.ws;
      existing.name = params.name;
      existing.isHost = existing.isHost || isHost;
      existing.disconnectedAt = null;
      this.touch(room);
      return { ok: true, client: existing, replaced };
    }

    if (room.clients.size >= LIMITS.maxClientsPerRoom) return { ok: false, code: 'room_full' };

    const client: Client = {
      id: params.clientId,
      name: params.name,
      isHost,
      ws: params.ws,
      readyTrackId: null,
      nudgeMs: 0,
      sync: null,
      disconnectedAt: null,
    };
    room.clients.set(client.id, client);
    this.touch(room);
    return { ok: true, client, replaced: null };
  }

  /** Socket dropped: keep the seat for a grace period. */
  disconnect(room: Room, client: Client): void {
    client.ws = null;
    client.disconnectedAt = this.now();
    this.touch(room);
  }

  /** Explicit leave: free the seat now. */
  leave(room: Room, client: Client): void {
    room.clients.delete(client.id);
    this.touch(room);
  }

  pruneDisconnected(room: Room): void {
    const cutoff = this.now() - DISCONNECT_GRACE_MS;
    for (const [id, c] of room.clients) {
      if (c.disconnectedAt !== null && c.disconnectedAt < cutoff) room.clients.delete(id);
    }
  }

  leadMs(room: Room): number {
    if (room.leadOverrideMs !== null) return room.leadOverrideMs;
    const rtts: number[] = [];
    for (const c of room.clients.values()) if (c.ws && c.sync) rtts.push(c.sync.rttMs);
    return autoLeadMs(rtts, this.opts.leadMsDefault);
  }

  members(room: Room): Member[] {
    return [...room.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      isHost: c.isHost,
      connected: c.ws !== null,
      readyTrackId: c.readyTrackId,
      nudgeMs: c.nudgeMs,
      sync: c.sync,
    }));
  }

  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      members: this.members(room),
      playback: room.playback,
      track: room.track,
      uploads: [...room.uploads.values()].map((u) => u.info),
      leadMs: this.leadMs(room),
    };
  }

  /** Remove rooms idle for longer than LIMITS.roomIdleMs. */
  sweep(): void {
    const cutoff = this.now() - LIMITS.roomIdleMs;
    for (const room of this.rooms.values()) {
      this.pruneDisconnected(room);
      const anyoneConnected = [...room.clients.values()].some((c) => c.ws !== null);
      if (room.lastActivity < cutoff && !anyoneConnected) this.destroy(room);
    }
  }

  destroy(room: Room): void {
    this.rooms.delete(room.code);
    for (const c of room.clients.values()) c.ws?.close(4004, 'room expired');
    for (const u of room.uploads.values()) rm(u.path, { force: true }).catch(() => {});
    room.uploads.clear();
    this.opts.onExpire?.(room);
  }

  /** Find an uploaded track in any room (for the streaming endpoint). */
  findUpload(id: string): Upload | undefined {
    for (const room of this.rooms.values()) {
      const u = room.uploads.get(id);
      if (u) return u;
    }
    return undefined;
  }

  /** Track metadata as seen from a room: library, built-in, or that room's uploads. */
  trackInfo(room: Room, id: string): TrackInfo | undefined {
    return room.uploads.get(id)?.info ?? this.opts.library?.info(id);
  }

  /** Register an upload, evicting the oldest one that isn't loaded when full. */
  addUpload(room: Room, upload: Upload): void {
    if (room.uploads.size >= LIMITS.maxUploadsPerRoom) {
      const victim = [...room.uploads.values()].find((u) => u.info.id !== room.playback.trackId);
      if (victim) {
        room.uploads.delete(victim.info.id);
        rm(victim.path, { force: true }).catch(() => {});
      }
    }
    room.uploads.set(upload.info.id, upload);
    this.touch(room);
  }

  startSweeper(intervalMs = 60_000): void {
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  stats(): { rooms: number; clients: number } {
    let clients = 0;
    for (const r of this.rooms.values()) for (const c of r.clients.values()) if (c.ws) clients++;
    return { rooms: this.rooms.size, clients };
  }
}

export function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
