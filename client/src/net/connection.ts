import { ClockSync, type Scheduler } from '../sync/clockSync';
import { wsUrl } from '../lib/api';
import { SyncSocket } from './socket';

const browserScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
};

/**
 * One WebSocket and one clock per tab, shared by the room screen and the Sync
 * Lab. Every (re)connect re-runs the full sync burst, because a new connection
 * can take a different network path.
 */
export class Connection {
  readonly socket = new SyncSocket(wsUrl());
  readonly clock: ClockSync;
  /** Set by playback: while true the clock slews instead of stepping. */
  playing = false;
  private opened = false;

  constructor() {
    this.clock = new ClockSync(
      (t0) => this.socket.send({ type: 'ping', t0 }),
      browserScheduler,
      {},
      () => !this.playing,
    );
    this.socket.on('pong', (msg, recvAt) => this.clock.handlePong(msg.t0, msg.ts, recvAt));
    this.socket.onStatus((status) => {
      if (status === 'open') {
        if (this.opened) this.clock.restart();
        else this.clock.start();
        this.opened = true;
      } else if (status === 'closed') {
        this.clock.stop();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Background tabs throttle timers and may have missed re-syncs.
      this.socket.kick();
      this.clock.resyncNow();
    });
  }

  /** Connect if not connected yet, or again after a terminal close. */
  ensure(): void {
    if (this.socket.status === 'closed') this.socket.connect();
  }
}

let instance: Connection | null = null;

export function getConnection(): Connection {
  instance ??= new Connection();
  instance.ensure();
  return instance;
}
