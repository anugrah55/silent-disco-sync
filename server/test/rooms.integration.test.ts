import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { boot, TestClient } from './helpers';

let srv: Awaited<ReturnType<typeof boot>>;
beforeAll(async () => {
  srv = await boot();
});
afterAll(async () => {
  await srv.close();
});

async function createRoom() {
  const res = await fetch(`${srv.base}/api/rooms`, { method: 'POST' });
  expect(res.status).toBe(201);
  return (await res.json()) as { code: string; hostToken: string };
}

describe('http', () => {
  it('reports health', async () => {
    const res = await fetch(`${srv.base}/api/health`);
    const body = (await res.json()) as { ok: boolean; serverNow: number };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('number');
  });

  it('creates a room with a 4-char code and looks it up', async () => {
    const { code, hostToken } = await createRoom();
    expect(code).toMatch(/^[A-Z2-9]{4}$/);
    expect(hostToken.length).toBeGreaterThan(20);
    expect((await fetch(`${srv.base}/api/rooms/${code}`)).status).toBe(200);
    expect((await fetch(`${srv.base}/api/rooms/ZZZZ`)).status).toBe(404);
  });
});

describe('websocket', () => {
  it('rejects upgrades from a foreign origin', async () => {
    const ws = new WebSocket(srv.wsUrl, { origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) =>
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });

  it('answers ping with the echoed t0 and a server timestamp', async () => {
    const c = new TestClient(srv.wsUrl, srv.base);
    await c.opened();
    const before = performance.timeOrigin + performance.now();
    c.send({ type: 'ping', t0: 123.5 });
    const pong = await c.next('pong');
    expect(pong.t0).toBe(123.5);
    expect(pong.ts).toBeGreaterThanOrEqual(before);
    c.close();
  });

  it('joins host and guest, and broadcasts presence to both', async () => {
    const { code, hostToken } = await createRoom();
    const host = new TestClient(srv.wsUrl, srv.base);
    const guest = new TestClient(srv.wsUrl, srv.base);
    await Promise.all([host.opened(), guest.opened()]);

    host.send({ type: 'join', code, clientId: 'host-client-1', name: 'Host', hostToken });
    const hw = await host.next('welcome');
    expect(hw.isHost).toBe(true);

    guest.send({ type: 'join', code, clientId: 'guest-client-1', name: 'Guest' });
    const gw = await guest.next('welcome');
    expect(gw.isHost).toBe(false);
    expect(gw.room.members.map((m) => m.name).sort()).toEqual(['Guest', 'Host']);

    guest.send({
      type: 'syncReport',
      sync: { offsetMs: 1, rttMs: 40, jitterMs: 2, errorMs: 3, boundMs: 20, samples: 5 },
    });
    const presence = await host.next('presence');
    expect(presence.members.find((m) => m.name === 'Guest')?.sync?.rttMs).toBe(40);

    host.close();
    guest.close();
  });

  it('reports unknown rooms and invalid messages', async () => {
    const c = new TestClient(srv.wsUrl, srv.base);
    await c.opened();
    c.send({ type: 'join', code: 'ZZZZ', clientId: 'abcdefgh', name: 'X' });
    expect((await c.next('error')).code).toBe('room_not_found');
    c.ws.send('{"type":"nope"}');
    expect((await c.next('error')).code).toBe('bad_message');
    c.close();
  });
});
