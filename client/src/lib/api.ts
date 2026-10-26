import { createRoomResponseSchema, type CreateRoomResponse } from '@sds/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* non-JSON body */
  }
  return new ApiError(message, res.status);
}

export async function createRoom(): Promise<CreateRoomResponse> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw await errorFrom(res);
  return createRoomResponseSchema.parse(await res.json());
}

export async function roomExists(code: string): Promise<boolean> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (res.status === 404) return false;
  if (!res.ok) throw await errorFrom(res);
  return true;
}

export function joinUrl(code: string): string {
  const origin = (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) || location.origin;
  return `${origin.replace(/\/$/, '')}/r/${code}`;
}

export function wsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
