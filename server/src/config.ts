import os from 'node:os';
import path from 'node:path';
import { LEAD } from '@sds/shared';

export interface Config {
  port: number;
  isProd: boolean;
  allowedOrigins: string[];
  leadMsDefault: number;
  trustProxy: number;
  clientDist: string | null;
  /** Folder with tracks.json and the bundled audio. */
  assetsDir: string;
  /** Temp folder for host uploads; wiped on boot. */
  uploadDir: string;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = env.NODE_ENV === 'production';
  return {
    port: int(env.PORT, 3000),
    isProd,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    leadMsDefault: Math.min(
      LEAD.maxMs,
      Math.max(LEAD.minMs, int(env.LEAD_MS_DEFAULT, LEAD.defaultMs)),
    ),
    trustProxy: int(env.TRUST_PROXY, isProd ? 1 : 0),
    clientDist: env.CLIENT_DIST ?? null,
    assetsDir: env.ASSETS_DIR ?? path.resolve(import.meta.dirname, '../assets'),
    uploadDir: env.UPLOAD_DIR ?? path.join(os.tmpdir(), 'sds-uploads'),
  };
}
