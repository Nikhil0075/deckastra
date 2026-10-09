import { SOUND_LIBRARY_NAMES, type SoundLibraryName } from "@deckastra/presentation-schema";

/**
 * The built-in sound library (integration plan 01 §3.5).
 *
 * Every sound here is a short deterministic synthesis recipe rather than a
 * vendored recording. Three reasons, in the order they decided it:
 *
 * 1. **No licence question.** Nobody else wrote these, so there is nothing to
 *    attribute, nothing to list in the notices, and nothing a downstream
 *    redistributor has to check.
 * 2. **The same sound everywhere.** The editor plays the samples through Web
 *    Audio and the PowerPoint exporter embeds the WAV bytes this file encodes —
 *    one recipe, so the deck sounds in PowerPoint the way it did in the room.
 * 3. **Nothing in the installer.** Thirty clips as files were ~2MB; as code
 *    they are a few kilobytes.
 *
 * Deterministic: a seeded generator stands in for `Math.random`, so a sound's
 * bytes are a function of its name and a PPTX export is byte-stable.
 */

export const SOUND_SAMPLE_RATE = 22_050;

export type SoundCategory = "Transitions" | "Pops & clicks" | "Chimes" | "Feedback" | "Rhythm" | "Crowd" | "Ambient";

interface Recipe {
  label: string;
  category: SoundCategory;
  durationMs: number;
  /** Fill `out` (mono, -1..1) at `rate` samples a second. */
  render(out: Float32Array, rate: number, random: () => number): void;
}

/** mulberry32: small, fast, and the same sequence on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return hash >>> 0;
}

const TAU = Math.PI * 2;

/** A tone with an exponential decay, summed into `out` from `atSec`. */
function tone(out: Float32Array, rate: number, atSec: number, freq: number, decaySec: number, gain: number, endFreq = freq, lengthSec = decaySec * 5): void {
  const start = Math.floor(atSec * rate);
  const length = Math.min(out.length - start, Math.floor(lengthSec * rate));
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    const progress = length > 1 ? i / (length - 1) : 0;
    const f = freq + (endFreq - freq) * progress;
    phase += (TAU * f) / rate;
    const attack = Math.min(1, t / 0.004);
    out[start + i]! += Math.sin(phase) * Math.exp(-t / decaySec) * attack * gain;
  }
}

/** Noise through a one-pole low-pass whose cutoff and level follow envelopes. */
function noise(
  out: Float32Array,
  rate: number,
  random: () => number,
  atSec: number,
  lengthSec: number,
  gain: number,
  shape: (progress: number) => number,
  cutoff: (progress: number) => number = () => 0.5,
): void {
  const start = Math.floor(atSec * rate);
  const length = Math.min(out.length - start, Math.floor(lengthSec * rate));
  let low = 0;
  for (let i = 0; i < length; i += 1) {
    const progress = length > 1 ? i / (length - 1) : 0;
    const white = random() * 2 - 1;
    const k = Math.max(0.01, Math.min(0.99, cutoff(progress)));
    low += k * (white - low);
    out[start + i]! += low * shape(progress) * gain;
  }
}

const bell = (p: number) => Math.sin(Math.PI * p) ** 2;
const decay = (rate: number) => (p: number) => Math.exp(-p * rate);

