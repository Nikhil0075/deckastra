/**
 * A transition's state at `t`, as a pure function (doc 04 §26.2).
 *
 * Nothing here reads a scene, a clock, or anything it was not passed. Playback
 * is a loop that calls this; seeking is one call. That is the whole reason they
 * are guaranteed to agree — there is exactly one function that computes a value,
 * and no value is ever advanced frame by frame.
 *
 * It is deliberately *not* WAAPI, matching `sample.ts` for clips: letting the
 * browser own the interpolation moves parity into the browser and leaves a
 * fixed-step video export reproducing whatever Chromium happened to do.
 */

import { easingAt, round } from "../easing";
import type { CompiledTransition, TransitionKeyframe } from "./types";

export interface TransitionStyles {
  /** Keyed by `slide:out`, `slide:in`, or a paired element id. */
  [targetId: string]: Record<string, string | number>;
}

function numeric(value: string | number): { value: number; unit: string } | undefined {
  if (typeof value === "number") return { value, unit: "" };
  const match = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(value.trim());
  if (!match) return undefined;
  return { value: Number(match[1]), unit: match[2] ?? "" };
}

/**
 * Interpolate one property between two keyframes.
 *
 * A property whose two ends carry different units is not interpolated — it
 * switches at the midpoint. Blending `100%` into `0px` has no meaning, and
 * inventing one produces motion nobody asked for; switching is at least
 * explicable.
 */
function interpolate(from: string | number, to: string | number, progress: number): string | number {
  const start = numeric(from);
  const end = numeric(to);
  if (!start || !end || start.unit !== end.unit) return progress < 0.5 ? from : to;
  const value = round(start.value + (end.value - start.value) * progress);
  return start.unit ? `${value}${start.unit}` : value;
}

function surrounding(
  keyframes: readonly TransitionKeyframe[],
  offset: number,
): [TransitionKeyframe, TransitionKeyframe, number] {
  // Offsets are authored in order, and the compiler emits them that way. Clamped
  // at both ends rather than extrapolated: past the end a transition holds its
  // final state, which is what "the slide has arrived" means.
  let before = keyframes[0]!;
  let after = keyframes[keyframes.length - 1]!;
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const current = keyframes[index]!;
    const next = keyframes[index + 1]!;
    if (offset >= current.offset && offset <= next.offset) {
      before = current;
      after = next;
      break;
    }
  }
  const span = after.offset - before.offset;
  const progress = span <= 0 ? 1 : (offset - before.offset) / span;
  return [before, after, Math.min(1, Math.max(0, progress))];
}

/**
 * Every layer's style at `t` milliseconds into the transition.
 *
 * `t` outside the duration is clamped, not refused: a caller seeking past the
 * end is asking what the deck looks like afterwards, and the answer is the final
 * frame.
 */
export function sampleTransition(transition: CompiledTransition, t: number): TransitionStyles {
  const styles: TransitionStyles = {};
  if (transition.durationMs <= 0) return styles;

  const clamped = Math.min(transition.durationMs, Math.max(0, t));
  const offset = clamped / transition.durationMs;

  for (const track of transition.tracks) {
    if (track.keyframes.length === 0) continue;
    const [before, after, progress] = surrounding(track.keyframes, offset);
    const eased = easingAt(track.easing, progress);

    const properties: Record<string, string | number> = {};
    // Union of both ends: a property that appears on only one keyframe still has
    // to be written, or it keeps whatever the previous frame left behind.
    for (const name of new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])) {
      const from = before.properties[name] ?? after.properties[name]!;
      const to = after.properties[name] ?? before.properties[name]!;
      properties[name] = interpolate(from, to, eased);
    }
    styles[track.targetId] = properties;
  }

  return styles;
}

/** Whether a target is still doing anything at `t`, for cheap culling. */
export function isTransitionComplete(transition: CompiledTransition, t: number): boolean {
  return t >= transition.durationMs;
}
