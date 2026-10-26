/**
 * Synthesizes the three bundled demo tracks as WAV files in server/assets and
 * writes server/assets/tracks.json. Deterministic (seeded noise), so re-running
 * reproduces the same files. Original material, so no licensing questions.
 *
 *   npm run tracks:generate -w server
 *
 * Why WAV: MP3/AAC encoders prepend priming samples (~25-50 ms) that browsers
 * trim inconsistently, which would desync a Chrome phone from a Safari phone
 * before any of our code runs. WAV starts on sample 0 everywhere.
 * 32 kHz mono keeps each ~90 s track around 6 MB; phone speakers are mono-ish.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SR = 32_000;
const OUT = path.resolve(import.meta.dirname, '../assets');

// ---------- small deterministic DSP toolkit ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

class Bus {
  readonly buf: Float32Array;
  constructor(readonly length: number) {
    this.buf = new Float32Array(length);
  }
  add(at: number, samples: ArrayLike<number>, gain = 1) {
    const start = Math.round(at * SR);
    for (let i = 0; i < samples.length && start + i < this.length; i++) {
      if (start + i >= 0) this.buf[start + i]! += samples[i]! * gain;
    }
  }
}

/** Biquad (RBJ cookbook) filter applied in place. */
function biquad(x: Float32Array, type: 'lp' | 'hp' | 'bp', freq: number, q = 0.707): Float32Array {
  const w = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === 'hp') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const y = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

function kick(punch = 1): Float32Array {
  const n = Math.round(0.42 * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 48 + 110 * punch * Math.exp(-t * 32);
    phase += (2 * Math.PI * f) / SR;
    const body = Math.sin(phase) * Math.exp(-t * 7.5);
    const click = i < 0.004 * SR ? (1 - i / (0.004 * SR)) * 0.6 : 0;
    out[i] = Math.tanh(1.6 * (body + click));
  }
  return out;
}

function noise(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => r());
}

function clap(seed: number): Float32Array {
  const x = biquad(noise(0.25, seed), 'bp', 1400, 1.2);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    // Three quick bursts then a tail: the classic clap shape.
    const bursts = [0, 0.011, 0.022].reduce(
      (a, d) => a + (t >= d ? Math.exp(-(t - d) * 180) : 0),
      0,
    );
    x[i]! *= 1.6 * (bursts * 0.5 + Math.exp(-t * 18));
  }
  return x;
}

function snare(seed: number): Float32Array {
  const x = biquad(noise(0.22, seed), 'hp', 1200);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] =
      x[i]! * Math.exp(-t * 22) * 0.9 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.6;
  }
  return x;
}

function hat(open: boolean, seed: number): Float32Array {
  const x = biquad(biquad(noise(open ? 0.3 : 0.06, seed), 'hp', 7000), 'hp', 7000);
  const decay = open ? 14 : 70;
  for (let i = 0; i < x.length; i++) x[i]! *= Math.exp((-i / SR) * decay) * 1.4;
  return x;
}

/** Band-limited-enough saw (polyBLEP) — keeps highs clean at 32 kHz. */
function saw(freq: number, seconds: number, phase0 = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const dt = freq / SR;
  let p = phase0 % 1;
  for (let i = 0; i < n; i++) {
    let v = 2 * p - 1;
    if (p < dt) {
      const t = p / dt;
      v -= t + t - t * t - 1;
    } else if (p > 1 - dt) {
      const t = (p - 1) / dt;
      v -= t * t + t + t + 1;
    }
    out[i] = v;
    p += dt;
    if (p >= 1) p -= 1;
  }
  return out;
}

function envelope(x: Float32Array, attack: number, release: number, sustain = 1): Float32Array {
  const a = Math.max(1, Math.round(attack * SR));
  const r = Math.max(1, Math.round(release * SR));
  for (let i = 0; i < x.length; i++) {
    let g = i < a ? i / a : sustain;
    const fromEnd = x.length - i;
    if (fromEnd < r) g *= fromEnd / r;
    x[i]! *= g;
  }
  return x;
}

function bassNote(midi: number, seconds: number, cutoff: number): Float32Array {
  const f = midiHz(midi);
  const a = saw(f, seconds);
  const b = saw(f * 1.004, seconds, 0.3);
  const sub = Float32Array.from({ length: a.length }, (_, i) =>
    Math.sin((2 * Math.PI * f * i) / (2 * SR)),
  );
  const x = Float32Array.from(a, (v, i) => 0.35 * v + 0.35 * b[i]! + 0.5 * sub[i]!);
  return envelope(biquad(x, 'lp', cutoff, 0.9), 0.004, 0.03);
}

