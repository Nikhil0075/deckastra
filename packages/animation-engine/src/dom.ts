/**
 * The DOM adapter (doc 04 §22.1).
 *
 * Everything above this file is pure: a compiled timeline and a function from
 * time to values. This is the only place that touches an element, and all it does
 * is write the styles the sampler computed. Keeping it that thin is what lets the
 * same timeline drive a headless export, a PDF and a video without any of them
 * re-deriving motion.
 *
 * Two performance rules from doc 04 §31.4 live here because they are properties
 * of the DOM rather than of the timeline:
 *
 * - **`will-change` is applied on play and removed on completion.** Applying it
 *   broadly explodes GPU memory; leaving it on after the animation ends keeps a
 *   layer promoted for the rest of the slide.
 * - **Only longhands are written** (`translate`, `scale`, `rotate`). The scene
 *   already puts a base `transform` on the element; a shorthand written here
 *   would erase it, and the element would jump to the slide origin.
 */

import type { CompiledTimeline } from "./compile";
import { PlaybackEngine, browserClock, type Clock, type PlaybackState } from "./playback";
import { finalSample, sampleAt, toStyle, type Sample } from "./sample";

export interface TimelineEvent {
  type: "start" | "complete" | "segment";
  state: PlaybackState;
}

/** Doc 04 §22.1, with the surface this phase actually needs. */
export interface AnimationAdapter {
  play(): void;
  pause(): void;
  seek(timeMs: number): void;
  stop(): void;
  setPlaybackRate(rate: number): void;
  next(): boolean;
  previous(): boolean;
  enterAtEnd(): void;
  on(event: TimelineEvent["type"], callback: (event: TimelineEvent) => void): () => void;
  dispose(): void;
  readonly state: PlaybackState;
}

/** How the adapter finds the element for a target id. */
export type ElementResolver = (targetId: string, subTarget?: string) => HTMLElement | null;

/**
 * The default resolver: the `data-element-id` boxes the renderer already emits.
 *
 * Reusing them rather than adding an animation-specific attribute means motion
 * targets exactly what selection targets, so an element you can click is an
 * element you can animate.
 */
export function resolverWithin(root: ParentNode): ElementResolver {
  return (targetId, subTarget) => {
    const selector = subTarget
      ? `[data-element-id="${cssEscape(targetId)}"] [data-sub-target="${cssEscape(subTarget)}"]`
      : `[data-element-id="${cssEscape(targetId)}"]`;
    return root.querySelector<HTMLElement>(selector);
  };
}

