import {
  uploadResponseSchema,
  type CommandMessage,
  type ErrorCode,
  type RoomSnapshot,
  type TrackInfo,
} from '@sds/shared';
import { audioEngine } from '../audio/engine';
import { Player } from '../audio/player';
import { trackStore, type LoadState } from '../audio/trackStore';
import { getClientId } from '../lib/ids';
import { nudge } from '../lib/nudge';
import { getConnection, type Connection } from '../net/connection';
import type { SocketStatus } from '../net/socket';
import type { SyncStatsSnapshot } from '../sync/clockSync';

export interface SessionState {
  phase: 'idle' | 'connecting' | 'joined' | 'error';
  socket: SocketStatus;
  error: { code: ErrorCode | 'replaced' | 'expired'; message: string } | null;
  room: RoomSnapshot | null;
  clientId: string;
  isHost: boolean;
  sync: SyncStatsSnapshot | null;
  /** The server runs a newer build than this tab: the user should reload. */
  updateAvailable: boolean;
  /** Download/decode progress of the room's current track on this device. */
  trackLoad: LoadState;
}

/** A command message without its `type` tag (distributes over the union). */
type Command = CommandMessage extends infer C
  ? C extends unknown
    ? Omit<C, 'type'>
    : never
  : never;

/**
 * Membership in one room, on top of the tab's shared connection. Joins on
 * every socket open (so reconnects rejoin automatically), reports sync quality
 * after every sync burst, and exposes an immutable snapshot for React's
 * useSyncExternalStore. Sessions outlive the room screen, so visiting the
 * Sync Lab and coming back keeps your seat.
 */