function pluck(midi: number, seconds: number, bright: number): Float32Array {
  const f = midiHz(midi);
  const a = saw(f, seconds);
  const b = saw(f * 1.006, seconds, 0.5);
  const x = Float32Array.from(a, (v, i) => 0.5 * (v + b[i]!));
  // Filter sweep down per note gives the "pluck".
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const cutoff = 300 + bright * Math.exp(-t * 14);
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
    y += k * (x[i]! - y);
    out[i] = y * Math.exp(-t * 6);
  }
  return envelope(out, 0.002, 0.02);
}

function pad(midis: number[], seconds: number, cutoff: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (const m of midis) {
    for (const detune of [0.995, 1, 1.005]) {
      const s = saw(midiHz(m) * detune, seconds, Math.abs(detune - 1) * 37);
      for (let i = 0; i < out.length; i++) out[i]! += s[i]! / (midis.length * 3);
    }
  }
  return envelope(biquad(out, 'lp', cutoff, 0.6), seconds * 0.25, seconds * 0.25);
}

/** Simple feedback echo, applied in place. */
function echo(x: Float32Array, delaySec: number, feedback: number, mix: number): Float32Array {
  const d = Math.round(delaySec * SR);
  const line = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const delayed = i >= d ? line[i - d]! : 0;
    line[i] = x[i]! + delayed * feedback;
    x[i] = x[i]! + delayed * mix;
  }
  return x;
}

/** Duck a bus under each kick (sidechain pumping). */
function sidechain(x: Float32Array, kickTimes: number[], depth: number, releaseSec: number) {
  for (const t of kickTimes) {
    const start = Math.round(t * SR);
    const len = Math.round(releaseSec * SR);
    for (let i = 0; i < len && start + i < x.length; i++) {
      const g = 1 - depth * (1 - i / len) ** 2;
      x[start + i]! *= g;
    }
  }
}

// ---------- arrangement ----------

interface Spec {
  id: string;
  title: string;
  bpm: number;
  bars: number;
  seed: number;
  /** Chord roots per bar (MIDI), cycled. Chords are minor/major triads. */
  progression: Array<{ root: number; minor: boolean }>;
  style: 'house' | 'synthwave' | 'techno';
}

