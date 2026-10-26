import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { serverMessageSchema, type ClientMessage, type ServerMessage } from '@sds/shared';
import { startServer, type Running } from '../src/index';

export async function boot(): Promise<Running & { base: string; wsUrl: string }> {
  const running = await startServer({
    port: 0,
    clientDist: '/nonexistent',
    uploadDir: mkdtempSync(path.join(os.tmpdir(), 'sds-test-')),
  });
  return {
    ...running,
    base: `http://127.0.0.1:${running.port}`,
    wsUrl: `ws://127.0.0.1:${running.port}/ws`,
  };
}

/** A ws test client that buffers messages so tests can await them in order. */
export class TestClient {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];

  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url, { origin });
    this.ws.on('message', (data) => {
      const msg = serverMessageSchema.parse(JSON.parse(data.toString()));
      const i = this.waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
      else this.queue.push(msg);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0)
      return Promise.resolve(this.queue.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}
