/**
 * Narrated playback (integration plan 01 §3.4).
 *
 * Narration is compiled, not improvised. A slide's compiled timeline already
 * knows its click segments; this adds what each segment *says* and when the deck
 * may move on, as one schedule computed once:
 *
 * ```
 * segment i starts      when segment i-1 advanced (0 for the first)
 * its narration         plays from the segment's start, its cues one after another
 * it advances at        start + max(animation, narration) + gap
 * ```
 *
 * Everything after compilation is a pure function of time, the same rule the
 * rest of this package keeps (doc 04 §26.2): `narrationAt(schedule, t)` says
 * which recording is playing at `t` and how far into it, so an audio element's
 * `currentTime` is *set* from the schedule on every seek rather than advanced on
 * its own. Playing to `t` and seeking to `t` therefore put the voice in the same
 * place, which is the property a fixed-step video export will need.
 *
 * Reduced motion does not silence narration — narration is content, not motion.
 * It does shorten the animation, and the schedule is built from whichever
 * compiled timeline the caller passes, so the reduced durations flow through.
 */

import type { AnimationTrigger } from "@deckastra/presentation-schema";
import { pauseMsIn, scriptForDisplay } from "@deckastra/presentation-schema";

import type { CompiledTimeline } from "./compile";

export interface NarrationTakeInput {
  assetId: string;
  durationMs: number;
  gainDb?: number;
  textHash?: string;
}

export interface NarrationCueInput {
  id: string;
  step: number;
  text?: string;
  takes?: Record<string, NarrationTakeInput>;
}

export interface SoundCueInput {
  id: string;
  source: { assetId: string } | { library: string };
  trigger: AnimationTrigger;
  startMs: number;
  volume?: number;
  label?: string;
}

export interface NarrationClip {
  cueId: string;
  step: number;
  assetId: string;
  /** Narrated time, ms from the slide's arrival. */
  startMs: number;
  endMs: number;
  gainDb?: number;
}

export interface NarratedSegment {
  index: number;
  /** Narrated time this segment starts. */
  startMs: number;
  /** When its motion has finished, in narrated time. */
  animationEndMs: number;
  /** When its last recording has finished; equal to `startMs` with none. */
  narrationEndMs: number;
  /** When the deck moves on: the next segment, or the next slide after the last. */
  advanceAtMs: number;
  narration: NarrationClip[];
  /** Cues for this step that have no recording in this language. */
  missing: string[];
  /** Where this segment sits on the timeline's own clock, for mapping back. */
  timelineStartMs: number;
  timelineEndMs: number;
}

export interface ScheduledSound {
  cueId: string;
  source: SoundCueInput["source"];
  /** Narrated time it fires. */
  atMs: number;
  /** The same moment on the timeline's own clock, for the editor's lane. */
  timelineAtMs: number;
  segment: number;
  volume: number;
  durationMs: number;
}

export interface NarratedSchedule {
  slideId: string;
  locale: string;
  gapMs: number;
  segments: NarratedSegment[];
  sounds: ScheduledSound[];
  /** When the slide is finished: the last segment's advance. */
  totalMs: number;
  /** Cues naming a step this timeline does not have (W323). Kept, never played. */
  orphaned: string[];
}

export interface NarrationCompileOptions {
  locale: string;
  gapMs?: number;
  /** How long a sound lasts, for seek: an asset's recorded duration, a library sound's length. */
  soundDurationMs?: (source: SoundCueInput["source"]) => number;
  /**
   * The least a step with no narration stays on screen before a narrated deck
   * moves on. A title slide with no motion and nothing said would otherwise be
   * gone after the gap, before anyone read it. Default 0: the schedule says
   * exactly what the document says unless a player asks for a floor.
   */
  silentStepMs?: number;
}

export const DEFAULT_GAP_MS = 600;

/**
 * Build a slide's narrated schedule from its compiled timeline.
 *
 * The timeline's segments give each step's animation length; the cues give its
 * narration. A cue whose step the timeline does not have is reported as
 * orphaned and plays nowhere: guessing which step it meant would put a voice
 * over the wrong reveal, and the author may be about to put the click back.
 */
