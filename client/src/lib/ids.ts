import { keys, session } from './storage';

// crypto.randomUUID needs a secure context, which plain-http LAN testing isn't.
// getRandomValues works everywhere.
export function randomId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, bytes * 2);
}

/** Per-tab identity, so a reload or reconnect reclaims the same seat in the room. */
export function getClientId(): string {
  let id = session.get(keys.clientId);
  if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
    id = randomId();
    session.set(keys.clientId, id);
  }
  return id;
}
