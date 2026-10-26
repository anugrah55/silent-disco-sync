/**
 * Keeps the screen on while audio plays: phones that sleep mid-song suspend
 * the AudioContext. Wake locks are dropped whenever the page is hidden, so we
 * re-request on return. Needs a secure context (https or localhost).
 */
let wanted = false;
let sentinel: WakeLockSentinel | null = null;

async function acquire(): Promise<void> {
  if (!wanted || sentinel || document.visibilityState !== 'visible' || !('wakeLock' in navigator))
    return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    /* denied (low battery, insecure context): playback still works */
  }
}

document.addEventListener('visibilitychange', () => void acquire());

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else {
    void sentinel?.release();
    sentinel = null;
  }
}
