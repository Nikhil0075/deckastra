import { z } from "zod";
import { IdSchema, prefixedId } from "./ids.js";
import {
  EasingSchema,
  MillisecondsSchema,
  NormalizedSchema,
  openEnum,
} from "./primitives.js";

/**
 * Animation (doc 02 §24–§26).
 *
 * Motion is a first-class part of the document, not a rendering afterthought.
 * The agent defines intent; the animation engine generates the deterministic
 * implementation.
 */

export const AnimatablePropertySchema = z.enum([
  "opacity",
  "x",
  "y",
  "scale",
  "scaleX",
  "scaleY",
  "rotation",
  "blur",
  "clip",
  "pathProgress",
  "numberValue",
  "fill",
  "stroke",
  "width",
  "height",
  "custom",
]);
export type AnimatableProperty = z.infer<typeof AnimatablePropertySchema>;

export const KeyframeSchema = z.object({
  /**
   * 0..1 relative to the clip's durationMs, not milliseconds (doc 02 §24.5).
   *
   * Normalizing means changing a clip's duration rescales its keyframes
   * automatically — dragging a clip edge in the timeline is one property change,
   * not N. Keyframes must be sorted ascending; a track that does not span the full
   * range holds its first and last values at the ends.
   */
  offset: NormalizedSchema,
  value: z.unknown(),
  /** Easing INTO this keyframe. */
  easing: EasingSchema.optional(),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const PropertyTrackSchema = z.object({
  property: AnimatablePropertySchema,
  keyframes: z.array(KeyframeSchema).min(1),
});
export type PropertyTrack = z.infer<typeof PropertyTrackSchema>;

export const AnimationClipSchema = z.looseObject({
  id: prefixedId("clp"),
  /**
   * A preset name is a pure function from parameters to property tracks, expanded
   * at build time (doc 04 §22.2). Two consequences: a preset can be *opened* in
   * the timeline into explicit propertyTracks (an ordinary patch), and a clip
   * carrying both uses the property tracks while retaining the preset name as
   * provenance — so the UI can still say "this started as blurReveal".
   */
  preset: z.string().optional(),
  presetParams: z.record(z.string(), z.unknown()).optional(),
  propertyTracks: z.array(PropertyTrackSchema).optional(),
  /**
   * An offset from the trigger's resolved time, NOT an absolute time on the slide
   * timeline (doc 02 §24.4):
   *
   *   resolvedStart = triggerTime(track.trigger) + clip.startMs + (clip.delayMs ?? 0)
   */
  startMs: MillisecondsSchema,
  durationMs: MillisecondsSchema,
  delayMs: MillisecondsSchema.optional(),
  easing: EasingSchema.optional(),
  /** Default 0. -1 is infinite. */
  repeat: z.number().int().min(-1).optional(),
  direction: z.enum(["normal", "reverse", "alternate"]).optional(),
  /** Default "forwards". */
  fill: z.enum(["none", "forwards", "backwards", "both"]).optional(),
  /**
   * Reduced motion (doc 02 §24.7). Every preset declares a fallback; the document
   * may override per clip. Reduced motion must never mean content fails to appear
   * — "skip" still applies the clip's end state.
   */
  reducedMotionPreset: z.string().optional(),
  reducedMotionBehavior: z.enum(["fallback", "skip", "instant"]).optional(),
});
export type AnimationClip = z.infer<typeof AnimationClipSchema>;

/**
 * Triggers (doc 02 §25).
 *
 * `click` triggers split a slide timeline into segments: playback runs to the next
 * boundary and waits. That is how click-to-reveal works and what present-mode
 * arrow keys navigate before advancing the slide.
 */
export const AnimationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slideEnter") }),
  z.object({ type: z.literal("afterPrevious") }),
  z.object({ type: z.literal("withPrevious") }),
  z.object({ type: z.literal("click"), targetId: IdSchema.optional() }),
  z.object({ type: z.literal("hover"), targetId: IdSchema }),
  z.object({ type: z.literal("timer"), delayMs: MillisecondsSchema }),
  z.object({ type: z.literal("marker"), markerId: z.string() }),
]);
export type AnimationTrigger = z.infer<typeof AnimationTriggerSchema>;

/** MVP trigger set. `click` is the first addition after these. */
export const MVP_TRIGGERS = ["slideEnter", "afterPrevious", "withPrevious"] as const;

export const AnimationTrackSchema = z.looseObject({
  id: prefixedId("anm"),
  targetId: IdSchema,
  /**
   * Addresses a semantic part of a composite element without knowing its geometry
   * (doc 02 §24.3):
   *
   *   "node/orchestrator"           DiagramElement
   *   "edge/orchestrator->layout"
   *   "rank/2"
   *   "series/0"                    ChartElement
   *   "row/4"                       TableElement
   *   "line/12-18"                  CodeElement
   *   "child/el_01JB8Z..."          GroupElement
   *
   * This is what lets the Motion Agent express "draw the data-flow edges after the
   * agent cluster appears" as intent rather than coordinates. An unresolvable
   * subTarget is warning W130 — the clip is skipped, never fatal.
   */
  subTarget: z.string().optional(),
  trigger: AnimationTriggerSchema,
  clips: z.array(AnimationClipSchema),
  label: z.string().optional(),
  disabled: z.boolean().optional(),
});
export type AnimationTrack = z.infer<typeof AnimationTrackSchema>;

