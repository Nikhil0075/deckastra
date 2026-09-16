/**
 * Moving everything after a point (doc 04 §25.2).
 *
 * The edit that makes a timeline feel like a timeline: lengthen a clip and the
 * ones after it get out of the way, rather than overlapping it and leaving the
 * author to drag each one.
 *
 * Two decisions sit in here, both about what "after" means.
 *
 * **Within one track, not across the slide.** A track's clips share a trigger
 * and run in sequence; clips on *other* tracks have their own triggers and their
 * own reasons for their timing. Rippling the whole slide would move things the
 * author never touched, and the damage would be spread across every element on
 * it — the opposite of what an edit should do.
 *
 * **By start time, not by array position.** `slide.animations[].clips` is
 * document order, which an author can reorder for reasons of their own; what a
 * ripple is about is time. Sorting by start is also what makes the operation
 * stable when two clips begin together: both move or neither does.
 */

import type { PatchOperation } from "@deckastra/presentation-schema";

import { round } from "../easing";

export interface RippleClip {
  id: string;
  startMs: number;
  durationMs: number;
}

export interface RippleResult {
  operations: PatchOperation[];
  /** Ids that moved, so a UI can say what else changed rather than surprising anyone. */
  movedClipIds: string[];
  warning?: string;
}

/**
 * Shift every clip that starts at or after `fromMs` by `deltaMs`.
 *
 * A negative delta is clamped so nothing is pushed before its trigger: a clip
 * with a negative `startMs` is not an earlier clip, it is an invalid document.
 * Clamping per clip rather than refusing the whole gesture keeps a ripple that
 * mostly makes sense from failing because one clip sits at zero.
 */
export function rippleOperations(
  slideId: string,
  trackId: string,
  clips: readonly RippleClip[],
  fromMs: number,
  deltaMs: number,
): RippleResult {
  if (deltaMs === 0) return { operations: [], movedClipIds: [] };

  const base = `/slides/id:${slideId}/animations/id:${trackId}/clips`;
  const affected = [...clips]
    .filter((clip) => clip.startMs >= fromMs)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  const operations: PatchOperation[] = [];
  const movedClipIds: string[] = [];
  let clamped = false;

  for (const clip of affected) {
    const next = Math.max(0, round(clip.startMs + deltaMs));
    if (next !== clip.startMs) {
      if (next !== round(clip.startMs + deltaMs)) clamped = true;
      operations.push({ op: "replace", path: `${base}/id:${clip.id}/startMs`, value: next });
      movedClipIds.push(clip.id);
    }
  }

  return {
    operations,
    movedClipIds,
    warning: clamped
      ? "Some clips were already at the start of their track, so they could not move any earlier."
      : undefined,
  };
}

/**
 * What a ripple would be after a clip's duration changed.
 *
 * Separate from the trim itself so a caller can offer the two independently —
 * an author dragging an edge with a modifier held usually means "just this one",
 * and a timeline that always rippled would make that impossible.
 */
export function rippleAfterTrim(
  slideId: string,
  trackId: string,
  clips: readonly RippleClip[],
  trimmedClipId: string,
  newDurationMs: number,
): RippleResult {
  const trimmed = clips.find((clip) => clip.id === trimmedClipId);
  if (!trimmed) return { operations: [], movedClipIds: [] };

  const delta = round(newDurationMs - trimmed.durationMs);
  const after = clips.filter((clip) => clip.id !== trimmedClipId);
  return rippleOperations(slideId, trackId, after, trimmed.startMs + trimmed.durationMs, delta);
}
