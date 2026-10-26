import { randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { LIMITS, ROOM_CODE_RE, type TrackInfo } from '@sds/shared';
import { tokenEquals, type RoomManager } from './rooms';
import { MIME_BY_EXT, sniffAudio, type TrackLibrary } from './tracks';

const ALLOWED_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
]);

export function trackRouter(
  rooms: RoomManager,
  library: TrackLibrary,
  uploadDir: string,
): express.Router {
  const router = express.Router();

  router.get('/tracks', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json({ tracks: library.list() });
  });

  // Streams a library or uploaded track. sendFile handles Range requests
  // (206 partial content), ETag and Last-Modified for us.
  router.get('/tracks/:id', (req, res, next) => {
    const id = req.params.id;
    const lib = library.tracks.get(id);
    const file = lib?.info.available ? lib : rooms.findUpload(id);
    if (!file) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    res.type(file.mime);
    res.set('Cache-Control', lib ? 'public, max-age=86400' : 'private, max-age=3600');
    res.sendFile(file.path, { cacheControl: false, dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many uploads. Try again in a few minutes.' },
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, randomBytes(12).toString('hex')),
    }),
    limits: { fileSize: LIMITS.maxUploadBytes, files: 1, fields: 0, parts: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, ext in MIME_BY_EXT && ALLOWED_MIME.has(file.mimetype));
    },
  });

  /** Only the room's host may upload; checked before any bytes hit the disk. */
  function requireHost(req: Request, res: Response, next: NextFunction) {
    const code = String(req.params.code ?? '').toUpperCase();
    const room = ROOM_CODE_RE.test(code) ? rooms.get(code) : undefined;
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    const token = req.get('x-host-token') ?? '';
    if (!tokenEquals(token, room.hostToken)) {
      res.status(403).json({ error: 'Only the host can upload tracks.' });
      return;
    }
    res.locals.room = room;
    next();
  }

  router.post('/rooms/:code/upload', uploadLimiter, requireHost, (req, res, next) => {
    upload.single('file')(req, res, async (err: unknown) => {
      try {
        if (err instanceof multer.MulterError) {
          const tooBig = err.code === 'LIMIT_FILE_SIZE';
          res.status(tooBig ? 413 : 400).json({
            error: tooBig ? 'That file is over the 12 MB limit.' : 'Upload one audio file.',
          });
          return;
        }
        if (err) return next(err);
        const file = req.file;
        if (!file) {
          res.status(415).json({ error: 'Choose an mp3, m4a or wav file.' });
          return;
        }

        // Trust the bytes, not the name or browser-reported type.
        const ext = path.extname(file.originalname).toLowerCase();
        const fh = await open(file.path, 'r');
        const head = Buffer.alloc(16);
        await fh.read(head, 0, 16, 0);
        await fh.close();
        const kind = sniffAudio(head);
        if (!kind || `.${kind}` !== ext) {
          await rm(file.path, { force: true });
          res
            .status(415)
            .json({ error: "That file doesn't look like the audio type its name says." });
          return;
        }

        const room = res.locals.room;
        if (rooms.get(room.code) !== room) {
          // The room expired while the file was uploading.
          await rm(file.path, { force: true });
          res.status(404).json({ error: 'Room not found' });
          return;
        }
        const id = `up-${randomBytes(5).toString('hex')}`;
        const info: TrackInfo = {
          id,
          title: cleanTitle(file.originalname),
          artist: 'Uploaded by the host',
          durationSec: null,
          bpm: null,
          source: 'upload',
          url: `/api/tracks/${id}`,
          available: true,
          loop: false,
        };
        rooms.addUpload(room, { info, path: file.path, mime: MIME_BY_EXT[ext]! });
        rooms.changed(room);
        res.status(201).json({ track: info });
      } catch (e) {
        if (req.file) await rm(req.file.path, { force: true }).catch(() => {});
        next(e);
      }
    });
  });

  return router;
}

function cleanTitle(name: string): string {
  const base = path
    .basename(name, path.extname(name))
    .replace(/[_\s]+/g, ' ')
    .trim();
  return (base || 'Uploaded track').slice(0, 60);
}