export const TimelineMarkerSchema = z.object({
  id: z.string(),
  timeMs: MillisecondsSchema,
  label: z.string(),
});
export type TimelineMarker = z.infer<typeof TimelineMarkerSchema>;

export const SharedElementMappingSchema = z.object({
  sourceElementId: IdSchema,
  destinationElementId: IdSchema,
  matchMode: z.enum(["position", "positionAndScale", "full"]).optional(),
});
export type SharedElementMapping = z.infer<typeof SharedElementMappingSchema>;

/** Known transition types. Open, so a v1 reader keeps a v2 transition it cannot draw. */
export const SLIDE_TRANSITION_TYPES = openEnum([
  "cut",
  "fade",
  "slide",
  "zoom",
  "morph",
  "mask",
  "push",
  "custom",
]);

/**
 * Slide transitions (doc 02 §26).
 *
 * A slide's transition describes how the deck moves *into* that slide. That
 * ownership matters for reordering: moving a slide carries its entrance
 * transition with it, which is what authors expect.
 */
export const SlideTransitionSchema = z.looseObject({
  type: SLIDE_TRANSITION_TYPES,
  durationMs: MillisecondsSchema,
  easing: EasingSchema.optional(),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
  /**
   * Explicit pairing wins. Absent it the renderer auto-pairs with a scored
   * heuristic and labels the auto-pairs in the UI so the author can confirm or
   * break them. Two unrelated objects are never silently morphed.
   */
  sharedElements: z.array(SharedElementMappingSchema).optional(),
  /** Kiosk mode. */
  autoAdvanceMs: MillisecondsSchema.optional(),
});
export type SlideTransition = z.infer<typeof SlideTransitionSchema>;

/**
 * Interactions (doc 02 §27).
 *
 * Precedence against animation triggers, which v1.0 left undefined:
 *
 *   1. A pending animation segment on the slide? A click advances the segment.
 *   2. All segments complete? A click on an element with a matching Interaction
 *      fires that interaction.
 *   3. Otherwise a click advances the slide.
 *
 * Click-to-reveal is far more common than click-to-navigate, and a user clicking
 * to reveal the next bullet must never jump to another slide by accident. Hover
 * interactions are exempt from this ordering and always fire.
 */
export const InteractionSchema = z.looseObject({
  id: IdSchema,
  trigger: z.discriminatedUnion("type", [
    z.object({ type: z.literal("click"), targetId: IdSchema }),
    z.object({ type: z.literal("hover"), targetId: IdSchema }),
    z.object({ type: z.literal("key"), key: z.string() }),
  ]),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("goToSlide"), slideId: IdSchema }),
    z.object({ type: z.literal("nextSlide") }),
    z.object({ type: z.literal("previousSlide") }),
    z.object({
      type: z.literal("openUrl"),
      url: z.string(),
      newTab: z.boolean().optional(),
    }),
    z.object({ type: z.literal("toggleVisibility"), targetId: IdSchema }),
    z.object({ type: z.literal("runAnimation"), trackId: IdSchema }),
    z.object({ type: z.literal("seekTimeline"), markerId: z.string() }),
  ]),
  /**
   * Default false: interactions are inert in the editor, so clicking a link while
   * editing selects the element rather than navigating away.
   */
  enabledInEditor: z.boolean().optional(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

/**
 * Conflict rule (doc 02 §24.6): two clips animating the same property of the same
 * target over overlapping intervals is a conflict, and the later-defined clip wins
 * for the overlapping interval. Values are never blended — blended results are
 * unpredictable and cannot be reproduced by PPTX export or a video renderer.
 */
export const ANIMATION_CONFLICT_RESOLUTION = "lastDefinedWins" as const;

/** Resolve a trigger to its start time on the slide timeline (doc 02 §24.4). */
export interface TriggerContext {
  previousTrackStartMs: number;
  previousTrackEndMs: number;
  cursorMs: number;
}

export function triggerTime(
  trigger: AnimationTrigger,
  ctx: TriggerContext,
): number | "runtime" {
  switch (trigger.type) {
    case "slideEnter":
      return 0;
    case "afterPrevious":
      return ctx.previousTrackEndMs;
    case "withPrevious":
      return ctx.previousTrackStartMs;
    case "timer":
      return ctx.cursorMs + trigger.delayMs;
    // Resolved at playback against a segment boundary, not at build time.
    case "click":
    case "hover":
    case "marker":
      return "runtime";
  }
}

/** resolvedStart = triggerTime + startMs + delayMs (doc 02 §24.4). */
export function resolvedClipStart(clip: AnimationClip, triggerTimeMs: number): number {
  return triggerTimeMs + clip.startMs + (clip.delayMs ?? 0);
}
