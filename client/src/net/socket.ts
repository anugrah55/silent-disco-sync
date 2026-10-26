import { serverMessageSchema, type ClientMessage, type ServerMessage } from '@sds/shared';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
/** recvAt is performance.now() taken before parsing, so clock sync gets the tightest t1. */
type Handler<T extends ServerMessage['type']> = (msg: MessageOf<T>, recvAt: number) => void;

/** Close codes after which reconnecting would be pointless. */
const TERMINAL_CODES = new Set([4001, 4004]);

/**
 * Thin typed wrapper over a browser WebSocket with exponential-backoff
 * reconnects. Callers re-join and re-sync from the 'open' status event.
 */
export class SyncSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(msg: ServerMessage, recvAt: number) => void>>();
  private statusHandlers = new Set<(s: SocketStatus, info?: { code: number }) => void>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  status: SocketStatus = 'closed';

  constructor(private readonly url: string) {}

  connect(): void {
    if (this.ws) return;
    this.stopped = false;
    this.setStatus('connecting');
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      const recvAt = performance.now();
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const parsed = serverMessageSchema.safeParse(data);
      if (!parsed.success) {
        console.warn('[sds] dropped invalid server message', parsed.error.issues);
        return;
      }
      this.handlers.get(parsed.data.type)?.forEach((h) => h(parsed.data, recvAt));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped || TERMINAL_CODES.has(ev.code)) {
        // Stay down: kick() must not revive a socket another tab replaced.
        this.stopped = true;
        this.setStatus('closed', { code: ev.code });
        return;
      }
      this.setStatus('reconnecting', { code: ev.code });
      const delay = Math.min(8000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  /** Reconnect immediately, e.g. when the tab becomes visible again. */
  kick(): void {
    if (this.stopped || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setStatus('closed');
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on<T extends ServerMessage['type']>(type: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    const h = handler as (msg: ServerMessage, recvAt: number) => void;
    set.add(h);
    this.handlers.set(type, set);
    return () => set.delete(h);
  }

  onStatus(handler: (s: SocketStatus, info?: { code: number }) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(s: SocketStatus, info?: { code: number }): void {
    this.status = s;
    this.statusHandlers.forEach((h) => h(s, info));
  }
}