const RECIPES: Record<SoundLibraryName, Recipe> = {
  "whoosh-soft": { label: "Whoosh, soft", category: "Transitions", durationMs: 450, render: (o, r, n) => noise(o, r, n, 0, 0.45, 0.7, bell, (p) => 0.05 + 0.25 * bell(p)) },
  "whoosh-fast": { label: "Whoosh, fast", category: "Transitions", durationMs: 260, render: (o, r, n) => noise(o, r, n, 0, 0.26, 0.8, bell, (p) => 0.08 + 0.4 * bell(p)) },
  "swoosh-up": { label: "Swoosh up", category: "Transitions", durationMs: 400, render: (o, r, n) => noise(o, r, n, 0, 0.4, 0.75, bell, (p) => 0.03 + 0.5 * p) },
  "swoosh-down": { label: "Swoosh down", category: "Transitions", durationMs: 400, render: (o, r, n) => noise(o, r, n, 0, 0.4, 0.75, bell, (p) => 0.53 - 0.5 * p) },
  "transition-sweep": {
    label: "Sweep",
    category: "Transitions",
    durationMs: 600,
    render: (o, r, n) => {
      tone(o, r, 0, 200, 0.6, 0.25, 1200, 0.6);
      noise(o, r, n, 0, 0.6, 0.35, bell, (p) => 0.05 + 0.3 * p);
    },
  },
  pop: { label: "Pop", category: "Pops & clicks", durationMs: 90, render: (o, r) => tone(o, r, 0, 620, 0.02, 0.9, 180, 0.09) },
  "pop-soft": { label: "Pop, soft", category: "Pops & clicks", durationMs: 110, render: (o, r) => tone(o, r, 0, 420, 0.03, 0.55, 160, 0.11) },
  bloop: { label: "Bloop", category: "Pops & clicks", durationMs: 160, render: (o, r) => tone(o, r, 0, 300, 0.06, 0.7, 760, 0.16) },
  click: { label: "Click", category: "Pops & clicks", durationMs: 25, render: (o, r, n) => noise(o, r, n, 0, 0.025, 0.9, decay(6), () => 0.9) },
  "click-soft": { label: "Click, soft", category: "Pops & clicks", durationMs: 30, render: (o, r, n) => noise(o, r, n, 0, 0.03, 0.5, decay(5), () => 0.4) },
  tick: { label: "Tick", category: "Pops & clicks", durationMs: 30, render: (o, r) => tone(o, r, 0, 2100, 0.006, 0.6, 2100, 0.03) },
  keystroke: {
    label: "Keystroke",
    category: "Pops & clicks",
    durationMs: 60,
    render: (o, r, n) => {
      noise(o, r, n, 0, 0.03, 0.6, decay(5), () => 0.7);
      tone(o, r, 0, 140, 0.015, 0.4, 90, 0.06);
    },
  },
  typing: {
    label: "Typing",
    category: "Rhythm",
    durationMs: 1300,
    render: (o, r, n) => {
      let at = 0.02;
      while (at < 1.2) {
        noise(o, r, n, at, 0.03, 0.4 + n() * 0.3, decay(5), () => 0.6 + n() * 0.3);
        tone(o, r, at, 120 + n() * 40, 0.012, 0.25, 90, 0.05);
        at += 0.07 + n() * 0.09;
      }
    },
  },
  chime: {
    label: "Chime",
    category: "Chimes",
    durationMs: 1200,
    render: (o, r) => {
      tone(o, r, 0, 880, 0.35, 0.35);
      tone(o, r, 0, 1320, 0.25, 0.2);
      tone(o, r, 0, 1760, 0.18, 0.12);
    },
  },
  "chime-high": {
    label: "Chime, high",
    category: "Chimes",
    durationMs: 1000,
    render: (o, r) => {
      tone(o, r, 0, 1320, 0.28, 0.3);
      tone(o, r, 0, 1980, 0.2, 0.18);
    },
  },
  ding: { label: "Ding", category: "Chimes", durationMs: 900, render: (o, r) => { tone(o, r, 0, 1046, 0.25, 0.45); tone(o, r, 0, 2093, 0.12, 0.12); } },
  bell: {
    label: "Bell",
    category: "Chimes",
    durationMs: 1600,
    render: (o, r) => {
      for (const [ratio, gain, length] of [[1, 0.35, 0.5], [2.76, 0.18, 0.3], [5.4, 0.1, 0.18], [8.93, 0.05, 0.1]] as const) {
        tone(o, r, 0, 520 * ratio, length, gain, 520 * ratio, 1.6);
      }
    },
  },
  sparkle: {
    label: "Sparkle",
    category: "Chimes",
    durationMs: 700,
    render: (o, r, n) => {
      for (let i = 0; i < 9; i += 1) tone(o, r, i * 0.06 + n() * 0.02, 1800 + n() * 2200, 0.05, 0.18);
    },
  },
  notify: { label: "Notify", category: "Feedback", durationMs: 420, render: (o, r) => { tone(o, r, 0, 660, 0.08, 0.45, 660, 0.18); tone(o, r, 0.16, 880, 0.12, 0.45, 880, 0.26); } },
  success: {
    label: "Success",
    category: "Feedback",
    durationMs: 650,
    render: (o, r) => {
      [523.25, 659.25, 783.99].forEach((f, i) => tone(o, r, i * 0.09, f, 0.18, 0.35, f, 0.45));
    },
  },
  "level-up": {
    label: "Level up",
    category: "Feedback",
    durationMs: 800,
    render: (o, r) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(o, r, i * 0.1, f, 0.14, 0.32, f, 0.4));
    },
  },
  coin: { label: "Coin", category: "Feedback", durationMs: 400, render: (o, r) => { tone(o, r, 0, 988, 0.03, 0.4, 988, 0.08); tone(o, r, 0.08, 1319, 0.12, 0.4, 1319, 0.32); } },
  "error-buzz": {
    label: "Buzz",
    category: "Feedback",
    durationMs: 380,
    render: (o, r) => {
      const length = Math.floor(0.36 * r);
      for (let i = 0; i < length && i < o.length; i += 1) {
        const t = i / r;
        o[i]! += (Math.sin(TAU * 110 * t) >= 0 ? 0.25 : -0.25) * Math.min(1, t / 0.01) * Math.exp(-t / 0.3);
      }
    },
  },
  rise: { label: "Rise", category: "Transitions", durationMs: 800, render: (o, r) => tone(o, r, 0, 220, 0.5, 0.4, 880, 0.8) },
  fall: { label: "Fall", category: "Transitions", durationMs: 800, render: (o, r) => tone(o, r, 0, 880, 0.5, 0.4, 220, 0.8) },
  thud: { label: "Thud", category: "Rhythm", durationMs: 260, render: (o, r, n) => { tone(o, r, 0, 70, 0.07, 0.9, 45, 0.26); noise(o, r, n, 0, 0.04, 0.3, decay(6), () => 0.2); } },
  knock: {
    label: "Knock",
    category: "Rhythm",
    durationMs: 380,
    render: (o, r, n) => {
      for (const at of [0, 0.17]) {
        tone(o, r, at, 180, 0.03, 0.6, 120, 0.12);
        noise(o, r, n, at, 0.02, 0.4, decay(6), () => 0.5);
      }
    },
  },
  heartbeat: {
    label: "Heartbeat",
    category: "Rhythm",
    durationMs: 1100,
    render: (o, r) => {
      for (const [at, gain] of [[0, 0.9], [0.22, 0.6], [0.8, 0.9]] as const) tone(o, r, at, 60, 0.06, gain, 40, 0.2);
    },
  },
  "drum-roll": {
    label: "Drum roll",
    category: "Rhythm",
    durationMs: 1500,
    render: (o, r, n) => {
      for (let at = 0; at < 1.45; at += 0.032) noise(o, r, n, at, 0.05, 0.15 + 0.35 * (at / 1.45), decay(4), () => 0.35);
      tone(o, r, 1.42, 80, 0.08, 0.7, 50, 0.08);
    },
  },
  applause: {
    label: "Applause",
    category: "Crowd",
    durationMs: 2600,
    render: (o, r, n) => {
      const total = 2.5;
      for (let i = 0; i < 520; i += 1) {
        const at = n() * total;
        const envelope = Math.min(1, at / 0.4) * Math.min(1, (total - at) / 0.9);
        noise(o, r, n, at, 0.012, 0.35 * envelope * (0.5 + n() * 0.5), decay(4), () => 0.5 + n() * 0.4);
      }
    },
  },
  "camera-shutter": {
    label: "Camera shutter",
    category: "Pops & clicks",
    durationMs: 220,
    render: (o, r, n) => {
      noise(o, r, n, 0, 0.05, 0.7, decay(5), () => 0.8);
      noise(o, r, n, 0.11, 0.06, 0.5, decay(5), () => 0.6);
    },
  },
  "ui-confirm": { label: "UI confirm", category: "Feedback", durationMs: 360, render: (o, r) => { tone(o, r, 0, 740, 0.08, 0.35, 740, 0.18); tone(o, r, 0.12, 1110, 0.12, 0.4, 1110, 0.24); } },
  "ui-cancel": { label: "UI cancel", category: "Feedback", durationMs: 300, render: (o, r) => { tone(o, r, 0, 520, 0.07, 0.35, 420, 0.14); tone(o, r, 0.11, 310, 0.09, 0.35, 260, 0.18); } },
  swipe: { label: "Swipe", category: "Transitions", durationMs: 320, render: (o, r, n) => noise(o, r, n, 0, 0.32, 0.75, bell, (p) => 0.55 - 0.45 * p) },
  "riser-short": { label: "Riser, short", category: "Transitions", durationMs: 1200, render: (o, r, n) => { tone(o, r, 0, 110, 0.8, 0.3, 880, 1.2); noise(o, r, n, 0, 1.2, 0.3, (p) => p * p, (p) => 0.05 + p * 0.45); } },
  "riser-long": { label: "Riser, long", category: "Transitions", durationMs: 2600, render: (o, r, n) => { tone(o, r, 0, 80, 1.5, 0.28, 960, 2.6); noise(o, r, n, 0, 2.6, 0.28, (p) => p * p, (p) => 0.04 + p * 0.5); } },
  "chime-warm": { label: "Chime, warm", category: "Chimes", durationMs: 1500, render: (o, r) => { tone(o, r, 0, 440, 0.45, 0.35, 440, 1.5); tone(o, r, 0.04, 660, 0.35, 0.22, 660, 1.3); tone(o, r, 0.08, 880, 0.25, 0.12, 880, 1.1); } },
  "ambient-calm": { label: "Ambient, calm", category: "Ambient", durationMs: 6000, render: (o, r, n) => { tone(o, r, 0, 110, 5, 0.12, 116, 6); tone(o, r, 0, 165, 4, 0.08, 172, 6); noise(o, r, n, 0, 6, 0.05, bell, () => 0.03); } },
  "ambient-focus": { label: "Ambient, focus", category: "Ambient", durationMs: 6000, render: (o, r) => { for (let at = 0; at < 6; at += 0.75) { tone(o, r, at, 220, 0.35, 0.1, 330, 0.7); tone(o, r, at + 0.18, 440, 0.25, 0.06, 440, 0.5); } } },
  "ambient-pulse": { label: "Ambient, pulse", category: "Ambient", durationMs: 4000, render: (o, r, n) => { for (let at = 0; at < 4; at += 0.5) { tone(o, r, at, 82, 0.12, 0.18, 62, 0.35); noise(o, r, n, at, 0.08, 0.05, decay(4), () => 0.15); } } },
};

