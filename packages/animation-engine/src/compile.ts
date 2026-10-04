/**
 * Timeline compilation (doc 04 §25).
 *
 * The document stores *relative* intent — "after the previous one", "with the
 * previous one", "when the presenter clicks". The compiler resolves that to
 * absolute milliseconds once, up front, and everything downstream reads absolute
 * numbers. That is the whole reason `seek(t)` can be stateless: there is nothing
 * left to resolve at playback time.
 *
 * Four things happen here and nowhere else.
 *
 * **Triggers become times** (§25.1). A cursor walks the tracks in document order;
 * `withPrevious` reuses the previous start, `afterPrevious` takes the cursor,
 * `timer` offsets it, `slideEnter` resets to zero.
 *
 * **Clicks become segment boundaries.** A click-triggered track starts a new
 * segment; playback runs to the boundary and waits. That is how "reveal the next
 * bullet" works, and it is why present mode's arrow keys have something to
 * navigate before advancing the slide.
 *
 * **Reduced motion is applied here** (§27.2), not by a media query on one
 * keyframe. Resolution order is the viewer's explicit setting, then the OS. The
 * document's `reducedMotionFallback` says what to show *after* reduced motion is
 * requested; it is not itself a request to reduce everybody's motion.
 *
 * **Conflicts are detected, not blended** (§25.3). Two clips animating the same
 * property of the same target over overlapping intervals is a warning and a
 * later-wins rule. Blending produces a result nobody predicted and no exporter
 * can reproduce.
 */

import type {
  AnimationClip,
  AnimationTrack,
  Keyframe,
  PropertyTrack,
  TimelineMarker,
} from "@deckastra/presentation-schema";
import type { SlideScene, SceneNode } from "@deckastra/renderer";

import { DEFAULT_EASING, easingAt, parseSpring, round, sampleSpring } from "./easing";
import { durationForBounds, resolvePreset, type PresetContext } from "./presets";

export type MotionLevel = "full" | "reduced" | "none";

/** Doc 04 §27.2: reduced motion is 0.6× duration and a 60ms stagger ceiling. */
export const REDUCED_DURATION_SCALE = 0.6;
export const REDUCED_MAX_STAGGER_MS = 60;
/** Long enough to preserve before/after fill semantics, imperceptible as motion. */
export const INSTANT_FALLBACK_MS = 1;

/** Doc 04 §24.2. Overridable per theme via `motion.maxSlideDurationMs`. */
export const DEFAULT_ENTRANCE_BUDGET_MS = 2_500;

/** Doc 04 §31.4: past this the compositor is being asked to promote too much. */
export const MAX_SIMULTANEOUS_ELEMENTS = 60;

export interface CompiledKeyframe {
  /** Absolute milliseconds on the slide timeline, not a 0..1 offset. */
  timeMs: number;
  value: unknown;
  /** Easing *into* this keyframe. */
  easing: string;
}

export interface CompiledProperty {
  property: PropertyTrack["property"];
  keyframes: CompiledKeyframe[];
}

export interface CompiledClip {
  id: string;
  trackId: string;
  targetId: string;
  subTarget?: string;
  startMs: number;
  endMs: number;
  /** End used for navigation: every iteration when finite, one period when infinite. */
  settledEndMs: number;
  periodMs: number;
  /** Total iterations, or `Infinity` for `repeat: -1`. */
  iterations: number;
  direction: "normal" | "reverse" | "alternate";
  restOffset: number;
  /** The preset it came from, kept as provenance for the timeline UI. */
  preset?: string;
  /**
   * Whether the clip's values hold outside its own span.
   *
   * Defaults to `"both"`, which is a deliberate divergence from the CSS/WAAPI
   * default of `"forwards"` that doc 02 §24 inherited. The reason is that an
   * entrance is only an entrance if the element is in its starting state
   * *before* the clip runs: a bullet that is visible until its click-triggered
   * fade-in begins has not been revealed, it has flashed. Backwards fill is what
   * every presentation tool does and what §25.1's click-to-reveal requires.
   *
   * A clip can still opt out by declaring `fill` explicitly.
   */
  fill: "none" | "forwards" | "backwards" | "both";
  properties: CompiledProperty[];
  /** Index into `segments`. */
  segment: number;
}