function render(spec: Spec): Float32Array {
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const length = Math.ceil((spec.bars * bar + 1.5) * SR);
  const drums = new Bus(length);
  const music = new Bus(length); // sidechained
  const lead = new Bus(length);
  const kickTimes: number[] = [];
  const k = kick(spec.style === 'techno' ? 1.2 : 1);

  // Sections: intro (drums), main, break (no kick), drop, outro (drums).
  const section = (b: number) => {
    const q = spec.bars / 8;
    if (b < q) return 'intro';
    if (b < 3.5 * q) return 'main';
    if (b < 4.5 * q) return 'break';
    if (b < 7.5 * q) return 'drop';
    return 'outro';
  };

  for (let b = 0; b < spec.bars; b++) {
    const t0 = b * bar;
    const sec = section(b);
    const chord = spec.progression[b % spec.progression.length]!;
    const third = chord.minor ? 3 : 4;
    const tones = [chord.root, chord.root + third, chord.root + 7];
    const kickOn = sec !== 'break';
    const full = sec === 'main' || sec === 'drop';

    for (let s = 0; s < 16; s++) {
      const t = t0 + (s * beat) / 4;
      const onBeat = s % 4 === 0;
      const seed = spec.seed + b * 16 + s;

      // Kick
      const kickHere =
        spec.style === 'synthwave' ? s === 0 || s === 8 || (s === 10 && b % 2 === 1) : onBeat;
      if (kickOn && kickHere) {
        drums.add(t, k, 0.95);
        kickTimes.push(t);
      }
      // Backbeat
      if ((s === 4 || s === 12) && sec !== 'intro' && kickOn) {
        drums.add(t, spec.style === 'synthwave' ? snare(seed) : clap(seed), 0.55);
      }
      // Hats
      if (spec.style === 'house' && s % 4 === 2) drums.add(t, hat(true, seed), 0.22);
      if (spec.style === 'techno' && s % 2 === 1) drums.add(t, hat(false, seed), 0.3);
      if (spec.style === 'synthwave' && s % 2 === 0 && sec !== 'intro')
        drums.add(t, hat(false, seed), 0.2);
      if (full && spec.style !== 'synthwave' && s % 4 !== 2)
        drums.add(t, hat(false, seed + 7), 0.12);

      // Bass
      if (sec !== 'intro' && sec !== 'outro') {
        const root = chord.root - 24;
        if (spec.style === 'house' && s % 4 === 2) music.add(t, bassNote(root, beat / 2, 900), 0.5);
        if (spec.style === 'synthwave' && s % 2 === 0) {
          music.add(t, bassNote(s % 8 === 6 ? root + 12 : root, beat / 2.2, 700), 0.45);
        }
        if (spec.style === 'techno' && s % 4 !== 0)
          music.add(t, bassNote(root, beat / 4.5, 500), 0.42);
      }

      // Plucked arpeggio (main, drop) and techno stabs
      if (full && spec.style !== 'techno' && s % 2 === 0) {
        const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
        const note = tones[pattern[(s / 2) % 8]!]! + (s >= 8 && sec === 'drop' ? 12 : 0);
        lead.add(t, pluck(note + 12, beat / 2, spec.style === 'house' ? 3200 : 2400), 0.18);
      }
      if (full && spec.style === 'techno' && (s === 3 || s === 10)) {
        lead.add(t, pluck(chord.root + 12, beat / 3, 1800), 0.22);
        lead.add(t, pluck(chord.root + 12 + third, beat / 3, 1800), 0.16);
      }
    }

    // Pads under break and drop
    if (sec === 'break' || sec === 'drop' || (spec.style === 'synthwave' && sec === 'main')) {
      music.add(
        t0,
        pad(
          tones.map((m) => m + 12),
          bar,
          sec === 'break' ? 1600 : 2600,
        ),
        0.32,
      );
    }
    // Riser into the drop
    if (sec === 'break' && section(b + 1) === 'drop') {
      const r = biquad(noise(bar, spec.seed + 999), 'bp', 2500, 0.8);
      for (let i = 0; i < r.length; i++) r[i]! *= (i / r.length) ** 2;
      drums.add(t0, r, 0.35);
    }
  }

  sidechain(music.buf, kickTimes, 0.7, beat * 0.45);
  echo(lead.buf, beat * 0.75, 0.35, 0.3);
  sidechain(lead.buf, kickTimes, 0.4, beat * 0.3);

  const mix = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    mix[i] = Math.tanh(1.1 * (drums.buf[i]! + music.buf[i]! + lead.buf[i]!));
  }
  // Fade the last 1.5 s and normalize to -1 dBFS.
  const fade = Math.round(1.5 * SR);
  for (let i = 0; i < fade; i++) mix[length - fade + i]! *= 1 - i / fade;
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const g = 0.89 / (peak || 1);
  for (let i = 0; i < length; i++) mix[i]! *= g;
  return mix;
}

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const A = 57,
  D = 50,
  F = 53,
  C = 48,
  G = 55,
  Bb = 46,
  Db = 49,
  Eb = 51;
const m = (root: number) => ({ root, minor: true });
const M = (root: number) => ({ root, minor: false });

const specs: Spec[] = [
  {
    id: 'neon-pulse',
    title: 'Neon Pulse',
    bpm: 124,
    bars: 48,
    seed: 11,
    style: 'house',
    progression: [m(A), M(F), M(C), M(G)],
  },
  {
    id: 'night-drive',
    title: 'Night Drive',
    bpm: 100,
    bars: 40,
    seed: 23,
    style: 'synthwave',
    progression: [m(D), M(Bb), M(F), M(C)],
  },
  {
    id: 'afterglow',
    title: 'Afterglow',
    bpm: 128,
    bars: 48,
    seed: 37,
    style: 'techno',
    progression: [m(F), m(F), M(Db), M(Eb)],
  },
];

mkdirSync(OUT, { recursive: true });
const manifest = specs.map((spec) => {
  const samples = render(spec);
  const file = `${spec.id}.wav`;
  writeFileSync(path.join(OUT, file), wav(samples));
  const durationSec = samples.length / SR;
  console.log(
    `${file}: ${durationSec.toFixed(1)} s, ${((samples.length * 2) / 1e6).toFixed(1)} MB`,
  );
  return {
    id: spec.id,
    title: spec.title,
    artist: 'Silent Disco Sync (generated)',
    file,
    bpm: spec.bpm,
    durationSec: Math.round(durationSec * 1000) / 1000,
    license: 'Original, generated by server/scripts/generate-tracks.ts (CC0)',
  };
});
writeFileSync(path.join(OUT, 'tracks.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote tracks.json');
