import { LIVE, encodeLiveChunk, type LiveState } from '@sds/shared';
import type { ClockSync } from '../sync/clockSync';

export type CaptureStatus =
  | { state: 'idle' }
  | { state: 'picking' }
  | { state: 'live'; label: string }
  | { state: 'error'; message: string };

/** Re-anchor when chunk arrival drifts this far from the sample-count timeline. */
const MAX_TIMELINE_DRIFT_MS = 400;
/** Chunks held while waiting for the server to confirm a new stream (~2 s). */
const MAX_PENDING = 20;
const CHUNK_MS = (LIVE.chunkSamples / LIVE.sampleRate) * 1000;

interface Hooks {
  clock: ClockSync;
  /** Send liveStart / liveStop to the server. */
  start: (p: {
    startServerMs: number;
    sampleRate: number;
    chunkSamples: number;
    label: string;
  }) => void;
  stop: () => void;
  sendBinary: (data: ArrayBuffer) => boolean;
  onStatus: (s: CaptureStatus) => void;
}

/** Whether this browser can capture another tab's audio (desktop Chromium). */
export function canShareTabAudio(): boolean {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return (
    !mobile &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    'AudioWorkletNode' in window
  );
}

/**
 * Host side of live share: capture a browser tab's audio with getDisplayMedia,
 * cut it into 100 ms mono chunks in an AudioWorklet, and send each chunk with
 * its index. Chunk n belongs at server time startServerMs + n * 100 ms. The
 * index is a sample count, so delivery jitter never moves the timeline; only a
 * real drift between the capture clock and the shared clock triggers a re-anchor.
 */
export class LiveCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private label = 'Shared tab';
  /** Index the next captured chunk gets on the current timeline. */
  private index = 0;
  private anchorServerMs = 0;
  /** Stream id the server assigned to the current anchor; null until confirmed. */
  private streamId: number | null = null;
  private pending: Array<{ index: number; samples: Float32Array }> = [];

  constructor(private readonly hooks: Hooks) {}

  get active(): boolean {
    return this.stream !== null;
  }

  /** The server has confirmed the current stream (so a null live state means it ended). */
  get confirmed(): boolean {
    return this.streamId !== null;
  }

  /**
   * Call from a click: the capture AudioContext is created inside the gesture,
   * because the tab picker can outlast the browser's activation window.
   */
  async start(): Promise<void> {
    if (this.stream) return;
    const ctx = new AudioContext({ sampleRate: LIVE.sampleRate });
    void ctx.resume();
    this.ctx = ctx;
    this.hooks.onStatus({ state: 'picking' });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // Chrome only offers tab audio alongside video; we drop the video.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Mute the tab on the host so the laptop only plays the synced copy.
          suppressLocalAudioPlayback: true,
        } as MediaTrackConstraints,
        // Chromium hints: offer tabs first and hide this app's own tab.
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
      const audio = stream.getAudioTracks()[0];
      if (!audio) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('No audio was shared. Pick a tab and turn on "Also share tab audio".');
      }
      this.label = labelFrom(stream.getVideoTracks()[0]?.label) ?? 'Shared tab';
      stream.getVideoTracks().forEach((t) => t.stop());
      // The browser's own "Stop sharing" button ends the audio track.
      audio.onended = () => this.stop();
      this.stream = stream;

      await ctx.audioWorklet.addModule('/worklets/live-capture.js');
      const source = ctx.createMediaStreamSource(new MediaStream([audio]));
      const node = new AudioWorkletNode(ctx, 'live-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { chunkSamples: LIVE.chunkSamples },
      });
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onChunk(ev.data);
      // A worklet only runs while connected to the graph: route it into a muted sink.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(ctx.destination);
      this.node = node;
      this.reanchor();
      this.hooks.onStatus({ state: 'live', label: this.label });
    } catch (err) {
      this.teardown();
      const cancelled = err instanceof DOMException && err.name === 'NotAllowedError';
      this.hooks.onStatus(
        cancelled
          ? { state: 'idle' }
          : {
              state: 'error',
              message: err instanceof Error ? err.message : 'Could not share audio.',
            },
      );
    }
  }

  /** Stop capturing; tell the server unless it already ended the share. */
  stop(notifyServer = true): void {
    if (!this.stream) return;
    this.teardown();
    if (notifyServer) this.hooks.stop();
    this.hooks.onStatus({ state: 'idle' });
  }

  /**
   * Start a fresh timeline: on start, after a reconnect, or when drift builds
   * up. Every device anchors on the same startServerMs, so a constant capture
   * latency shifts everyone equally and never hurts device-to-device sync.
   */
  reanchor(): void {
    if (!this.stream) return;
    this.index = 0;
    this.streamId = null;
    this.pending = [];
    this.anchorServerMs = this.hooks.clock.serverNow();
    this.hooks.start({
      startServerMs: this.anchorServerMs,
      sampleRate: LIVE.sampleRate,
      chunkSamples: LIVE.chunkSamples,
      label: this.label,
    });
  }

  /** The room's live state changed: adopt the stream id that matches our anchor. */
  onLiveState(live: LiveState | null): void {
    if (!this.stream || !live || this.streamId === live.streamId) return;
    if (Math.abs(live.startServerMs - this.anchorServerMs) > 0.5) return; // an older anchor
    this.streamId = live.streamId;
    for (const p of this.pending) this.send(p.index, p.samples);
    this.pending = [];
  }

  private onChunk(samples: Float32Array): void {
    if (!this.stream) return;
    // Chunk `index` ends at anchor + (index + 1) * 100 ms on the sample timeline.
    const drift =
      this.hooks.clock.serverNow() - (this.anchorServerMs + (this.index + 1) * CHUNK_MS);
    if (Math.abs(drift) > MAX_TIMELINE_DRIFT_MS) this.reanchor();

    const index = this.index++;
    if (this.streamId === null) {
      if (this.pending.length < MAX_PENDING) this.pending.push({ index, samples });
      return;
    }
    this.send(index, samples);
  }

  private send(index: number, samples: Float32Array): void {
    this.hooks.sendBinary(encodeLiveChunk(this.streamId!, index, samples));
  }

  private teardown(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.port.close();
    this.node = null;
    void this.ctx?.close();
    this.ctx = null;
    this.streamId = null;
    this.pending = [];
  }
}

function labelFrom(trackLabel: string | undefined): string | null {
  // Chromium sometimes exposes the tab title; internal ids aren't worth showing.
  if (!trackLabel || /^(web-contents-media-stream|screen|window):/i.test(trackLabel)) return null;
  return trackLabel.slice(0, 80);
}