export interface TimelineSegment {
  index: number;
  startMs: number;
  endMs: number;
  /** What advances into this segment. The first segment starts on slide entry. */
  advanceOn: "slideEnter" | "click";
  label?: string;
}

export interface TimelineWarning {
  code: string;
  message: string;
  targetId?: string;
  clipId?: string;
}

export interface CompiledTimeline {
  slideId: string;
  motionLevel: MotionLevel;
  /** Total length including every segment's wait time collapsed out. */
  durationMs: number;
  /** End of finite content. Infinite ambient clips do not extend it. */
  settledDurationMs: number;
  hasInfiniteMotion: boolean;
  clips: CompiledClip[];
  segments: TimelineSegment[];
  markers: TimelineMarker[];
  warnings: TimelineWarning[];
  budget: { limitMs: number; entranceMs: number; exceeded: boolean };
  /** Every (targetId, property) the timeline touches — what to promote and demote. */
  animatedTargets: string[];
}

export interface CompileOptions {
  /** The viewer's explicit choice, if they made one. Wins over everything. */
  userMotionPreference?: MotionLevel;
  /** `prefers-reduced-motion` from the OS. */
  systemPrefersReducedMotion?: boolean;
  /** Overrides the theme's budget; mostly for tests. */
  entranceBudgetMs?: number;
}

// -------------------------------------------------------------- motion level

/**
 * Doc 04 §27.1: user explicit > OS > full.
 *
 * `documentPreference` remains in the signature for compatibility with callers
 * that already pass the theme token. It deliberately does not choose the motion
 * level: `fade` and `none` describe fallback rendering, not a viewer preference.
 */
export function resolveMotionLevel(
  _documentPreference: string | undefined,
  options: CompileOptions,
): MotionLevel {
  if (options.userMotionPreference) return options.userMotionPreference;
  if (options.systemPrefersReducedMotion) return "reduced";
  return "full";
}

// ------------------------------------------------------------------ compile

interface ResolvedMotionTheme {
  defaultDurationMs: number;
  defaultEasing: string;
  staggerMs: number;
  budgetMs: number;
  reducedMotionFallback?: string;
}

/**
 * The motion theme, read the way the compiler reads it.
 *
 * Exported because the motion panel needs the same answer when it opens a preset
 * into keyframes: expanding one with different defaults than the compiler used
 * would produce keyframes that do not match what the author was just watching.
 */
export function motionThemeOf(scene: SlideScene): ResolvedMotionTheme {
  // Scenes carry resolved tokens, not a raw ThemeDefinition. Reading a raw
  // `motion` field silently discards document preferences and inherited values.
  const motion = Object.fromEntries(
    ["defaultDurationMs", "defaultEasing", "staggerMs", "maxSlideDurationMs", "reducedMotionFallback"]
      .map(key => [key, scene.theme.tokens.get(`motion.${key}`)]),
  );
  return {
    defaultDurationMs: typeof motion.defaultDurationMs === "number" ? motion.defaultDurationMs : 400,
    defaultEasing: typeof motion.defaultEasing === "string" ? motion.defaultEasing : DEFAULT_EASING,
    staggerMs: typeof motion.staggerMs === "number" ? motion.staggerMs : 70,
    budgetMs:
      typeof motion.maxSlideDurationMs === "number"
        ? motion.maxSlideDurationMs
        : DEFAULT_ENTRANCE_BUDGET_MS,
    reducedMotionFallback:
      typeof motion.reducedMotionFallback === "string" ? motion.reducedMotionFallback : undefined,
  };
}

