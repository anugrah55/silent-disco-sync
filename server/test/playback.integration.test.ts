import { LIVE, decodeLiveChunk, encodeLiveChunk } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, TestClient } from './helpers';

let srv: Awaited<ReturnType<typeof boot>>;
beforeAll(async () => {
  srv = await boot();
});
afterAll(async () => {
  await srv.close();
});

async function roomWithHostAndGuest() {
  const res = await fetch(`${srv.base}/api/rooms`, { method: 'POST' });
  const { code, hostToken } = (await res.json()) as { code: string; hostToken: string };
  const host = new TestClient(srv.wsUrl, srv.base);
  const guest = new TestClient(srv.wsUrl, srv.base);
  await Promise.all([host.opened(), guest.opened()]);
  host.send({ type: 'join', code, clientId: 'host-aaaaaaaa', name: 'Host', hostToken });
  await host.next('welcome');
  guest.send({ type: 'join', code, clientId: 'guest-bbbbbbbb', name: 'Guest' });
  await guest.next('welcome');
  // Drain the join broadcasts so later next('roomState') sees command results.
  await host.next('roomState');
  await host.next('roomState');
  await guest.next('roomState');
  return { code, hostToken, host, guest };
}

/** Read the server clock via a ping, like a real client would. */
async function serverTime(c: TestClient): Promise<number> {
  c.send({ type: 'ping', t0: 1 });
  return (await c.next('pong')).ts;
}

describe('track library', () => {
  it('lists the click track and the bundled tracks', async () => {
    const res = await fetch(`${srv.base}/api/tracks`);
    const { tracks } = (await res.json()) as {
      tracks: Array<{ id: string; available: boolean; loop: boolean }>;
    };
    expect(tracks[0]).toMatchObject({ id: 'click', available: true, loop: true });
    expect(tracks.map((t) => t.id)).toEqual(
      expect.arrayContaining(['neon-pulse', 'night-drive', 'afterglow']),
    );
  });

  it('streams a track with Range support and cache headers', async () => {
    const res = await fetch(`${srv.base}/api/tracks/neon-pulse`, {
      headers: { Range: 'bytes=0-11' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-11\/\d+$/);
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect(res.headers.get('content-type')).toContain('audio/wav');
    const head = Buffer.from(await res.arrayBuffer());
    expect(head.toString('ascii', 0, 4)).toBe('RIFF');
    expect((await fetch(`${srv.base}/api/tracks/nope`)).status).toBe(404);
  });
});

describe('uploads', () => {
  function wavBytes(): Uint8Array {
    const b = Buffer.alloc(44 + 3200);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + 3200, 4);
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(3200, 40);
    return new Uint8Array(b);
  }
  const form = (bytes: Uint8Array, name: string, type: string) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type }), name);
    return f;
  };

  it('accepts a host upload, rejects guests and fakes, and broadcasts it', async () => {
    const { code, hostToken, host, guest } = await roomWithHostAndGuest();
    const url = `${srv.base}/api/rooms/${code}/upload`;

    const asGuest = await fetch(url, {
      method: 'POST',
      body: form(wavBytes(), 'a.wav', 'audio/wav'),
    });
    expect(asGuest.status).toBe(403);

    const fake = await fetch(url, {
      method: 'POST',
      headers: { 'X-Host-Token': hostToken },
      body: form(new TextEncoder().encode('definitely not audio'), 'evil.mp3', 'audio/mpeg'),
    });
    expect(fake.status).toBe(415);

    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'X-Host-Token': hostToken },
      body: form(wavBytes(), 'My_Song.wav', 'audio/wav'),
    });
    expect(ok.status).toBe(201);
    const { track } = (await ok.json()) as { track: { id: string; title: string } };
    expect(track.title).toBe('My Song');
    const state = await guest.next('roomState');
    expect(state.room.uploads.map((u) => u.id)).toContain(track.id);
    expect((await fetch(`${srv.base}/api/tracks/${track.id}`)).status).toBe(200);

    host.close();
    guest.close();
  });
});

