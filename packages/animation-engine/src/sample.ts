/**
 * Sampling a compiled timeline at a time (doc 04 §26.2).
 *
 * The acceptance criterion is seek-vs-play parity: for any `t`, playing to `t`
 * and seeking to `t` must produce identical computed styles. The usual way to
 * fail it is to advance state frame by frame — a counter that drifts, a value
 * that eases from wherever it happens to be — and then discover that scrubbing
 * backwards gives a different picture from scrubbing forwards.
 *
 * So this is the only thing that computes a value, and it is a **pure function of
 * `t`**. Playback is a loop that calls it; seeking is one call. Parity is not
 * something the tests establish, it is something they can only fail to break.
 *
 * Doc 04 §23.1 recommends the Web Animations API, and the adapter interface in
 * §22.1 leaves room for it. It is deliberately not the default here: WAAPI owns
 * the interpolation, which moves parity from *our* code into the browser's, and
 * a fixed-step video export (§26.1) then has to reproduce whatever the browser
 * did. One sampler driving all three surfaces is what §26.1 actually asks for.
 */

import type { CompiledClip, CompiledProperty, CompiledTimeline } from "./compile";
import { easingAt, round } from "./easing";

/** What a target looks like at one instant. */
export interface SampledTarget {
  targetId: string;
  subTarget?: string;
  values: Record<string, unknown>;
}

export type Sample = Map<string, SampledTarget>;

export function targetKey(targetId: string, subTarget?: string): string {
  return subTarget ? `${targetId}|${subTarget}` : targetId;
}

/**
 * Every animated target's property values at `timeMs`.
 *
 * A target with no clip covering `t` is absent from the result rather than
 * present with defaults: the caller must be able to tell "this element is not
 * animating" from "this element is animating to its resting value", because the
 * first should have no inline styles at all and the second should.
 */
export interface SampleOptions {
  /** Ambient time keeps advancing while finite reveal time waits for a click. */
  ambientTimeMs?: number;
  /** Current click segment; loops in later segments stay in pre-roll. */
  activeSegment?: number;
  /** Ambient clock value captured when each segment became active. */
  segmentStartedAt?: ReadonlyMap<number, number>;
  /** Freeze every repeating clip at its authored static/rest frame. */
  useRestFrame?: boolean;
}

export function sampleAt(timeline: CompiledTimeline, timeMs: number, options: SampleOptions = {}): Sample {
  const sample: Sample = new Map();

  // Document order is the tie-break: doc 04 §25.3 resolves an overlap in favour
  // of the later-defined clip, and `clips` is already in that order.
  for (const clip of timeline.clips) {
    for (const property of clip.properties) {
      const value = valueAt(clip, property, sampleTimeForClip(timeline, clip, timeMs, options));
      if (value === undefined) continue;

      const key = targetKey(clip.targetId, clip.subTarget);
      const existing = sample.get(key);

      if (existing) {
        existing.values[property.property] = value;
      } else {
        sample.set(key, {
          targetId: clip.targetId,
          subTarget: clip.subTarget,
          values: { [property.property]: value },
        });
      }
    }
  }

  return sample;
}

function sampleTimeForClip(
  timeline: CompiledTimeline,
  clip: CompiledClip,
  finiteTimeMs: number,
  options: SampleOptions,
): number {
  if (options.useRestFrame && clip.iterations !== 1) {
    return clip.startMs + clip.restOffset * clip.periodMs;
  }
  if (clip.iterations !== Infinity || options.ambientTimeMs === undefined) return finiteTimeMs;
  const active = options.activeSegment ?? timeline.segments.length - 1;
  if (clip.segment > active) return clip.startMs - 1;
  if (clip.segment === 0) return options.ambientTimeMs;
  const segment = timeline.segments[clip.segment];
  const activatedAt = options.segmentStartedAt?.get(clip.segment);
  if (!segment || activatedAt === undefined) return finiteTimeMs;
  return segment.startMs + (options.ambientTimeMs - activatedAt);
}

/**
 * One property's value at `timeMs`, or `undefined` when this clip has nothing to
 * say about it.
 *
 * The two ends are where the bugs live, and they are opposite mistakes.
 *
 * **Before the clip**, the first keyframe holds. An element whose fade-in starts
 * on the presenter's second click must be invisible from the moment the slide
 * appears — otherwise it is on screen, then vanishes, then fades back in, and
 * the reveal has become a flash. This is `fill: backwards`, and it is the
 * default here even though the CSS default is `forwards`; see `CompiledClip.fill`.
 *
 * **After the clip**, the last value holds. An element that snaps back to its
 * pre-entrance state the moment its clip finishes is the single most common
 * animation bug there is.
 */
