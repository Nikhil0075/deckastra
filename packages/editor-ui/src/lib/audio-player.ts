"use client";

import { librarySoundSamples, SOUND_SAMPLE_RATE, type SceneAudio } from "@deckastra/renderer";
import { narrationAt, spokenWordAt, type NarratedSchedule } from "@deckastra/animation-engine";

/**
 * Playing a slide's narration and sounds (integration plan 01 §3.4, §3.5).
 *
 * Two halves, split the way the motion engine is:
 *
 * - **`stepPlan` is pure.** Given a compiled schedule, a step, and how far into
 *   that step we are, it says which recordings and sounds play, how long until
 *   each starts, and how far into each to start it. Nothing about it depends on
 *   what played before — the schedule's rule, and what makes resuming after a
 *   pause land the voice where it would have been.
 * - **`StepPlayer` is the browser.** It turns a plan into audio elements and Web
 *   Audio buffers, and **sets** each one's position from the plan rather than
 *   letting it run free. A paused step that resumes asks for a fresh plan at
 *   the new offset; nothing is "continued".
 */

export interface PlannedAudio {
  kind: "narration" | "sound" | "music";
  /** The cue, for the presenter view's script line. */
  cueId: string;
  source: { assetId: string } | { library: string };
  /** Milliseconds from now until it starts; 0 when it is already playing. */
  delayMs: number;
  /** How far into the recording to start. */
  offsetMs: number;
  volume: number;
  /** When it ends, relative to now. */
  endsInMs: number;
  /** Precompiled soundtrack gain changes, relative to now. */
  gain?: { delayMs: number; volume: number }[];
  loop?: boolean;
}

export interface StepPlan {
  audio: PlannedAudio[];
  /** Milliseconds from now until a narrated deck advances; undefined past the end. */
  advanceInMs: number;
  /** Length of the whole step, gap included. */
  stepMs: number;
}

/** A take's trim as an audio element's volume: the one conversion playback, Play and PPTX share. */
export function gainToVolume(gainDb: number | undefined): number {
  if (!gainDb) return 1;
  return Math.max(0, Math.min(1, 10 ** (gainDb / 20)));
}

/** What plays in step `index`, from `offsetMs` into it. Pure. */
export function stepPlan(schedule: NarratedSchedule, index: number, offsetMs = 0): StepPlan | undefined {
  const segment = schedule.segments[index];
  if (!segment) return undefined;
  const now = segment.startMs + Math.max(0, offsetMs);
  const audio: PlannedAudio[] = [];
  // A word-triggered advance may begin this step while the preceding line is
  // still speaking. Re-plan every recording audible now, including that line,
  // so changing step seeks it to the same word instead of cutting it off.
  for (const clip of schedule.segments.flatMap((candidate) => candidate.narration)) {
    if (clip.endMs <= now) continue;
    audio.push({
      kind: "narration",
      cueId: clip.cueId,
      source: { assetId: clip.assetId },
      delayMs: Math.max(0, clip.startMs - now),
      offsetMs: Math.max(0, now - clip.startMs),
      volume: gainToVolume(clip.gainDb),
      endsInMs: clip.endMs - now,
    });
  }
  for (const sound of schedule.sounds) {
    if (sound.segment !== index) continue;
    const end = sound.atMs + Math.max(1, sound.durationMs);
    if (end <= now) continue;
    audio.push({
      kind: "sound",
      cueId: sound.cueId,
      source: sound.source,
      delayMs: Math.max(0, sound.atMs - now),
      offsetMs: Math.max(0, now - sound.atMs),
      volume: sound.volume,
      endsInMs: end - now,
    });
  }
  const music = schedule.soundtrack;
  if (music && music.durationMs > 0 && (music.loop || now < music.durationMs)) {
    const gainAt = (at: number): number => {
      let value = music.gain[0]?.volume ?? 0;
      for (const point of music.gain) {
        if (point.atMs > at) break;
        value = point.volume;
      }
      return value;
    };
    audio.push({
      kind: "music",
      cueId: "soundtrack",
      source: music.source,
      delayMs: 0,
      offsetMs: music.loop ? now % music.durationMs : now,
      volume: gainAt(now),
      endsInMs: segment.advanceAtMs - now,
      gain: music.gain.filter((point) => point.atMs > now && point.atMs <= segment.advanceAtMs)
        .map((point) => ({ delayMs: point.atMs - now, volume: point.volume })),
      loop: music.loop,
    });
  }
  audio.sort((a, b) => a.delayMs - b.delayMs);
  return { audio, advanceInMs: Math.max(0, segment.advanceAtMs - now), stepMs: segment.advanceAtMs - segment.startMs };
}