describe('scheduled playback', () => {
  it('only the host may send commands', async () => {
    const { host, guest } = await roomWithHostAndGuest();
    guest.send({ type: 'command', action: 'load', trackId: 'click' });
    expect((await guest.next('error')).code).toBe('not_host');
    host.close();
    guest.close();
  });

  it('waits for everyone to be ready unless forced', async () => {
    const { host, guest } = await roomWithHostAndGuest();
    host.send({ type: 'command', action: 'load', trackId: 'click' });
    await host.next('roomState');
    host.send({ type: 'command', action: 'play' });
    const err = await host.next('error');
    expect(err.code).toBe('not_ready');
    expect(err.message).toMatch(/Host|Guest/);

    host.send({ type: 'command', action: 'play', force: true });
    expect((await host.next('roomState')).room.playback.status).toBe('playing');
    host.close();
    guest.close();
  });

  it('broadcasts play to every client with effective time = server now + lead time', async () => {
    const { host, guest } = await roomWithHostAndGuest();
    host.send({ type: 'command', action: 'load', trackId: 'neon-pulse' });
    const loaded = await guest.next('roomState');
    expect(loaded.room.track?.id).toBe('neon-pulse');
    expect(loaded.room.playback).toMatchObject({
      trackId: 'neon-pulse',
      status: 'paused',
      positionAtStartSec: 0,
    });
    await host.next('roomState');

    host.send({ type: 'trackReady', trackId: 'neon-pulse' });
    guest.send({ type: 'trackReady', trackId: 'neon-pulse' });
    await host.next('presence');

    const before = await serverTime(host);
    host.send({ type: 'command', action: 'play' });
    const [h, g] = await Promise.all([host.next('roomState'), guest.next('roomState')]);
    const after = await serverTime(host);

    expect(g.room.playback).toEqual(h.room.playback);
    const { playback, leadMs } = g.room;
    expect(playback.status).toBe('playing');
    expect(playback.positionAtStartSec).toBe(0);
    expect(leadMs).toBeGreaterThanOrEqual(1500);
    // The stamp is taken between our two clock reads, then pushed lead time ahead.
    expect(playback.startServerMs).toBeGreaterThanOrEqual(before + leadMs);
    expect(playback.startServerMs).toBeLessThanOrEqual(after + leadMs);

    // Pause and seek are scheduled the same way.
    const t = await serverTime(host);
    host.send({ type: 'command', action: 'pause' });
    const paused = (await guest.next('roomState')).room.playback;
    expect(paused.status).toBe('paused');
    expect(paused.startServerMs).toBeGreaterThanOrEqual(t + leadMs);
    expect(paused.seq).toBe(playback.seq + 1);

    host.close();
    guest.close();
  });

  it('lead time follows the worst client RTT', async () => {
    const { host, guest } = await roomWithHostAndGuest();
    guest.send({
      type: 'syncReport',
      sync: { offsetMs: 0, rttMs: 600, jitterMs: 1, errorMs: 2, boundMs: 300, samples: 20 },
    });
    host.send({ type: 'command', action: 'load', trackId: 'click' });
    const s = await host.next('roomState');
    expect(s.room.leadMs).toBe(4 * 600 + 500);
    host.close();
    guest.close();
  });
});

describe('live share relay', () => {
  it('relays host audio chunks to everyone, and ignores guests and stale streams', async () => {
    const { host, guest } = await roomWithHostAndGuest();
    const now = await serverTime(host);
    host.send({
      type: 'command',
      action: 'liveStart',
      startServerMs: now,
      sampleRate: LIVE.sampleRate,
      chunkSamples: LIVE.chunkSamples,
      label: 'YouTube tab',
    });
    const { room } = await guest.next('roomState');
    expect(room.live).toMatchObject({ streamId: 1, sampleRate: 24000, label: 'YouTube tab' });
    expect(room.live!.delayMs).toBeGreaterThanOrEqual(LIVE.minDelayMs);

    const chunk = encodeLiveChunk(
      room.live!.streamId,
      0,
      new Float32Array(LIVE.chunkSamples).fill(0.25),
    );
    host.ws.send(Buffer.from(chunk));
    guest.ws.send(Buffer.from(encodeLiveChunk(room.live!.streamId, 1, new Float32Array(10)))); // not host
    host.ws.send(Buffer.from(encodeLiveChunk(99, 2, new Float32Array(10)))); // wrong stream

    await new Promise((r) => setTimeout(r, 300));
    expect(guest.binary).toHaveLength(1);
    expect(host.binary).toHaveLength(1); // the host plays the relayed stream too
    const got = decodeLiveChunk(new Uint8Array(guest.binary[0]!))!;
    expect(got).toMatchObject({ streamId: 1, index: 0 });
    expect(got.samples[100]).toBeCloseTo(0.25, 3);

    host.send({ type: 'command', action: 'liveStop' });
    expect((await guest.next('roomState')).room.live).toBeNull();
    host.close();
    guest.close();
  });

  it('ends the live share when the host disconnects', async () => {
    const { host, guest } = await roomWithHostAndGuest();
    host.send({
      type: 'command',
      action: 'liveStart',
      startServerMs: await serverTime(host),
      sampleRate: LIVE.sampleRate,
      chunkSamples: LIVE.chunkSamples,
      label: 'tab',
    });
    await guest.next('roomState');
    host.close();
    expect((await guest.next('roomState')).room.live).toBeNull();
    guest.close();
  });
});
