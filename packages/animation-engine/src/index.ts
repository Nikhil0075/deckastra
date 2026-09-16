/**
 * Motion for `.mydeck` (doc 04 §22–§28).
 *
 * The shape of the package, and the reason for it:
 *
 * ```
 * document tracks ──┐
 *                   ├─> compileTimeline ──> CompiledTimeline ──> sampleAt(t) ──> styles
 * scene nodes ──────┘        (once)          absolute ms          pure of t
 * ```
 *
 * Everything relative is resolved once, at compile. Everything after that is a
 * pure function of time. That is not tidiness — it is the only way `seek(t)` and
 * `play → pause at t` can be guaranteed to agree, which doc 04 §26.2 makes an
 * acceptance criterion.
 *
 * Nothing here touches the DOM. The adapter that does is `dom.ts`, and it does
 * nothing but write the styles this package computes.
 */

export {
  DEFAULT_EASING,
  EASING_BEZIER,
  SPRING_MAX_MS,
  SPRING_SAMPLE_HZ,
  easingAt,
  easingToCss,
  parseSpring,
  round,
  sampleSpring,
  type Bezier,
  type Spring,
  type SpringSample,
} from "./easing";

export {
  PRESETS,
  PRESET_NAMES,
  durationForBounds,
  resolvePreset,
  type PresetContext,
  type PresetDefinition,
  type PresetExpansion,
} from "./presets";

export {
  DEFAULT_ENTRANCE_BUDGET_MS,
  MAX_SIMULTANEOUS_ELEMENTS,
  REDUCED_DURATION_SCALE,
  REDUCED_MAX_STAGGER_MS,
  compileTimeline,
  resolveMotionLevel,
  type CompileOptions,
  type CompiledClip,
  type CompiledKeyframe,
  type CompiledProperty,
  type CompiledTimeline,
  type MotionLevel,
  type TimelineSegment,
  type TimelineWarning,
} from "./compile";

export {
  finalSample,
  interpolate,
  sampleAt,
  targetKey,
  toStyle,
  type Sample,
  type SampledTarget,
} from "./sample";

export {
  PlaybackEngine,
  browserClock,
  steppedClock,
  type Clock,
  type PlaybackListener,
  type PlaybackState,
  type PlaybackStatus,
} from "./playback";

export {
  DomAnimationAdapter,
  type AnimationAdapter,
  type TimelineEvent,
} from "./dom";

export {
  buildTimelineView,
  clipPatchOperations,
  type TimelineLane,
  type TimelineView,
} from "./timeline";

/**
 * Slide transitions (D4.1). Between two slides rather than within one, so it
 * keeps its own clock — see `transition/types.ts`.
 */
export * from "./transition";