export function compileNarratedPlayback(
  timeline: CompiledTimeline,
  cues: readonly NarrationCueInput[],
  sounds: readonly SoundCueInput[],
  options: NarrationCompileOptions,
): NarratedSchedule {
  const gapMs = Math.max(0, options.gapMs ?? DEFAULT_GAP_MS);
  const segmentCount = Math.max(1, timeline.segments.length);
  const orphaned = cues.filter((cue) => cue.step >= segmentCount || cue.step < 0).map((cue) => cue.id);

  const segments: NarratedSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const source = timeline.segments[index] ?? { startMs: 0, endMs: 0 };
    const animationMs = Math.max(0, source.endMs - source.startMs);
    const start = cursor;
    const narration: NarrationClip[] = [];
    const missing: string[] = [];
    let voiceCursor = start;
    for (const cue of cues) {
      if (cue.step !== index) continue;
      const take = cue.takes?.[options.locale];
      if (!take || !(take.durationMs > 0)) {
        missing.push(cue.id);
        continue;
      }
      narration.push({
        cueId: cue.id,
        step: index,
        assetId: take.assetId,
        startMs: voiceCursor,
        endMs: voiceCursor + take.durationMs,
        ...(take.gainDb !== undefined ? { gainDb: take.gainDb } : {}),
      });
      voiceCursor += take.durationMs;
    }
    const animationEndMs = start + animationMs;
    const narrationEndMs = voiceCursor;
    const floor = narration.length === 0 ? start + Math.max(0, options.silentStepMs ?? 0) : start;
    const advanceAtMs = Math.max(animationEndMs, narrationEndMs, floor) + gapMs;
    segments.push({
      index,
      startMs: start,
      animationEndMs,
      narrationEndMs,
      advanceAtMs,
      narration,
      missing,
      timelineStartMs: source.startMs,
      timelineEndMs: source.endMs,
    });
    cursor = advanceAtMs;
  }

  const scheduledSounds = scheduleSounds(timeline, segments, sounds, options);

  return {
    slideId: timeline.slideId,
    locale: options.locale,
    gapMs,
    segments,
    sounds: scheduledSounds,
    totalMs: segments.at(-1)?.advanceAtMs ?? 0,
    orphaned,
  };
}

/**
 * When each sound fires (plan 01 §3.5): the same trigger vocabulary as a track.
 *
 * - `slideEnter` at the slide's arrival; `withPrevious` and `afterPrevious` with
 *   or after the arrival's own motion, the closest reading for a cue that has no
 *   track before it.
 * - `click` naming an element fires with the click that reveals it; a click
 *   naming nothing fires with **every** click, which is what "a pop on each
 *   reveal" means.
 * - `timer` from the slide's arrival; `marker` at the marker. `hover` never
 *   fires on its own.
 */
