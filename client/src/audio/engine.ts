type Listener = (state: AudioContextState) => void;

interface AudioSessionNavigator {
  audioSession?: { type: string };
}

/**
 * Owns the single AudioContext. Browsers (iOS Safari especially) only allow
 * audio to start from inside a user gesture, so unlock() must be called
 * synchronously from a click/tap handler — before any await.
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  private listeners = new Set<Listener>();

  get state(): AudioContextState | 'uninitialized' {
    return this.ctx?.state ?? 'uninitialized';
  }

  unlock(): AudioContext {
    // iOS 16.4+: 'playback' makes Web Audio ignore the ring/silent switch.
    const nav = navigator as Navigator & AudioSessionNavigator;
    if (nav.audioSession) {
      try {
        nav.audioSession.type = 'playback';
      } catch {
        /* unsupported value */
      }
    }

    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx.onstatechange = () => {
        const s = this.ctx?.state;
        if (s) this.listeners.forEach((l) => l(s));
      };
    }
    const ctx = this.ctx;
    void ctx.resume();
    // Playing a one-sample silent buffer inside the gesture is what actually
    // unlocks output on older iOS versions.
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    return ctx;
  }

  onStateChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const audioEngine = new AudioEngine();
