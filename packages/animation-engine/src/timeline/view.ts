/**
 * The timeline as a view: lanes and bars to draw (doc 04 §25).
 *
 * Half of the rule this module is built on — **the timeline is a view of
 * document state**. Nothing here mutates anything; it turns a compiled timeline
 * into rows. `edits.ts` is the other half, turning a gesture into patches.
 */

import type { CompiledTimeline } from "../compile";

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