function indexNodes(nodes: SceneNode[]): Map<string, SceneNode> {
  const byId = new Map<string, SceneNode>();
  const walk = (list: SceneNode[]): void => {
    for (const node of list) {
      byId.set(node.id, node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return byId;
}

export function compileTimeline(
  scene: SlideScene,
  tracks: AnimationTrack[],
  options: CompileOptions = {},
): CompiledTimeline {
  const motion = motionThemeOf(scene);
  const level = resolveMotionLevel(motion.reducedMotionFallback, options);
  const nodes = indexNodes(scene.nodes);
  const warnings: TimelineWarning[] = [];
  const clips: CompiledClip[] = [];

  const segments: TimelineSegment[] = [
    { index: 0, startMs: 0, endMs: 0, advanceOn: "slideEnter" },
  ];

  let cursor = 0;
  let previousStart = 0;
  let segmentIndex = 0;

  for (const track of tracks) {
    if (track.disabled) continue;

    const node = nodes.get(track.targetId);
    if (!node) {
      // A track pointing at a deleted element. Warning, never fatal: the rest of
      // the slide should still animate, and the author needs to be told which
      // one is orphaned rather than watching the whole timeline refuse to run.
      warnings.push({
        code: "W130",
        message: `Animation targets ${track.targetId}, which is not on this slide. The clip was skipped.`,
        targetId: track.targetId,
      });
      continue;
    }

    // Segment boundary before the times are resolved, so a clicked track starts
    // its own segment at zero rather than after whatever preceded it.
    if (track.trigger.type === "click") {
      segmentIndex += 1;
      segments.push({
        index: segmentIndex,
        startMs: cursor,
        endMs: cursor,
        advanceOn: "click",
        label: track.label,
      });
      previousStart = cursor;
    }

    const triggerStart = resolveTriggerStart(track, cursor, previousStart);
    previousStart = triggerStart;

    for (const clip of track.clips) {
      const compiled = compileClip({
        clip,
        track,
        node,
        nodes,
        motion,
        level,
        triggerStart,
        segment: segmentIndex,
        warnings,
      });

      for (const one of compiled) {
        clips.push(one);
        cursor = Math.max(cursor, one.settledEndMs);
        const segment = segments[one.segment];
        if (segment) segment.endMs = Math.max(segment.endMs, one.settledEndMs);
      }
    }
  }

  detectConflicts(clips, warnings);

  const settledDurationMs = clips.reduce((longest, clip) => Math.max(longest, clip.settledEndMs), 0);
  const hasInfiniteMotion = clips.some((clip) => clip.iterations === Infinity);
  const budgetMs = options.entranceBudgetMs ?? motion.budgetMs;
  // Ambient loops never make an entrance longer: they use a separate clock and
  // can still be running after the finite entrance has settled.
  const entranceMs = clips
    .filter((clip) => clip.segment === 0 && clip.iterations !== Infinity)
    .reduce((longest, clip) => Math.max(longest, clip.settledEndMs), 0);

  if (entranceMs > budgetMs) {
    warnings.push({
      code: "W131",
      message:
        `This slide's entrance runs for ${Math.round(entranceMs)}ms, past the ` +
        `${budgetMs}ms budget. Past roughly that point the presenter is talking ` +
        "over an animation that is still running.",
    });
  }

  const animatedTargets = [...new Set(clips.map((clip) => clip.targetId))];
  if (animatedTargets.length > MAX_SIMULTANEOUS_ELEMENTS) {
    warnings.push({
      code: "W132",
      message:
        `${animatedTargets.length} elements animate on this slide. Past ` +
        `${MAX_SIMULTANEOUS_ELEMENTS} the browser is being asked to promote more ` +
        "layers than it can hold; consider a staggered group.",
    });
  }

  const loops = clips.filter((clip) => clip.iterations === Infinity);
  if (loops.length > 2) {
    warnings.push({
      code: "W140",
      message: `${loops.length} ambient loops run on this slide; keep at most two so the motion retains a clear focus.`,
    });
  }
  for (const loop of loops) {
    const costly = loop.properties.find((property) => !["x", "y", "scale", "scaleX", "scaleY", "rotation", "opacity"].includes(property.property));
    if (costly) {
      warnings.push({
        code: "W141",
        message: `The loop on ${loop.targetId} animates ${costly.property}; continuous motion is restricted to transforms and opacity.`,
        targetId: loop.targetId,
        clipId: loop.id,
      });
    }
  }
  const automaticTrackIds = new Set(
    tracks
      .filter((track) => ["slideEnter", "afterPrevious", "withPrevious", "timer"].includes(track.trigger.type))
      .map((track) => track.id),
  );
  const longAutomatic = clips.some((clip) =>
    automaticTrackIds.has(clip.trackId) && (clip.iterations === Infinity || clip.endMs - clip.startMs > 5_000),
  );
  if (longAutomatic) {
    warnings.push({
      code: "W142",
      message: "Automatic motion continues beyond five seconds. Present mode provides Pause loops (L).",
    });
  }

  return {
    slideId: scene.slideId,
    motionLevel: level,
    durationMs: round(settledDurationMs),
    settledDurationMs: round(settledDurationMs),
    hasInfiniteMotion,
    clips,
    segments,
    markers: [],
    warnings,
    budget: { limitMs: budgetMs, entranceMs: round(entranceMs), exceeded: entranceMs > budgetMs },
    animatedTargets,
  };
}

function resolveTriggerStart(
  track: AnimationTrack,
  cursor: number,
  previousStart: number,
): number {
  switch (track.trigger.type) {
    case "withPrevious":
      return previousStart;
    case "afterPrevious":
      return cursor;
    case "timer":
      return cursor + track.trigger.delayMs;
    case "click":
      // The segment already reset the reference point; a clicked track starts
      // immediately once the click arrives.
      return cursor;
    case "slideEnter":
      return 0;
    default:
      // `hover` and `marker` are not MVP triggers. Treating them as slideEnter
      // would make them fire unbidden, which is worse than not firing.
      return cursor;
  }
}

// -------------------------------------------------------------------- clips

interface ClipContext {
  clip: AnimationClip;
  track: AnimationTrack;
  node: SceneNode;
  nodes: Map<string, SceneNode>;
  motion: ResolvedMotionTheme;
  level: MotionLevel;
  triggerStart: number;
  segment: number;
  warnings: TimelineWarning[];
}

function compileClip(context: ClipContext): CompiledClip[] {
  const { clip, track, node, motion, level, triggerStart, segment, warnings } = context;

  // Doc 02 §24.4: the clip's own start and delay are offsets from the trigger's
  // resolved time, not absolute positions on the slide timeline.
  const start = triggerStart + clip.startMs + (clip.delayMs ?? 0);
  const authored = clip.durationMs || motion.defaultDurationMs || durationForBounds(node.bounds);
  const durationMs = level === "none" ? 0 : scaleDuration(authored, level);
  const authoredIterations = clip.repeat === -1 ? Infinity : Math.max(1, (clip.repeat ?? 0) + 1);
  const direction = clip.direction ?? "normal";
  const restOffset = clip.restOffset ?? 0;

  // A repeating clip is ambient motion. Reduced/no motion freezes it at the
  // author-selected rest frame rather than substituting another moving preset.
  if (authoredIterations !== 1 && level !== "full") {
    const expansion = expandClip({ ...context, level: "full" }, 1);
    const frozen = (
      id: string,
      targetId: string,
      properties: PropertyTrack[],
      subTarget?: string,
    ): CompiledClip => ({
      id,
      trackId: track.id,
      targetId,
      subTarget,
      startMs: round(start),
      endMs: round(start),
      settledEndMs: round(start),
      periodMs: 0,
      iterations: 1,
      direction,
      restOffset,
      preset: clip.preset,
      fill: clip.fill ?? "both",
      properties: stateAtOffset(properties, restOffset, start, clip.easing ?? motion.defaultEasing),
      segment,
    });
    const results = expansion.tracks.length
      ? [frozen(clip.id, track.targetId, expansion.tracks, track.subTarget)]
      : [];
    for (const child of expansion.children) {
      results.push(frozen(`${clip.id}:${child.subTarget ?? child.targetId}`, child.targetId, child.tracks, child.subTarget));
    }
    return results;
  }

  const requested = reducedMotionName(clip, level);
  const category = clip.preset ? resolvePreset(clip.preset).preset.category : "entrance";
  if (level === "reduced" && requested === "skip") return [];
  if ((level === "none" || (level === "reduced" && requested === "instant")) && category !== "exit") {
    // Entrance/emphasis/path content is already rendered at its stable state.
    // Dropping the moving clip leaves that state visible and keeps click segment
    // boundaries intact without adding even a nominal duration.
    return [];
  }
  if (level === "none" || (level === "reduced" && requested === "instant")) {
    // Preserve both ends over a single millisecond. An empty/zero-length clip
    // cannot express an exit: backwards fill would either hide it before the
    // click or forwards fill would leave it visible afterwards.
    const expansion = expandClip({ ...context, level: "full" }, INSTANT_FALLBACK_MS);
    const instant = (
      id: string,
      targetId: string,
      properties: PropertyTrack[],
      subTarget?: string,
    ): CompiledClip => ({
      id,
      trackId: track.id,
      targetId,
      subTarget,
      startMs: round(start),
      endMs: round(start + INSTANT_FALLBACK_MS),
      settledEndMs: round(start + INSTANT_FALLBACK_MS),
      periodMs: INSTANT_FALLBACK_MS,
      iterations: 1,
      direction: "normal",
      restOffset,
      preset: clip.preset,
      fill: clip.fill ?? "both",
      properties: absolutise(properties, start, INSTANT_FALLBACK_MS, "linear"),
      segment,
    });
    const results = expansion.tracks.length
      ? [instant(clip.id, track.targetId, expansion.tracks, track.subTarget)]
      : [];
    for (const child of expansion.children) {
      results.push(instant(`${clip.id}:${child.subTarget ?? child.targetId}`, child.targetId, child.tracks, child.subTarget));
    }
    return results;
  }

  const expansion = expandClip(context, durationMs);
  for (const warning of expansion.warnings) warnings.push(warning);

  const finiteEnd = round(start + durationMs * (authoredIterations === Infinity ? 1 : authoredIterations));
  const own: CompiledClip = {
    id: clip.id,
    trackId: track.id,
    targetId: track.targetId,
    subTarget: track.subTarget,
    startMs: round(start),
    endMs: authoredIterations === Infinity ? Infinity : finiteEnd,
    // Finite repeats keep their segment alive through the last iteration.
    // Indefinite motion is ambient and contributes no finite wait time.
    settledEndMs: authoredIterations === Infinity ? round(start) : finiteEnd,
    periodMs: round(durationMs),
    iterations: authoredIterations,
    direction,
    restOffset,
    preset: clip.preset,
    fill: clip.fill ?? "both",
    properties: absolutise(expansion.tracks, start, durationMs, clip.easing ?? motion.defaultEasing),
    segment,
  };

  const results = own.properties.length > 0 ? [own] : [];

  for (const child of expansion.children) {
    const delay = level === "reduced" ? Math.min(child.delayMs, REDUCED_MAX_STAGGER_MS) : child.delayMs;
    const childStart = start + delay;
    const childFiniteEnd = round(childStart + durationMs * (authoredIterations === Infinity ? 1 : authoredIterations));
    results.push({
      id: `${clip.id}:${child.subTarget ?? child.targetId}`,
      trackId: track.id,
      targetId: child.targetId,
      startMs: round(childStart),
      endMs: authoredIterations === Infinity ? Infinity : childFiniteEnd,
      settledEndMs: authoredIterations === Infinity ? round(childStart) : childFiniteEnd,
      periodMs: round(durationMs),
      iterations: authoredIterations,
      direction,
      restOffset,
      preset: clip.preset,
      fill: clip.fill ?? "both",
      subTarget: child.subTarget,
      properties: absolutise(
        child.tracks,
        childStart,
        durationMs,
        clip.easing ?? motion.defaultEasing,
      ),
      segment,
    });
  }

  return results;
}

/** Collapse a preset/property-track expansion to one deterministic rest frame. */
function stateAtOffset(tracks: PropertyTrack[], offset: number, atMs: number, defaultEasing: string): CompiledProperty[] {
  const clamped = Math.max(0, Math.min(1, offset));
  return tracks.map((property) => {
    const frames = property.keyframes;
    let value: unknown = frames[frames.length - 1]?.value ?? 1;
    for (let index = 1; index < frames.length; index += 1) {
      const to = frames[index]!;
      if (clamped > to.offset) continue;
      const from = frames[index - 1]!;
      const span = to.offset - from.offset;
      if (span <= 0) value = to.value;
      else if (typeof from.value === "number" && typeof to.value === "number") {
        const progress = easingAt(to.easing ?? defaultEasing, (clamped - from.offset) / span);
        value = round(from.value + (to.value - from.value) * progress);
      } else value = clamped < to.offset ? from.value : to.value;
      break;
    }
    return { property: property.property, keyframes: [{ timeMs: atMs, value, easing: "linear" }] };
  });
}

function scaleDuration(durationMs: number, level: MotionLevel): number {
  return level === "reduced" ? round(durationMs * REDUCED_DURATION_SCALE) : durationMs;
}

interface Expansion {
  tracks: PropertyTrack[];
  children: { targetId: string; subTarget?: string; delayMs: number; tracks: PropertyTrack[] }[];
  warnings: TimelineWarning[];
}

function expandClip(context: ClipContext, durationMs: number): Expansion {
  const { clip, track, node, nodes, motion, level, warnings: _ } = context;
  const warnings: TimelineWarning[] = [];

  // Explicit property tracks win over the preset name. A clip carrying both was
  // "opened" in the timeline and then hand-edited; the preset name survives only
  // as provenance, so the UI can still say what it started as (doc 02 §24).
  if (clip.propertyTracks && clip.propertyTracks.length > 0) {
    return { tracks: clip.propertyTracks, children: [], warnings };
  }

  if (!clip.preset) {
    warnings.push({
      code: "W133",
      message: "A clip has neither a preset nor property tracks, so it does nothing.",
      targetId: track.targetId,
      clipId: clip.id,
    });
    return { tracks: [], children: [], warnings };
  }

  const requested = reducedMotionName(clip, level);
  if (requested === "instant") {
    return { tracks: [], children: [], warnings };
  }

  const { preset, degraded } = resolvePreset(requested);
  if (degraded) {
    warnings.push({ code: "W134", message: degraded, targetId: track.targetId, clipId: clip.id });
  }

  const presetContext: PresetContext = {
    bounds: node.bounds,
    motion: {
      defaultDurationMs: motion.defaultDurationMs,
      defaultEasing: motion.defaultEasing,
      staggerMs: level === "reduced" ? Math.min(motion.staggerMs, REDUCED_MAX_STAGGER_MS) : motion.staggerMs,
    },
    params: clip.presetParams ?? {},
    durationMs,
    children: childrenOf(node, nodes),
  };

  const expansion = preset.expand(presetContext);
  if (expansion.warning) {
    warnings.push({
      code: "W135",
      message: expansion.warning,
      targetId: track.targetId,
      clipId: clip.id,
    });
  }

  if (["byWord", "byLetter", "typewriter"].includes(preset.name)) {
    const count = Math.max(0, Math.min(160, Math.floor(Number(clip.presetParams?.segmentCount) || 0)));
    if (count > 0) {
      const word = preset.name === "byWord";
      return {
        tracks: [],
        children: Array.from({ length: count }, (_, index) => ({
          targetId: track.targetId,
          subTarget: `${word ? "word" : "glyph"}/${index}`,
          delayMs: index * (word ? 55 : 24),
          tracks: expansion.tracks,
        })),
        warnings,
      };
    }
  }

  return { tracks: expansion.tracks, children: expansion.children ?? [], warnings };
}

/**
 * The preset to actually expand at this motion level.
 *
 * The document may override per clip (`reducedMotionPreset` / `reducedMotionBehavior`),
 * which is why this is not simply `PRESETS[name].reducedMotion`.
 */
function reducedMotionName(clip: AnimationClip, level: MotionLevel): string {
  const preset = clip.preset ?? "fade";
  if (level !== "reduced") return preset;

  if (clip.reducedMotionBehavior === "skip") return "skip";
  if (clip.reducedMotionBehavior === "instant") {
    return "instant";
  }
  if (clip.reducedMotionPreset) return clip.reducedMotionPreset;

  return resolvePreset(preset).preset.reducedMotion;
}

function childrenOf(
  node: SceneNode,
  nodes: Map<string, SceneNode>,
): { id: string; bounds: SceneNode["bounds"] }[] {
  const direct = node.children ?? [];
  return direct
    .map((child) => nodes.get(child.id) ?? child)
    .map((child) => ({ id: child.id, bounds: child.bounds }));
}

/**
 * Normalized keyframe offsets become absolute milliseconds.
 *
 * A spring named as the clip's easing is sampled here rather than carried
 * forward: past this point nothing in the pipeline knows what a spring is, which
 * is what keeps the export path and the browser path identical.
 */
function absolutise(
  tracks: PropertyTrack[],
  startMs: number,
  durationMs: number,
  easing: string,
): CompiledProperty[] {
  const spring = parseSpring(easing);
  const samples = spring ? sampleSpring(spring, durationMs) : undefined;

  return tracks.map((track) => ({
    property: track.property,
    keyframes: samples
      ? springKeyframes(track.keyframes, samples, startMs, durationMs)
      : track.keyframes.map((keyframe) => ({
          timeMs: round(startMs + keyframe.offset * durationMs),
          value: keyframe.value,
          easing: keyframe.easing ?? easing,
        })),
  }));
}

/**
 * A two-keyframe track re-sampled along a spring's progress curve.
 *
 * Only numeric two-point tracks can take a spring: interpolating a clip-path
 * inset or a colour along an overshooting curve produces values outside their own
 * domain. Anything else keeps its authored keyframes and the spring is dropped —
 * silently would be wrong, so the caller sees the same shape it wrote.
 */
function springKeyframes(
  keyframes: Keyframe[],
  samples: { offset: number; value: number }[],
  startMs: number,
  durationMs: number,
): CompiledKeyframe[] {
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  if (
    keyframes.length !== 2 ||
    typeof first?.value !== "number" ||
    typeof last?.value !== "number"
  ) {
    return keyframes.map((keyframe) => ({
      timeMs: round(startMs + keyframe.offset * durationMs),
      value: keyframe.value,
      easing: keyframe.easing ?? "linear",
    }));
  }

  const from = first.value;
  const to = last.value;

  return samples.map((sample) => ({
    timeMs: round(startMs + sample.offset * durationMs),
    value: round(from + (to - from) * sample.value),
    easing: "linear",
  }));
}

// ---------------------------------------------------------------- conflicts

/**
 * Doc 04 §25.3: overlapping clips on the same property of the same target.
 *
 * Reported, and resolved later-wins by the sampler. Not blended: a blended result
 * is one nobody predicted from the timeline and no exporter can reproduce.
 */
function detectConflicts(clips: CompiledClip[], warnings: TimelineWarning[]): void {
  const seen = new Map<string, { clip: CompiledClip; property: string }[]>();

  for (const clip of clips) {
    for (const property of clip.properties) {
      const key = `${clip.targetId}|${clip.subTarget ?? ""}|${property.property}`;
      const existing = seen.get(key) ?? [];

      for (const other of existing) {
        const overlaps = clip.startMs < other.clip.endMs && other.clip.startMs < clip.endMs;
        if (overlaps) {
          warnings.push({
            code: "W136",
            message:
              `Two clips animate ${property.property} on ${clip.targetId} at the same ` +
              "time. The later one wins for the overlap.",
            targetId: clip.targetId,
            clipId: clip.id,
          });
        }
      }

      existing.push({ clip, property: property.property });
      seen.set(key, existing);
    }
  }
}