export class RoomSession {
  private readonly conn: Connection;
  private listeners = new Set<() => void>();
  private cleanups: Array<() => void> = [];
  private name = '';
  private hostToken: string | undefined;
  private state: SessionState;
  readonly player: Player;
  private readySent: string | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly code: string) {
    this.conn = getConnection();
    this.state = {
      phase: 'idle',
      socket: this.conn.socket.status,
      error: null,
      room: null,
      clientId: getClientId(),
      isHost: false,
      sync: this.conn.clock.synced ? this.conn.clock.stats() : null,
      updateAvailable: false,
      trackLoad: { status: 'idle' },
    };
    this.player = new Player(this.conn.clock, nudge.get, (playing) => {
      this.conn.playing = playing;
    });
  }

  getState = (): SessionState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  start(name: string, hostToken: string | undefined): void {
    this.name = name;
    this.hostToken = hostToken;
    if (this.cleanups.length) return;
    const { socket, clock } = this.conn;
    this.set({ phase: 'connecting', error: null });

    this.cleanups.push(
      socket.onStatus((status, info) => {
        this.set({ socket: status });
        if (status === 'open') this.sendJoin();
        if (status === 'closed' && info?.code === 4001) {
          this.fail('replaced', 'This room was opened in another tab.');
        }
        if (status === 'closed' && info?.code === 4004) {
          this.fail('expired', 'This room has expired.');
        }
      }),
      socket.on('welcome', (msg) => {
        if (msg.room.code !== this.code) return;
        this.set({
          phase: 'joined',
          isHost: msg.isHost,
          room: msg.room,
          error: null,
          updateAvailable: msg.buildId !== null && msg.buildId !== __BUILD_ID__,
        });
        // (Re)joined: re-announce readiness and rejoin playback at the live position.
        this.readySent = null;
        this.player.invalidate();
        this.syncPlayback();
        this.reportSync();
        socket.send({ type: 'nudgeReport', nudgeMs: nudge.get() });
      }),
      socket.on('roomState', (msg) => {
        if (msg.room.code !== this.code) return;
        // A command went through, so any earlier "not ready" warning is stale.
        this.set({ room: msg.room, error: null });
        this.syncPlayback();
      }),
      socket.on('presence', (msg) => {
        if (this.state.room) this.set({ room: { ...this.state.room, members: msg.members } });
      }),
      socket.on('error', (msg) => {
        if (msg.code === 'room_not_found' || msg.code === 'room_full') {
          this.fail(msg.code, msg.message);
        } else if (msg.code === 'bad_message' || msg.code === 'not_joined') {
          // Protocol hiccups (usually a stale tab after a deploy) mean nothing to
          // a listener; the update banner covers the stale-tab case.
          console.warn('[sds] server rejected a message:', msg.message);
        } else {
          this.set({ error: { code: msg.code, message: msg.message } });
        }
      }),
      clock.onUpdate(() => {
        this.reportSync();
        // The first burst may land after the track decoded (late join): schedule now.
        this.syncPlayback();
      }),
      nudge.subscribe(() => {
        if (this.state.phase === 'joined')
          socket.send({ type: 'nudgeReport', nudgeMs: nudge.get() });
        // Re-schedule with the new nudge once the slider settles.
        if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
        this.nudgeTimer = setTimeout(() => {
          this.player.invalidate();
          this.syncPlayback();
        }, 300);
      }),
      trackStore.subscribe(() => {
        const id = this.state.room?.track?.id;
        this.set({ trackLoad: id ? trackStore.get(id) : { status: 'idle' } });
      }),
      audioEngine.onStateChange((s) => {
        // A context that was suspended (iOS interruption, autoplay) lost its
        // schedule; rejoin at the live position once it runs again.
        if (s === 'running') {
          this.player.invalidate();
          this.syncPlayback();
        }
      }),
    );

    this.set({ socket: socket.status });
    if (socket.status === 'open') this.sendJoin();
  }

  /** Bring this device's audio in line with the room's playback state. */
  private syncPlayback(): void {
    const room = this.state.room;
    if (!room || this.state.phase !== 'joined') return;
    const { track, playback } = room;
    const ctx = audioEngine.ctx;
    if (!track || !ctx || playback.trackId !== track.id) {
      this.player.apply(playback, null, null);
      this.set({ trackLoad: track ? trackStore.get(track.id) : { status: 'idle' } });
      return;
    }
    const load = trackStore.get(track.id);
    this.set({ trackLoad: load });
    if (load.status === 'ready') {
      this.reportReady(track, load.buffer);
      // Never schedule against an unsynced clock: its offset is still 0, which
      // would put the start decades away. The clock's first update calls back here.
      if (this.conn.clock.synced) this.player.apply(playback, track, load.buffer);
      return;
    }
    // Not decoded yet: silence any previous track, fetch this one, then come back.
    this.player.apply(playback, null, null);
    if (load.status !== 'error') {
      trackStore
        .load(track, ctx)
        .then(() => this.syncPlayback())
        .catch(() => {});
    }
  }

  private reportReady(track: TrackInfo, buffer: AudioBuffer): void {
    if (this.readySent === track.id) return;
    const sent = this.conn.socket.send({
      type: 'trackReady',
      trackId: track.id,
      durationSec: buffer.duration,
    });
    if (sent) this.readySent = track.id;
  }

  retryTrack(): void {
    const id = this.state.room?.track?.id;
    if (!id) return;
    trackStore.reset(id);
    this.syncPlayback();
  }

  /** Host only: the server rejects commands from anyone else. */
  command(cmd: Command): void {
    this.set({ error: null });
    this.conn.socket.send({ type: 'command', ...cmd } as CommandMessage);
  }

  /** Host only: upload a file to this room, then load it. */
  async upload(file: File): Promise<void> {
    const body = new FormData();
    body.append('file', file, file.name);
    const res = await fetch(`/api/rooms/${this.code}/upload`, {
      method: 'POST',
      headers: { 'X-Host-Token': this.hostToken ?? '' },
      body,
    });
    if (!res.ok) {
      let message = `Upload failed (${res.status})`;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        /* non-JSON */
      }
      throw new Error(message);
    }
    const { track } = uploadResponseSchema.parse(await res.json());
    this.command({ action: 'load', trackId: track.id });
  }

  private sendJoin(): void {
    this.conn.socket.send({
      type: 'join',
      code: this.code,
      clientId: this.state.clientId,
      name: this.name,
      ...(this.hostToken && { hostToken: this.hostToken }),
    });
  }

  private reportSync(): void {
    const { clock, socket } = this.conn;
    if (!clock.synced) return;
    const s = clock.stats();
    this.set({ sync: s });
    if (this.state.phase !== 'joined') return;
    socket.send({
      type: 'syncReport',
      sync: {
        offsetMs: s.offsetMs,
        rttMs: s.rttMs,
        jitterMs: s.jitterMs,
        errorMs: s.errorMs,
        boundMs: s.boundMs,
        samples: s.samples,
      },
    });
  }

  private fail(code: NonNullable<SessionState['error']>['code'], message: string): void {
    this.set({ phase: 'error', error: { code, message } });
    this.detach();
    sessions.delete(this.code);
  }

  private detach(): void {
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.player.stopNow();
  }

  leave(): void {
    if (this.state.phase === 'joined') this.conn.socket.send({ type: 'leave' });
    this.detach();
    sessions.delete(this.code);
  }
}

const sessions = new Map<string, RoomSession>();

/** The tab's session for a room; creating one leaves any other room first. */
export function getRoomSession(code: string): RoomSession {
  let s = sessions.get(code);
  if (!s) {
    for (const other of sessions.values()) other.leave();
    s = new RoomSession(code);
    sessions.set(code, s);
  }
  return s;
}

/** The room this tab is currently in, if any (used by the Sync Lab). */
export function currentRoomSession(): RoomSession | null {
  for (const s of sessions.values()) if (s.getState().phase === 'joined') return s;
  return null;
}
