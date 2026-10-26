import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CreateRoomResponse } from '@sds/shared';
import { ROOM_CODE_RE } from '@sds/shared';
import { serverNow } from './clock';
import type { Config } from './config';
import type { RoomManager } from './rooms';

/** Where the built client lives (served in production, absent in dev). */
export function clientDistDir(config: Config): string {
  return config.clientDist ?? path.resolve(import.meta.dirname, '../../client/dist');
}

/** The client build id written by the Vite build, or null when there is no build. */
export function readBuildId(config: Config): string | null {
  try {
    return readFileSync(path.join(clientDistDir(config), 'build-id.txt'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function createApp(config: Config, rooms: RoomManager): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          // 'self' covers same-origin ws/wss in current browsers; listed for older Safari.
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'media-src': ["'self'", 'blob:'],
          'worker-src': ["'self'"],
          'manifest-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          // Would break plain-http LAN testing of a production build; Render is https anyway.
          'upgrade-insecure-requests': null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '4kb' }));

  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      serverNow: serverNow(),
      ...rooms.stats(),
    });
  });

  const createLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many rooms created from this network. Try again in a few minutes.' },
  });

  app.post('/api/rooms', createLimiter, (_req, res) => {
    const room = rooms.create();
    if (!room) {
      res.status(503).json({ error: 'The server is at its room limit. Try again later.' });
      return;
    }
    const body: CreateRoomResponse = { code: room.code, hostToken: room.hostToken };
    res.status(201).json(body);
  });

  app.get('/api/rooms/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    const room = ROOM_CODE_RE.test(code) ? rooms.get(code) : undefined;
    res.set('Cache-Control', 'no-store');
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    const listeners = [...room.clients.values()].filter((c) => c.ws !== null).length;
    res.json({ code: room.code, listeners });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Built client (production). In dev, Vite serves the client and proxies /api and /ws here.
  const clientDist = clientDistDir(config);
  if (existsSync(path.join(clientDist, 'index.html'))) {
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    // SPA fallback: deep links like /r/ABCD and /lab load index.html.
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : String(err.message) });
  };
  app.use(onError);

  return app;
}
