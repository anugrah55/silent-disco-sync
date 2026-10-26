import { performance } from 'node:perf_hooks';

/**
 * Server clock, epoch milliseconds with sub-ms resolution.
 *
 * We use performance.timeOrigin + performance.now() rather than Date.now():
 * it is monotonic (never jumps when NTP steps the OS clock mid-party) and has
 * microsecond precision, while still reading as a normal epoch timestamp.
 * Clients never need it to match real UTC — only to be one consistent clock.
 */
export function serverNow(): number {
  return performance.timeOrigin + performance.now();
}
