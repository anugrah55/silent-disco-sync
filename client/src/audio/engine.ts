import { keys, local } from '../lib/storage';

type Listener = (state: AudioContextState) => void;

interface AudioSessionNavigator {
  audioSession?: { type: string };
}

/**
 * Owns the single AudioContext and the output chain:
 *   sources -> master gain (volume) -> analyser (visualizer) -> speakers
 * Browsers (iOS Safari especially) only allow audio to start from inside a
 * user gesture, so unlock() must be called synchronously from a click/tap
 * handler — before any await.
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  private listeners = new Set<Listener>();
  private volume = clampVolume(Number(local.get(keys.volume) ?? '0.9'));

  get state(): AudioContextState | 'uninitialized' {
    return this.ctx?.state ?? 'uninitialized';
  }

  /** Where playback sources connect. */
  get output(): AudioNode {
    if (!this.master) throw new Error('audio not unlocked');
    return this.master;
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
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.master.connect(this.analyser).connect(ctx.destination);
      ctx.onstatechange = () => this.listeners.forEach((l) => l(ctx.state));
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

  getVolume(): number {
    return this.volume;
  }

  setVolume(v: number): void {
    this.volume = clampVolume(v);
    local.set(keys.volume, String(this.volume));
    if (this.master && this.ctx) {
      // Short ramp: no zipper noise while dragging the slider.
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  onStateChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.9;
}

export const audioEngine = new AudioEngine();
