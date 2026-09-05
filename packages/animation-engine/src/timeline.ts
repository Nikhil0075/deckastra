/**
 * The timeline as a view, and its edits as patches (doc 04 §25).
 *
 * The rule that shapes this file: **the timeline is a view of document state.**
 * Dragging a clip is not a UI-local mutation with a save button behind it — it is
 * a patch against `slide.animations`, and therefore a transaction with an inverse
 * in the same history as every other edit (doc 04 §25.2, §29).
 *
 * So there are two halves here and nothing in between. `buildTimelineView` turns
 * the compiled timeline into lanes and bars to draw. `clipPatchOperations` turns
 * a gesture into operations. Neither one mutates anything.
 */

import type { PatchOperation } from "@deckastra/presentation-schema";

import type { CompiledClip, CompiledTimeline } from "./compile";
import { round } from "./easing";

export interface TimelineBar {
  clipId: string;
  trackId: string;
  targetId: string;
  label: string;
  startMs: number;
  endMs: number;
  segment: number;
  preset?: string;
  /** True when another clip animates one of the same properties over this span. */
  conflicted: boolean;
}

export interface TimelineLane {
  targetId: string;
  label: string;
  bars: TimelineBar[];
}

export interface TimelineView {
  lanes: TimelineLane[];
  durationMs: number;
  segments: CompiledTimeline["segments"];
  /** Grid ticks, in milliseconds. A second apart until that is too dense. */
  ticks: number[];
  warnings: CompiledTimeline["warnings"];
  budget: CompiledTimeline["budget"];
}

/**
 * Lanes in document order, one per animated target.
 *
 * Not one lane per *track*: an author reads the timeline by asking "when does the
 * title move", and a target that carries three tracks would otherwise be three
 * rows they have to mentally re-join.
 */
export function buildTimelineView(
  timeline: CompiledTimeline,
  labels: Map<string, string> = new Map(),
): TimelineView {
  const conflicted = new Set(
    timeline.warnings.filter((warning) => warning.code === "W136").map((warning) => warning.clipId),
  );

  const lanes = new Map<string, TimelineLane>();

  for (const clip of timeline.clips) {
    const lane = lanes.get(clip.targetId) ?? {
      targetId: clip.targetId,
      label: labels.get(clip.targetId) ?? clip.targetId,
      bars: [],
    };

    lane.bars.push({
      clipId: clip.id,
      trackId: clip.trackId,
      targetId: clip.targetId,
      label: clip.preset ?? "custom",
      startMs: clip.startMs,
      endMs: clip.endMs,
      segment: clip.segment,
      preset: clip.preset,
      conflicted: conflicted.has(clip.id),
    });

    lanes.set(clip.targetId, lane);
  }

  return {
    lanes: [...lanes.values()],
    durationMs: timeline.durationMs,
    segments: timeline.segments,
    ticks: ticksFor(timeline.durationMs),
    warnings: timeline.warnings,
    budget: timeline.budget,
  };
}

function ticksFor(durationMs: number): number[] {
  // One tick a second up to ten seconds, then every two. A grid denser than the
  // eye can separate is a grid nobody reads.
  const step = durationMs <= 10_000 ? 1_000 : 2_000;
  const ticks: number[] = [];
  for (let at = 0; at <= durationMs; at += step) ticks.push(at);
  return ticks;
}

// -------------------------------------------------------------------- edits

export type ClipEdit =
  | { kind: "move"; startMs: number }
  | { kind: "trim"; durationMs: number }
  | { kind: "easing"; easing: string }
  | { kind: "preset"; preset: string; presetParams?: Record<string, unknown> }
  | { kind: "params"; presetParams: Record<string, unknown> }
  | { kind: "trigger"; trigger: { type: string; delayMs?: number } }
  | { kind: "delete" };

/** Minimum clip length. Below this a clip is a step, and a step is a `none` clip. */
export const MIN_CLIP_MS = 50;

/**
 * A timeline gesture as patch operations.
 *
 * Id-addressed, always. An index path into `slide.animations` breaks the moment
 * another track is inserted before it, which is exactly what adding an animation
 * does — and the author would be dragging clip 3 and moving clip 4.
 *
 * `startMs` is written as an offset from the *trigger*, not as an absolute time,
 * because that is what the document stores (doc 02 §24.4). Dragging a clip on a
 * timeline whose neighbour then changes duration must not silently reposition it.
 */
export function clipPatchOperations(
  slideId: string,
  clip: CompiledClip,
  edit: ClipEdit,
  triggerStartMs: number,
): PatchOperation[] {
  const base = `/slides/id:${slideId}/animations/id:${clip.trackId}`;
  const clipPath = `${base}/clips/id:${clip.id}`;

  switch (edit.kind) {
    case "move":
      return [
        {
          op: "replace",
          path: `${clipPath}/startMs`,
          value: Math.max(0, round(edit.startMs - triggerStartMs)),
        },
      ];

    case "trim":
      return [
        {
          op: "replace",
          path: `${clipPath}/durationMs`,
          value: Math.max(MIN_CLIP_MS, round(edit.durationMs)),
        },
      ];

    case "easing":
      return [{ op: "replace", path: `${clipPath}/easing`, value: edit.easing }];

    case "preset":
      return [
        { op: "replace", path: `${clipPath}/preset`, value: edit.preset },
        // Parameters belong to the preset that declared them; carrying a
        // `blurReveal` blur onto a `drawPath` leaves a value nothing reads and
        // the panel offering a control that does nothing.
        {
          op: "replace",
          path: `${clipPath}/presetParams`,
          value: edit.presetParams ?? {},
        },
      ];

    case "params":
      return [
        { op: "replace", path: `${clipPath}/presetParams`, value: edit.presetParams },
      ];

    case "trigger":
      return [{ op: "replace", path: `${base}/trigger`, value: edit.trigger }];

    case "delete":
      return [{ op: "remove", path: clipPath }];

    default:
      return [];
  }
}