function scheduleSounds(
  timeline: CompiledTimeline,
  segments: readonly NarratedSegment[],
  sounds: readonly SoundCueInput[],
  options: NarrationCompileOptions,
): ScheduledSound[] {
  const out: ScheduledSound[] = [];
  const durationOf = options.soundDurationMs ?? (() => 0);
  const emit = (cue: SoundCueInput, segmentIndex: number, offsetFromSegmentStart: number) => {
    const segment = segments[segmentIndex];
    if (!segment) return;
    const offset = Math.max(0, offsetFromSegmentStart) + Math.max(0, cue.startMs);
    out.push({
      cueId: cue.id,
      source: cue.source,
      atMs: segment.startMs + offset,
      timelineAtMs: segment.timelineStartMs + offset,
      segment: segmentIndex,
      volume: cue.volume ?? 1,
      durationMs: Math.max(0, durationOf(cue.source)),
    });
  };
  for (const cue of sounds) {
    const trigger = cue.trigger;
    switch (trigger.type) {
      case "slideEnter":
      case "withPrevious":
        emit(cue, 0, 0);
        break;
      case "afterPrevious": {
        const first = segments[0];
        emit(cue, 0, first ? first.animationEndMs - first.startMs : 0);
        break;
      }
      case "timer":
        emit(cue, 0, trigger.delayMs);
        break;
      case "marker": {
        const marker = timeline.markers.find((candidate) => candidate.id === trigger.markerId);
        if (!marker) break;
        const segment = segments.findLast((candidate) => candidate.timelineStartMs <= marker.timeMs) ?? segments[0];
        if (segment) emit(cue, segment.index, marker.timeMs - segment.timelineStartMs);
        break;
      }
      case "click": {
        if (trigger.targetId) {
          const clip = timeline.clips.find((candidate) => candidate.targetId === trigger.targetId && candidate.segment > 0);
          if (clip) emit(cue, clip.segment, 0);
        } else {
          for (const segment of segments) if (segment.index > 0) emit(cue, segment.index, 0);
        }
        break;
      }
      default:
        break;
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.cueId.localeCompare(b.cueId));
}

/** The segment playing at narrated time `t`. Past the end, the last. */
export function segmentAt(schedule: NarratedSchedule, timeMs: number): NarratedSegment | undefined {
  let found = schedule.segments[0];
  for (const segment of schedule.segments) if (timeMs >= segment.startMs) found = segment;
  return found;
}

export interface NarrationPosition {
  clip: NarrationClip;
  /** How far into the recording `t` is. Set an audio element's currentTime from this. */
  offsetMs: number;
}

/**
 * The recording playing at narrated time `t`, and how far into it.
 *
 * Pure: the answer depends on `t` and the schedule alone, never on what played
 * before. That is the whole of seek parity for audio.
 */
export function narrationAt(schedule: NarratedSchedule, timeMs: number): NarrationPosition | undefined {
  for (const segment of schedule.segments) {
    for (const clip of segment.narration) {
      if (timeMs >= clip.startMs && timeMs < clip.endMs) return { clip, offsetMs: timeMs - clip.startMs };
    }
  }
  return undefined;
}

/** Sounds audible at `t`, each with how far into it `t` is. */
export function soundsAt(schedule: NarratedSchedule, timeMs: number): { sound: ScheduledSound; offsetMs: number }[] {
  return schedule.sounds
    .filter((sound) => timeMs >= sound.atMs && timeMs < sound.atMs + Math.max(1, sound.durationMs))
    .map((sound) => ({ sound, offsetMs: timeMs - sound.atMs }));
}

/** Sounds that start in `(from, to]`: what a playing clock fires as it passes them. */
export function soundsBetween(schedule: NarratedSchedule, fromMs: number, toMs: number): ScheduledSound[] {
  return schedule.sounds.filter((sound) => sound.atMs > fromMs && sound.atMs <= toMs);
}

/**
 * Narration as bars on the timeline's own clock, for the editor's audio lane.
 *
 * The timeline packs segments back to back by their animation alone, so a
 * recording longer than its segment's motion overruns into the next segment's
 * area. That is drawn as it is rather than hidden: it is exactly the moment a
 * narrated deck waits for the voice before the next click plays.
 */
export interface NarrationBar {
  cueId: string;
  step: number;
  startMs: number;
  durationMs: number;
  /** No take in this language. Drawn as a placeholder the width of its script. */
  missing: boolean;
  orphaned: boolean;
}

/** Roughly how long a script takes to say, for a cue with no recording yet: 2.6 words a second. */
export function estimateSpeechMs(text: string | undefined): number {
  // Pause markers are time, not words (`[pause 1.5s]`, plan 01 §3.8).
  const words = scriptForDisplay(text ?? "").split(/\s+/).filter(Boolean).length;
  return Math.max(800, Math.round((words / 2.6) * 1000)) + pauseMsIn(text ?? "");
}

export function narrationBars(
  timeline: CompiledTimeline,
  cues: readonly NarrationCueInput[],
  locale: string,
): NarrationBar[] {
  const bars: NarrationBar[] = [];
  const cursorByStep = new Map<number, number>();
  const last = timeline.segments.at(-1);
  // A step's voice cannot begin before the step before it has finished
  // speaking: a narrated deck waits for it. On the timeline's clock a step with
  // no motion has no length, so without this the arrival's line and the first
  // click's line would both start at zero, one drawn over the other.
  const ordered = [...cues].sort((a, b) => a.step - b.step);
  let spokenUntil = 0;
  let currentStep = -1;
  let stepEnd = 0;
  for (const cue of ordered) {
    if (cue.step !== currentStep) {
      spokenUntil = Math.max(spokenUntil, stepEnd);
      currentStep = cue.step;
    }
    const segment = timeline.segments[cue.step];
    const orphaned = !segment;
    const base = Math.max(segment ? segment.startMs : (last?.endMs ?? 0), spokenUntil);
    const start = cursorByStep.get(cue.step) ?? base;
    const take = cue.takes?.[locale];
    const durationMs = take && take.durationMs > 0 ? take.durationMs : estimateSpeechMs(cue.text);
    bars.push({ cueId: cue.id, step: cue.step, startMs: start, durationMs, missing: !take, orphaned });
    cursorByStep.set(cue.step, start + durationMs);
    stepEnd = start + durationMs;
  }
  return bars;
}
