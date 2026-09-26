/**
 * Presenter-view rules (Phase 3, Figma frames "present mode" and "present mode
 * with notes"): how many click steps a slide has, the talk timer, and time
 * remaining against a target. Pure, so tested directly.
 *
 * Everything here is **session state**, never document state: the elapsed time,
 * the step a presenter is on and the target length belong to this run of this
 * talk (doc 02 §4.1). A target written into the deck would be one presenter's
 * plan imposed on the next.
 */

import type { SlideScene } from "@deckastra/renderer";
import type { AnimationTrack } from "@deckastra/presentation-schema";
import { compileTimeline } from "@deckastra/animation-engine";

/**
 * Click steps on a slide: the reveals a presenter clicks through before the
 * next click changes slide. Zero for a slide that only animates on entry.
 *
 * Counted from the same compiled timeline present mode plays, with the same
 * reduced-motion setting, so the presenter's "step 3 of 4" and the audience's
 * fourth reveal cannot disagree. Segment 0 is the slide's entry; every click
 * track opens another.
 */
export function clickSteps(scene: SlideScene, reducedMotion: boolean): number {
  const tracks = (scene.animations ?? []) as AnimationTrack[];
  if (tracks.length === 0) return 0;
  const timeline = compileTimeline(scene, tracks, { systemPrefersReducedMotion: reducedMotion });
  return Math.max(0, timeline.segments.length - 1);
}

/** Where the presenter is within a slide's click steps. */
export interface StepPosition {
  /** Reveals done, 0 … steps. */
  step: number;
  steps: number;
}

/**
 * "Step 3 of 4" counts the slide's states, not its clicks: arriving is state 1,
 * each reveal adds one. A slide with no click steps has no step line at all —
 * "Step 1 of 1" tells a presenter nothing.
 */
export function stepLabel({ step, steps }: StepPosition): string | null {
  if (steps <= 0) return null;
  const clamped = Math.max(0, Math.min(step, steps));
  return `Step ${clamped + 1} of ${steps + 1}`;
}

/** `04:12`, or `1:04:12` past an hour. Negative input reads as zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** The big timer: `00:04:12`, hours always shown, as in the Figma frame. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export interface Remaining {
  /** "05:48", or "+01:12" once over. */
  text: string;
  over: boolean;
}

/**
 * Time left against a target, in whole seconds. Over time is said as time
 * *over* — a clock sitting at 00:00 tells a presenter nothing about how far
 * past the slot they are, and that is the number they need.
 */
export function remaining(targetMs: number, elapsedMs: number): Remaining {
  const left = Math.ceil((targetMs - elapsedMs) / 1000) * 1000;
  if (left >= 0) return { text: formatDuration(left), over: false };
  return { text: `+${formatDuration(-left)}`, over: true };
}

/** Local time, formatted without Intl so it cannot vary with the runtime's ICU. */
export function clockOf(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