function valueAt(
  clip: CompiledClip,
  property: CompiledProperty,
  timeMs: number,
): unknown {
  const keyframes = property.keyframes;
  if (keyframes.length === 0) return undefined;

  const startValue = valueAtBase(property, clip.startMs + phaseAtStart(clip) * clip.periodMs);
  const endValue = valueAtBase(property, clip.startMs + phaseAtEnd(clip) * clip.periodMs);

  if (timeMs < clip.startMs) {
    const holdsBefore = clip.fill === "backwards" || clip.fill === "both";
    return holdsBefore ? startValue : undefined;
  }
  if (clip.iterations !== Infinity && timeMs >= clip.endMs) {
    const holdsAfter = clip.fill === "forwards" || clip.fill === "both";
    return holdsAfter ? endValue : undefined;
  }

  if (clip.periodMs > 0 && (clip.iterations !== 1 || clip.direction === "reverse")) {
    const elapsed = Math.max(0, timeMs - clip.startMs);
    const cycle = Math.floor(elapsed / clip.periodMs);
    const within = elapsed % clip.periodMs;
    let phase = within / clip.periodMs;
    if (clip.direction === "reverse" || (clip.direction === "alternate" && cycle % 2 === 1)) phase = 1 - phase;
    return valueAtBase(property, clip.startMs + phase * clip.periodMs);
  }

  return valueAtBase(property, timeMs);
}

function phaseAtStart(clip: CompiledClip): number {
  return clip.direction === "reverse" ? 1 : 0;
}

function phaseAtEnd(clip: CompiledClip): number {
  if (clip.direction === "reverse") return 0;
  if (clip.direction === "alternate" && Number.isFinite(clip.iterations) && clip.iterations % 2 === 0) return 0;
  return 1;
}

function valueAtBase(property: CompiledProperty, timeMs: number): unknown {
  const keyframes = property.keyframes;
  if (keyframes.length === 0) return undefined;
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  if (timeMs <= first.timeMs) return first.value;
  if (timeMs >= last.timeMs) return last.value;

  // Linear scan. The alternative is a binary search, and a clip has single-digit
  // keyframes except for a sampled spring, where it has about forty — still
  // faster to walk than to branch.
  for (let index = 1; index < keyframes.length; index += 1) {
    const to = keyframes[index]!;
    if (timeMs > to.timeMs) continue;

    const from = keyframes[index - 1]!;
    const span = to.timeMs - from.timeMs;
    // Two keyframes at the same instant: the later one wins outright. Dividing
    // by the span would be a division by zero.
    if (span <= 0) return to.value;

    const progress = easingAt(to.easing, (timeMs - from.timeMs) / span);
    return interpolate(from.value, to.value, progress);
  }

  return last.value;
}

/**
 * Interpolate two keyframe values.
 *
 * Numbers and numeric arrays (the `clip` inset) interpolate. Anything else —
 * a colour string, a format template — steps at the boundary rather than
 * producing a value that is neither. A half-interpolated `#ff0000` is a string
 * that means nothing, and guessing a colour space here would be a second,
 * invisible definition of how colours blend.
 */
export function interpolate(from: unknown, to: unknown, progress: number): unknown {
  if (typeof from === "number" && typeof to === "number") {
    return round(from + (to - from) * progress);
  }

  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) {
    return from.map((value, index) => {
      const other = to[index];
      return typeof value === "number" && typeof other === "number"
        ? round(value + (other - value) * progress)
        : progress < 1
          ? value
          : other;
    });
  }

  return progress < 1 ? from : to;
}

// ------------------------------------------------------------------ styling

/**
 * A sampled target as inline style properties.
 *
 * Longhands (`translate`, `scale`, `rotate`), never the `transform` shorthand.
 * Doc 04 §22.4 is specific about this and the reason is not stylistic: the scene
 * already puts a base layout transform on the element, and a shorthand written
 * here would clobber it. The longhands compose.
 */
export function toStyle(values: Record<string, unknown>): Record<string, string> {
  const style: Record<string, string> = {};

  const x = numberOr(values.x, 0);
  const y = numberOr(values.y, 0);
  if (values.x !== undefined || values.y !== undefined) {
    style.translate = `${x}px ${y}px`;
  }

  if (values.scale !== undefined) {
    style.scale = String(numberOr(values.scale, 1));
  } else if (values.scaleX !== undefined || values.scaleY !== undefined) {
    style.scale = `${numberOr(values.scaleX, 1)} ${numberOr(values.scaleY, 1)}`;
  }

  if (values.rotation !== undefined) {
    style.rotate = `${numberOr(values.rotation, 0)}deg`;
  }

  if (values.opacity !== undefined) {
    style.opacity = String(numberOr(values.opacity, 1));
  }

  if (values.blur !== undefined) {
    const blur = numberOr(values.blur, 0);
    // Omitted rather than written as `blur(0px)`: a filter, even an identity one,
    // creates a containing block and a stacking context, which changes how fixed
    // and absolutely positioned descendants resolve.
    if (blur > 0) style.filter = `blur(${blur}px)`;
  }

  if (Array.isArray(values.clip)) {
    const [top, right, bottom, left] = values.clip as number[];
    style.clipPath = `inset(${top ?? 0}% ${right ?? 0}% ${bottom ?? 0}% ${left ?? 0}%)`;
  }

  if (values.fill !== undefined) style.color = String(values.fill);

  return style;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The state every animated target should be left in once the timeline is over.
 *
 * Present mode needs this when arrowing *backwards* into a slide: doc 04 §26.3
 * says a previous slide is entered at its final state, never by replaying its
 * entrance backwards. Sampling past the end gives exactly that.
 */
export function finalSample(timeline: CompiledTimeline): Sample {
  return sampleAt(timeline, timeline.durationMs + 1, { useRestFrame: true });
}
