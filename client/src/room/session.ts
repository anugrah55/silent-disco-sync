import type { ErrorCode, RoomSnapshot } from '@sds/shared';
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
}

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
    };
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
        this.set({ phase: 'joined', isHost: msg.isHost, room: msg.room, error: null });
        this.reportSync();
        socket.send({ type: 'nudgeReport', nudgeMs: nudge.get() });
      }),
      socket.on('roomState', (msg) => {
        if (msg.room.code === this.code) this.set({ room: msg.room });
      }),
      socket.on('presence', (msg) => {
        if (this.state.room) this.set({ room: { ...this.state.room, members: msg.members } });
      }),
      socket.on('error', (msg) => {
        if (msg.code === 'room_not_found' || msg.code === 'room_full') {
          this.fail(msg.code, msg.message);
        } else if (msg.code !== 'not_joined') {
          this.set({ error: { code: msg.code, message: msg.message } });
        }
      }),
      clock.onUpdate(() => this.reportSync()),
      nudge.subscribe(() => {
        if (this.state.phase === 'joined')
          socket.send({ type: 'nudgeReport', nudgeMs: nudge.get() });
      }),
    );

    this.set({ socket: socket.status });
    if (socket.status === 'open') this.sendJoin();
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