/** The cue being spoken at `offsetMs` into a step, and how long it has left. */
export function speakingAt(schedule: NarratedSchedule, index: number, offsetMs: number): { cueId: string; remainingMs: number; wordIndex?: number; word?: string } | undefined {
  const segment = schedule.segments[index];
  if (!segment) return undefined;
  const at = narrationAt(schedule, segment.startMs + offsetMs);
  if (!at) return undefined;
  const currentWord = spokenWordAt(schedule, segment.startMs + offsetMs);
  return {
    cueId: at.clip.cueId,
    remainingMs: at.clip.endMs - at.clip.startMs - at.offsetMs,
    ...(currentWord ? { wordIndex: currentWord.index, word: currentWord.word } : {}),
  };
}

interface Playing {
  stop(): void;
  setVolume?(volume: number): void;
}

/**
 * Plays one step's plan in a browser. Disposable: a new step, a pause or a
 * seek makes a new plan and a new player, so no audio outlives the moment it
 * belonged to.
 */
export class StepPlayer {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private playing: Playing[] = [];
  private stopped = false;

  constructor(
    private readonly resolveUrl: (assetId: string, storageKey?: string) => string | undefined,
    private readonly files: Record<string, SceneAudio>,
    private readonly context: () => AudioContext | undefined,
    private readonly muted: boolean,
  ) {}

  start(plan: StepPlan, onAdvance?: () => void): void {
    for (const item of plan.audio) {
      const begin = () => {
        if (this.stopped || this.muted) return;
        const handle = "assetId" in item.source ? this.playFile(item.source.assetId, item.offsetMs, item.volume, item.loop) : this.playLibrary(item.source.library, item.offsetMs, item.volume, item.loop);
        if (handle) {
          this.playing.push(handle);
          for (const point of item.gain ?? []) {
            this.timers.push(setTimeout(() => handle.setVolume?.(point.volume), point.delayMs));
          }
        }
      };
      if (item.delayMs <= 0) begin();
      else this.timers.push(setTimeout(begin, item.delayMs));
    }
    if (onAdvance) this.timers.push(setTimeout(() => !this.stopped && onAdvance(), plan.advanceInMs));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const handle of this.playing) handle.stop();
    this.playing = [];
  }

  private playFile(assetId: string, offsetMs: number, volume: number, loop = false): Playing | undefined {
    const file = this.files[assetId];
    const url = this.resolveUrl(assetId, file?.storageKey);
    if (!url || typeof Audio === "undefined") return undefined;
    const element = new Audio();
    element.preload = "auto";
    element.src = url;
    element.volume = Math.max(0, Math.min(1, volume));
    element.loop = loop;
    // Set, never advanced on its own: the schedule says where the voice is.
    const seek = () => {
      try {
        element.currentTime = offsetMs / 1000;
      } catch {
        // Not seekable yet; it starts from 0, which is right when offset is 0.
      }
    };
    if (element.readyState >= 1) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    void element.play().catch(() => {
      // Autoplay refused or the file is unreachable: silence, never a crash
      // in front of a room.
    });
    return {
      setVolume: (next) => { element.volume = Math.max(0, Math.min(1, next)); },
      stop: () => {
        element.pause();
        element.removeAttribute("src");
        element.load();
      },
    };
  }

  private playLibrary(name: string, offsetMs: number, volume: number, loop = false): Playing | undefined {
    const samples = librarySoundSamples(name);
    const context = this.context();
    if (!samples || !context) return undefined;
    const buffer = context.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    source.connect(gain).connect(context.destination);
    source.start(0, Math.max(0, offsetMs) / 1000);
    return {
      setVolume: (next) => { gain.gain.value = Math.max(0, Math.min(1, next)); },
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already ended.
        }
      },
    };
  }
}

let sharedContext: AudioContext | undefined;

/** One AudioContext for the page, made on first use (after a gesture, which present mode always is). */
export function audioContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return undefined;
  sharedContext ??= new Constructor();
  if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => {});
  return sharedContext;
}

/** Play one library sound now, for a picker's preview. */
export function previewLibrarySound(name: string, volume = 1): void {
  const player = new StepPlayer(() => undefined, {}, audioContext, false);
  player.start({
    audio: [{ kind: "sound", cueId: "preview", source: { library: name }, delayMs: 0, offsetMs: 0, volume, endsInMs: 0 }],
    advanceInMs: 0,
    stepMs: 0,
  });
}