function cssEscape(value: string): string {
  // Ids are `{prefix}_{ULID}` so this is belt and braces, but a selector built
  // from document data without escaping is an injection waiting for the first id
  // that is not.
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

const ANIMATED_PROPERTIES = [
  "translate",
  "scale",
  "rotate",
  "opacity",
  "filter",
  "clipPath",
  "color",
] as const;

export class DomAnimationAdapter implements AnimationAdapter {
  private readonly engine: PlaybackEngine;
  private readonly callbacks = new Map<TimelineEvent["type"], Set<(event: TimelineEvent) => void>>();
  private readonly touched = new Set<string>();
  private promoted = false;
  private readonly unsubscribe: () => void;

  constructor(
    private timeline: CompiledTimeline,
    private readonly resolve: ElementResolver,
    clock: Clock = browserClock(),
  ) {
    this.engine = new PlaybackEngine(timeline, clock);
    this.unsubscribe = this.engine.subscribe({
      onSample: (sample) => this.apply(sample),
      onSegmentEnd: (state) => this.fire("segment", state),
      onComplete: (state) => {
        this.demote();
        this.fire("complete", state);
      },
    });

    // The pre-roll state. Without it every animated element is visible at its
    // resting position for one frame before the first sample lands, which reads
    // as a flash of the finished slide.
    this.apply(sampleAt(timeline, 0));
  }

  get state(): PlaybackState {
    return this.engine.state;
  }

  replace(timeline: CompiledTimeline): void {
    this.timeline = timeline;
    this.engine.replace(timeline);
  }

  play(): void {
    this.promote();
    this.engine.play();
    this.fire("start", this.engine.state);
  }

  pause(): void {
    this.engine.pause();
  }

  seek(timeMs: number): void {
    this.engine.seek(timeMs);
  }

  stop(): void {
    this.engine.stop();
    this.demote();
    this.clear();
  }

  setPlaybackRate(rate: number): void {
    this.engine.setPlaybackRate(rate);
  }

  next(): boolean {
    this.promote();
    return this.engine.next();
  }

  previous(): boolean {
    return this.engine.previous();
  }

  enterAtEnd(): void {
    this.engine.enterAtEnd();
  }

  on(event: TimelineEvent["type"], callback: (event: TimelineEvent) => void): () => void {
    const set = this.callbacks.get(event) ?? new Set();
    set.add(callback);
    this.callbacks.set(event, set);
    return () => set.delete(callback);
  }

  dispose(): void {
    this.unsubscribe();
    this.engine.dispose();
    this.demote();
    this.clear();
    this.callbacks.clear();
  }

  // ----------------------------------------------------------------- private

  private apply(sample: Sample): void {
    const seen = new Set<string>();

    for (const [key, target] of sample) {
      const element = this.resolve(target.targetId, target.subTarget);
      if (!element) continue;

      seen.add(key);
      this.touched.add(key);

      const style = toStyle(target.values);
      for (const property of ANIMATED_PROPERTIES) {
        const value = style[property];
        if (value === undefined) {
          element.style.removeProperty(cssName(property));
        } else {
          element.style.setProperty(cssName(property), value);
        }
      }

      // `numberValue` is the one property that is content rather than style, so
      // it cannot go through the style map.
      if (typeof target.values.numberValue === "number") {
        const slot = element.querySelector<HTMLElement>("[data-number-slot]") ?? element;
        slot.textContent = formatNumber(target.values.numberValue);
      }

      if (typeof target.values.pathProgress === "number") {
        applyPathProgress(element, target.values.pathProgress);
      }
    }

    // Anything that was animating and is not any more goes back to its resting
    // state. Leaving a stale inline style behind means an element that scrubbed
    // past its clip keeps the last value it was given forever.
    for (const key of this.touched) {
      if (seen.has(key)) continue;
      const [targetId, subTarget] = key.split("|");
      const element = this.resolve(targetId!, subTarget);
      if (!element) continue;
      for (const property of ANIMATED_PROPERTIES) {
        element.style.removeProperty(cssName(property));
      }
    }
  }

  private promote(): void {
    if (this.promoted) return;
    this.promoted = true;
    for (const targetId of this.timeline.animatedTargets) {
      const element = this.resolve(targetId);
      if (element) element.style.willChange = "transform, opacity";
    }
  }

  private demote(): void {
    if (!this.promoted) return;
    this.promoted = false;
    for (const targetId of this.timeline.animatedTargets) {
      const element = this.resolve(targetId);
      if (element) element.style.removeProperty("will-change");
    }
  }

  private clear(): void {
    for (const key of this.touched) {
      const [targetId, subTarget] = key.split("|");
      const element = this.resolve(targetId!, subTarget);
      if (!element) continue;
      for (const property of ANIMATED_PROPERTIES) {
        element.style.removeProperty(cssName(property));
      }
    }
    this.touched.clear();
  }

  private fire(type: TimelineEvent["type"], state: PlaybackState): void {
    for (const callback of this.callbacks.get(type) ?? []) callback({ type, state });
  }
}

function cssName(property: string): string {
  return property === "clipPath" ? "clip-path" : property;
}

/**
 * `numberCount`'s display value.
 *
 * Hand-formatted, not `Intl`: doc 04's determinism rule applies here too. A
 * number that formats differently depending on the runtime's ICU build makes an
 * exported video differ from the preview by a thousands separator.
 */
function formatNumber(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rounded < 0 ? `-${grouped}` : grouped;
}

/** `drawPath` via stroke-dashoffset (doc 04 §22.4). */
function applyPathProgress(element: HTMLElement, progress: number): void {
  const paths = element.querySelectorAll<SVGPathElement | SVGLineElement>("path, line, polyline");
  for (const path of paths) {
    const length = typeof path.getTotalLength === "function" ? path.getTotalLength() : 0;
    if (length === 0) continue;
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = String(length * (1 - progress));
  }
}
