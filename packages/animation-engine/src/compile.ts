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
 * keyframe. Resolution order is the viewer's explicit setting, then the OS, then
 * the document — a deck author cannot force motion onto someone who asked their
 * OS for less — and the caller is told which level was used.
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

import { DEFAULT_EASING, parseSpring, round, sampleSpring } from "./easing";
import { durationForBounds, resolvePreset, type PresetContext } from "./presets";

export type MotionLevel = "full" | "reduced" | "none";

/** Doc 04 §27.2: reduced motion is 0.6× duration and a 60ms stagger ceiling. */
export const REDUCED_DURATION_SCALE = 0.6;
export const REDUCED_MAX_STAGGER_MS = 60;

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
 * Doc 04 §27.1: user explicit > OS > document > full.
 *
 * The order is the point. A document that asks for `reducedMotionFallback: none`
 * must not be able to take motion away from a viewer who chose Full, and a
 * document that wants motion must not be able to give it to a viewer whose OS
 * asked for less.
 */
export function resolveMotionLevel(
  documentPreference: string | undefined,
  options: CompileOptions,
): MotionLevel {
  if (options.userMotionPreference) return options.userMotionPreference;
  if (options.systemPrefersReducedMotion) return "reduced";
  if (documentPreference === "none") return "none";
  if (documentPreference === "fade") return "reduced";
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
        cursor = Math.max(cursor, one.endMs);
        const segment = segments[one.segment];
        if (segment) segment.endMs = Math.max(segment.endMs, one.endMs);
      }
    }
  }

  detectConflicts(clips, warnings);

  const durationMs = clips.reduce((longest, clip) => Math.max(longest, clip.endMs), 0);
  const budgetMs = options.entranceBudgetMs ?? motion.budgetMs;
  const entranceMs = segments[0] ? segments[0].endMs : 0;

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

  return {
    slideId: scene.slideId,
    motionLevel: level,
    durationMs: round(durationMs),
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

  if (level === "none") {
    // Doc 04 §27.2: elements appear in their final state instantly, and segments
    // still advance so click-to-reveal keeps working. A zero-length clip that
    // still holds its end value is exactly that.
    return [
      {
        id: clip.id,
        trackId: track.id,
        targetId: track.targetId,
        subTarget: track.subTarget,
        startMs: round(start),
        endMs: round(start),
        preset: clip.preset,
        fill: clip.fill ?? "both",
        properties: endStateOnly(context),
        segment,
      },
    ];
  }

  const expansion = expandClip(context, durationMs);
  for (const warning of expansion.warnings) warnings.push(warning);

  const own: CompiledClip = {
    id: clip.id,
    trackId: track.id,
    targetId: track.targetId,
    subTarget: track.subTarget,
    startMs: round(start),
    endMs: round(start + durationMs),
    preset: clip.preset,
    fill: clip.fill ?? "both",
    properties: absolutise(expansion.tracks, start, durationMs, clip.easing ?? motion.defaultEasing),
    segment,
  };

  const results = own.properties.length > 0 ? [own] : [];

  for (const child of expansion.children) {
    const delay = level === "reduced" ? Math.min(child.delayMs, REDUCED_MAX_STAGGER_MS) : child.delayMs;
    const childStart = start + delay;
    results.push({
      id: `${clip.id}:${child.targetId}`,
      trackId: track.id,
      targetId: child.targetId,
      startMs: round(childStart),
      endMs: round(childStart + durationMs),
      preset: clip.preset,
      fill: clip.fill ?? "both",
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

function scaleDuration(durationMs: number, level: MotionLevel): number {
  return level === "reduced" ? round(durationMs * REDUCED_DURATION_SCALE) : durationMs;
}

interface Expansion {
  tracks: PropertyTrack[];
  children: { targetId: string; delayMs: number; tracks: PropertyTrack[] }[];
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

  if (clip.reducedMotionBehavior === "skip" || clip.reducedMotionBehavior === "instant") {
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
 * A zero-length clip holding only the end value.
 *
 * Used at motion level "none". Not an empty clip: doc 04 §27.3 is explicit that
 * reduced motion must never mean the content fails to appear, and an element
 * whose entrance was removed rather than collapsed starts at opacity 0 and stays
 * there.
 */
function endStateOnly(context: ClipContext): CompiledProperty[] {
  const expansion = expandClip(context, 1);
  const at = round(context.triggerStart + context.clip.startMs + (context.clip.delayMs ?? 0));

  return expansion.tracks.map((track) => {
    const last = track.keyframes[track.keyframes.length - 1];
    return {
      property: track.property,
      keyframes: [{ timeMs: at, value: last ? last.value : 1, easing: "linear" }],
    };
  });
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
