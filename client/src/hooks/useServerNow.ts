import { useEffect, useState } from 'react';
import { getConnection } from '../net/connection';

/** Server time from the synced clock, re-rendering every `intervalMs`. */
export function useServerNow(intervalMs = 100): number {
  const clock = getConnection().clock;
  const [now, setNow] = useState(() => clock.serverNow());
  useEffect(() => {
    const id = window.setInterval(() => setNow(clock.serverNow()), intervalMs);
    return () => window.clearInterval(id);
  }, [clock, intervalMs]);
  return now;
}
