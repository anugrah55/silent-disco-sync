import type { ErrorCode, RoomSnapshot } from '@sds/shared';
import { wsUrl } from '../lib/api';
import { getClientId } from '../lib/ids';
import { SyncSocket, type SocketStatus } from '../net/socket';

export interface SessionState {
  phase: 'idle' | 'connecting' | 'joined' | 'error';
  socket: SocketStatus;
  error: { code: ErrorCode | 'replaced' | 'expired'; message: string } | null;
  room: RoomSnapshot | null;
  clientId: string;
  isHost: boolean;
  /** Phase 1 placeholder: latest single-ping RTT. Replaced by clockSync in Phase 2. */
  rttMs: number | null;
}

/**
 * Framework-free room connection: owns the socket, (re)joins on every open,
 * and exposes an immutable state snapshot for React's useSyncExternalStore.
 */
export class RoomSession {
  private socket: SyncSocket | null = null;
  private listeners = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private name = '';
  private hostToken: string | undefined;
  private state: SessionState;

  constructor(readonly code: string) {
    this.state = {
      phase: 'idle',
      socket: 'closed',
      error: null,
      room: null,
      clientId: getClientId(),
      isHost: false,
      rttMs: null,
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
    if (this.socket) return;
    const socket = new SyncSocket(wsUrl());
    this.socket = socket;
    this.set({ phase: 'connecting', socket: 'connecting', error: null });

    socket.onStatus((status, info) => {
      this.set({ socket: status });
      if (status === 'open') this.sendJoin();
      if (status === 'closed' && info?.code === 4001) {
        this.set({
          phase: 'error',
          error: { code: 'replaced', message: 'This room was opened in another tab.' },
        });
      }
      if (status === 'closed' && info?.code === 4004) {
        this.set({ phase: 'error', error: { code: 'expired', message: 'This room has expired.' } });
      }
    });
    socket.on('welcome', (msg) => {
      this.set({ phase: 'joined', isHost: msg.isHost, room: msg.room, error: null });
    });
    socket.on('roomState', (msg) => this.set({ room: msg.room }));
    socket.on('presence', (msg) => {
      if (this.state.room) this.set({ room: { ...this.state.room, members: msg.members } });
    });
    socket.on('error', (msg) => {
      const fatal = msg.code === 'room_not_found' || msg.code === 'room_full';
      this.set({
        error: { code: msg.code, message: msg.message },
        ...(fatal && { phase: 'error' }),
      });
      if (fatal) this.stop();
    });
    socket.on('pong', (msg, recvAt) => {
      const rtt = recvAt - msg.t0;
      const offset = msg.ts - (msg.t0 + rtt / 2);
      this.set({ rttMs: rtt });
      socket.send({
        type: 'syncReport',
        sync: { offsetMs: offset, rttMs: rtt, jitterMs: 0, errorMs: rtt / 2, samples: 1 },
      });
    });

    this.pingTimer = setInterval(() => socket.send({ type: 'ping', t0: performance.now() }), 2000);
    document.addEventListener('visibilitychange', this.onVisibility);
    socket.connect();
  }

  private sendJoin(): void {
    this.socket?.send({
      type: 'join',
      code: this.code,
      clientId: this.state.clientId,
      name: this.name,
      ...(this.hostToken && { hostToken: this.hostToken }),
    });
    this.socket?.send({ type: 'ping', t0: performance.now() });
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.socket?.kick();
  };

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.socket?.close();
    this.socket = null;
  }

  leave(): void {
    this.socket?.send({ type: 'leave' });
    this.stop();
  }
}
