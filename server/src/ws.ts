import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  LIMITS,
  WS_PATH,
  clientMessageSchema,
  LIVE,
  applyCommand,
  peekLiveHeader,
  positionAt,
  type ClientMessage,
  type CommandMessage,
  type ErrorCode,
  type ServerMessage,
} from '@sds/shared';
import { serverNow } from './clock';
import type { Client, Room, RoomManager } from './rooms';

const HEARTBEAT_MS = 20_000;
const PRESENCE_THROTTLE_MS = 500;
/** Token bucket per socket: a 20-ping sync burst is ~10 msg/s, leave headroom. */
const RATE_PER_SEC = 30;
const RATE_BURST = 60;
/** Live audio arrives at 10 chunks/s; allow catch-up bursts after a stall. */
const LIVE_RATE_PER_SEC = 25;
const LIVE_RATE_BURST = 60;
/** A listener this far behind on its socket gets chunks dropped, not queued. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface Conn {
  ws: WebSocket;
  room: Room | null;
  client: Client | null;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  liveTokens: number;
}

export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function attachWebSocket(
  server: Server,
  rooms: RoomManager,
  opts: { allowedOrigins: string[]; buildId: string | null },
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.wsMaxPayloadBytes,
    perMessageDeflate: false,
  });
  const conns = new Map<WebSocket, Conn>();
  const offChange = rooms.onChange((room) => broadcastRoomState(room));
  const presenceTimers = new Map<Room, NodeJS.Timeout>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) return reject(socket, 404, 'Not Found');
    if (!isOriginAllowed(req.headers.origin, req.headers.host, opts.allowedOrigins)) {
      return reject(socket, 403, 'Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = {
      ws,
      room: null,
      client: null,
      alive: true,
      tokens: RATE_BURST,
      lastRefill: Date.now(),
      liveTokens: LIVE_RATE_BURST,
    };
    conns.set(ws, conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('close', () => {
      conns.delete(ws);
      const { room, client } = conn;
      if (room && client && client.ws === ws) {
        rooms.disconnect(room, client);
        if (client.isHost && room.live) {
          // No host, no audio: end the live share; the host restarts it on rejoin.
          room.live = null;
          broadcastRoomState(room);
        } else {
          schedulePresence(room);
        }
      }
    });
    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => {
    clearInterval(heartbeat);
    offChange();
    for (const t of presenceTimers.values()) clearTimeout(t);
  });

  function send(ws: WebSocket | null, msg: ServerMessage): void {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(conn: Conn, code: ErrorCode, message: string): void {
    send(conn.ws, { type: 'error', code, message });
  }

  function broadcast(room: Room, msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const c of room.clients.values()) {
      if (c.ws && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }
  }

  function broadcastRoomState(room: Room): void {
    broadcast(room, { type: 'roomState', room: rooms.snapshot(room) });
  }

  /** Coalesce presence updates (sync reports arrive every few seconds per client). */
  function schedulePresence(room: Room): void {
    if (presenceTimers.has(room)) return;
    presenceTimers.set(
      room,
      setTimeout(() => {
        presenceTimers.delete(room);
        if (rooms.get(room.code) === room) {
          broadcast(room, { type: 'presence', members: rooms.members(room) });
        }
      }, PRESENCE_THROTTLE_MS),
    );
  }

  function refill(conn: Conn): void {
    const now = Date.now();
    const elapsed = (now - conn.lastRefill) / 1000;
    conn.tokens = Math.min(RATE_BURST, conn.tokens + elapsed * RATE_PER_SEC);
    conn.liveTokens = Math.min(LIVE_RATE_BURST, conn.liveTokens + elapsed * LIVE_RATE_PER_SEC);
    conn.lastRefill = now;
  }

  function takeToken(conn: Conn): boolean {
    refill(conn);
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  function onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (isBinary) return relayLive(conn, data);
    if (!takeToken(conn)) return sendError(conn, 'rate_limited', 'slow down');

    let parsed: ClientMessage;
    try {
      const result = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!result.success) return sendError(conn, 'bad_message', 'invalid message');
      parsed = result.data;
    } catch {
      return sendError(conn, 'bad_message', 'invalid JSON');
    }

    // Pong goes out first and fast: the server timestamp is taken as late as
    // possible so processing time doesn't skew the client's offset estimate.
    if (parsed.type === 'ping') {
      return send(conn.ws, { type: 'pong', t0: parsed.t0, ts: serverNow() });
    }

    if (parsed.type === 'join') return handleJoin(conn, parsed);

    const { room, client } = conn;
    if (!room || !client || client.ws !== conn.ws) {
      return sendError(conn, 'not_joined', 'join a room first');
    }

    switch (parsed.type) {
      case 'leave':
        // No host, no audio: a host leaving mid-share ends the share.
        if (client.isHost) room.live = null;
        rooms.leave(room, client);
        conn.room = null;
        conn.client = null;
        return broadcastRoomState(room);
      case 'syncReport':
        client.sync = parsed.sync;
        rooms.touch(room);
        return schedulePresence(room);
      case 'nudgeReport':
        client.nudgeMs = parsed.nudgeMs;
        return schedulePresence(room);
      case 'trackReady': {
        client.readyTrackId = parsed.trackId;
        const upload = room.uploads.get(parsed.trackId);
        // Uploads have no known length until a client decodes one.
        if (upload && upload.info.durationSec === null && parsed.durationSec) {
          upload.info = { ...upload.info, durationSec: parsed.durationSec };
          if (room.track?.id === upload.info.id) room.track = upload.info;
          return broadcastRoomState(room);
        }
        return schedulePresence(room);
      }
      case 'command':
        if (!client.isHost)
          return sendError(conn, 'not_host', 'Only the host can control playback.');
        return handleCommand(conn, room, parsed);
    }
  }

  /** Host-only binary live-audio chunk: validate the header and fan it out. */
  function relayLive(conn: Conn, data: RawData): void {
    const { room, client } = conn;
    if (!room || !client?.isHost || client.ws !== conn.ws || !room.live) return; // drop stray audio
    refill(conn);
    if (conn.liveTokens < 1) return;
    conn.liveTokens -= 1;
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    const head = peekLiveHeader(buf);
    if (!head || head.streamId !== room.live.streamId || head.samples > room.live.chunkSamples)
      return;
    for (const c of room.clients.values()) {
      const ws = c.ws;
      if (!ws || ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow listener: drop, don't queue
      ws.send(buf, { binary: true });
    }
  }

  function handleCommand(conn: Conn, room: Room, cmd: CommandMessage): void {
    rooms.touch(room);
    if (cmd.action === 'setLead') {
      room.leadOverrideMs = cmd.leadMs;
      return broadcastRoomState(room);
    }
    if (cmd.action === 'liveStart') {
      const now = serverNow();
      if (Math.abs(cmd.startServerMs - now) > 10_000) {
        return sendError(
          conn,
          'invalid_command',
          'Your clock is not synced yet. Try again in a moment.',
        );
      }
      // Stop any file playback right away: one source of sound at a time.
      if (room.playback.status === 'playing') {
        const track = room.track;
        room.playback = {
          ...room.playback,
          status: 'paused',
          startServerMs: now,
          positionAtStartSec: positionAt(
            room.playback,
            now,
            track?.durationSec ?? null,
            track?.loop ?? false,
          ),
          seq: room.playback.seq + 1,
        };
      }
      room.live = {
        streamId: ++room.liveSeq,
        startServerMs: cmd.startServerMs,
        sampleRate: cmd.sampleRate,
        chunkSamples: cmd.chunkSamples,
        // Covers capture, upload, relay and the slowest listener's download.
        delayMs: Math.min(LIVE.maxDelayMs, Math.max(LIVE.minDelayMs, rooms.leadMs(room) + 500)),
        label: cmd.label,
      };
      return broadcastRoomState(room);
    }
    if (cmd.action === 'liveStop') {
      room.live = null;
      return broadcastRoomState(room);
    }
    if (cmd.action === 'load') {
      const info = rooms.trackInfo(room, cmd.trackId);
      if (!info || !info.available) {
        return sendError(conn, 'track_not_found', 'That track is not available.');
      }
      room.track = info;
    }
    if (cmd.action === 'play' && !cmd.force && room.playback.trackId) {
      const waiting = [...room.clients.values()].filter(
        (c) => c.ws && c.readyTrackId !== room.playback.trackId,
      );
      if (waiting.length > 0) {
        const names = waiting.map((c) => c.name).join(', ');
        return sendError(conn, 'not_ready', `Still loading on ${waiting.length}: ${names}`);
      }
    }
    const result = applyCommand(room.playback, cmd, {
      nowMs: serverNow(),
      leadMs: rooms.leadMs(room),
      durationSec: room.track?.durationSec ?? null,
      loop: room.track?.loop ?? false,
    });
    if (!result.ok) {
      return sendError(
        conn,
        'invalid_command',
        result.reason === 'no_track' ? 'Pick a track first.' : 'Nothing is playing.',
      );
    }
    room.playback = result.state;
    // A successful file command takes over from a live share. (Only on success:
    // clearing it for a rejected command would silence everyone without notice.)
    room.live = null;
    broadcastRoomState(room);
  }

  function handleJoin(conn: Conn, msg: Extract<ClientMessage, { type: 'join' }>): void {
    if (conn.room && conn.client) {
      // Switching rooms on the same socket: free the old seat first.
      const old = conn.room;
      rooms.leave(old, conn.client);
      broadcastRoomState(old);
    }
    const result = rooms.join(msg.code, {
      clientId: msg.clientId,
      name: msg.name,
      hostToken: msg.hostToken,
      ws: conn.ws,
    });
    if (!result.ok) {
      return sendError(
        conn,
        result.code,
        result.code === 'room_full' ? 'This room is full.' : 'Room not found. Check the code.',
      );
    }
    const room = rooms.get(msg.code)!;
    conn.room = room;
    conn.client = result.client;
    if (result.replaced) {
      const old = conns.get(result.replaced);
      if (old) {
        old.room = null;
        old.client = null;
      }
      result.replaced.close(4001, 'replaced by a newer connection');
    }
    send(conn.ws, {
      type: 'welcome',
      clientId: result.client.id,
      isHost: result.client.isHost,
      room: rooms.snapshot(room),
      buildId: opts.buildId,
    });
    broadcastRoomState(room);
  }

  return wss;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