export interface LibrarySound {
  name: SoundLibraryName;
  label: string;
  category: SoundCategory;
  durationMs: number;
}

/** The library, in the order the schema lists it, for the picker. */
export const SOUND_LIBRARY: readonly LibrarySound[] = SOUND_LIBRARY_NAMES.map((name) => ({
  name,
  label: RECIPES[name].label,
  category: RECIPES[name].category,
  durationMs: RECIPES[name].durationMs,
}));

export function isLibrarySound(name: string): name is SoundLibraryName {
  return Object.hasOwn(RECIPES, name);
}

export function librarySoundDurationMs(name: string): number {
  return isLibrarySound(name) ? RECIPES[name].durationMs : 0;
}

const sampleCache = new Map<string, Float32Array>();

/**
 * A library sound as mono samples at `SOUND_SAMPLE_RATE`, peak-normalised to
 * -1 dBFS so every sound in the library sits at one level. Undefined for a name
 * this build does not know (W324), which plays as silence.
 */
export function librarySoundSamples(name: string): Float32Array | undefined {
  if (!isLibrarySound(name)) return undefined;
  const cached = sampleCache.get(name);
  if (cached) return cached;
  const recipe = RECIPES[name];
  const out = new Float32Array(Math.ceil((recipe.durationMs / 1000) * SOUND_SAMPLE_RATE));
  recipe.render(out, SOUND_SAMPLE_RATE, seeded(seedOf(name)));
  let peak = 0;
  for (const sample of out) peak = Math.max(peak, Math.abs(sample));
  const target = 0.89; // -1 dBFS
  if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] = (out[i]! / peak) * target;
  // A few milliseconds of fade at the end, so no sound stops with a click.
  const fade = Math.min(out.length, Math.floor(0.006 * SOUND_SAMPLE_RATE));
  for (let i = 0; i < fade; i += 1) out[out.length - 1 - i]! *= i / fade;
  sampleCache.set(name, out);
  return out;
}

/** 16-bit PCM WAV of mono samples: what PowerPoint embeds and any player opens. */
export function encodeWav(samples: Float32Array, sampleRate = SOUND_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

/** A library sound as WAV bytes, or undefined for a name this build lacks. */
export function librarySoundWav(name: string): Uint8Array | undefined {
  const samples = librarySoundSamples(name);
  return samples ? encodeWav(samples) : undefined;
}

/**
 * Peaks for a waveform: the largest absolute sample in each of `buckets` equal
 * slices, 0..1. The same shape the API stores for an upload, so the timeline's
 * audio lane draws a library sound and a recording the same way.
 */
export function waveformPeaks(samples: Float32Array, buckets = 256): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b += 1) {
    let peak = 0;
    const end = Math.min(samples.length, (b + 1) * size);
    for (let i = b * size; i < end; i += 1) peak = Math.max(peak, Math.abs(samples[i]!));
    out.push(Math.round(peak * 1000) / 1000);
  }
  return out;
}
