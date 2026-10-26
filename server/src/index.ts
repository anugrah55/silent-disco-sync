import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createApp, readBuildId } from './app';
import { loadConfig, type Config } from './config';
import { RoomManager } from './rooms';
import { TrackLibrary } from './tracks';
import { mkdirSync, rmSync } from 'node:fs';
import { attachWebSocket } from './ws';

export interface Running {
  server: Server;
  rooms: RoomManager;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<Running> {
  const config = { ...loadConfig(), ...overrides };
  // Uploads never outlive the process: start from an empty temp folder.
  rmSync(config.uploadDir, { recursive: true, force: true });
  mkdirSync(config.uploadDir, { recursive: true });
  const library = new TrackLibrary(config.assetsDir);
  const rooms = new RoomManager({ leadMsDefault: config.leadMsDefault, library });
  const app = createApp(config, rooms, library);
  const server = createServer(app);
  const wss = attachWebSocket(server, rooms, {
    allowedOrigins: config.allowedOrigins,
    buildId: readBuildId(config),
  });
  rooms.startSweeper();

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    rooms,
    port,
    close: async () => {
      rooms.stop();
      for (const room of [...rooms.rooms.values()]) rooms.destroy(room);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const running = await startServer();
  console.log(`Silent Disco Sync listening on http://localhost:${running.port}`);
  const shutdown = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
