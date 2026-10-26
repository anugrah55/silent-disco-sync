import { CLICK_TRACK } from '@sds/shared';

/**
 * The sync test signal: 4 bars at 120 BPM of short sine clicks, accented on
 * beat 1, synthesized on the device so there is nothing to download. The
 * buffer loops, so it can play for as long as the host likes.
 *
 * A click has an instant attack, which makes any offset between phones
 * audible as a flam or echo — exactly what you want from a test signal.
 */
export function createClickBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const beats = CLICK_TRACK.bars * 4;
  const beatSec = 60 / CLICK_TRACK.bpm;
  const buffer = ctx.createBuffer(1, Math.round(beats * beatSec * sr), sr);
  const data = buffer.getChannelData(0);
  const clickLen = Math.round(0.03 * sr);
  for (let b = 0; b < beats; b++) {
    const start = Math.round(b * beatSec * sr);
    const accent = b % 4 === 0;
    const freq = accent ? 1760 : 1320;
    const gain = accent ? 0.9 : 0.6;
    for (let i = 0; i < clickLen && start + i < data.length; i++) {
      const t = i / sr;
      data[start + i] = gain * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 160);
    }
  }
  return buffer;
}
