/**
 * Two clips animating one property at once, and what to do about it (doc 04 §25.3).
 *
 * The compiler already notices — `W136` — and says "the later one wins for the
 * overlap". That is true and it is not actionable: it does not say which other
 * clip, by how much, or what to press. This turns each one into a finding with
 * the shape the validator's catalog uses for a `MECHANICALLY_FIXABLE` rule: a
 * named problem and concrete operations that resolve it.
 *
 * Why a fix rather than a refusal: an overlap is not always wrong. Fading one
 * property while another moves is ordinary, and two clips deliberately
 * overlapping the *same* property for a beat is a thing authors do on purpose.
 * The product's job is to make sure it was a decision — a striped bar says
 * "look", a named fix says "or do this instead", and neither takes the choice
 * away.
 *
 * Both fixes are *one* patch each and both are reversible by undo, because they
 * are ordinary clip edits: nothing here is a special conflict-resolution mode.
 */

import type { PatchOperation } from "@deckastra/presentation-schema";

import type { CompiledClip, CompiledTimeline } from "../compile";
import { round } from "../easing";
import { MIN_CLIP_MS } from "./edits";

export interface ConflictFix {
  /** Imperative, and specific enough to choose between: no "Fix" buttons. */
  label: string;
  operations: PatchOperation[];
  /** Why this is the wrong choice sometimes, when that is worth saying. */
  caveat?: string;
}

export interface TimelineConflict {
  targetId: string;
  property: string;
  /** Whichever starts first; ties broken by clip id so the pair is stable. */
  earlierClipId: string;
  laterClipId: string;
  overlapMs: number;
  message: string;
  fixes: ConflictFix[];
}

/** The document's own view of a clip, which is where a fix has to be written. */
export interface SourceClip {
  id: string;
  trackId: string;
  startMs: number;
  durationMs: number;
  delayMs?: number;
}

function clipPath(slideId: string, clip: SourceClip): string {
  return `/slides/id:${slideId}/animations/id:${clip.trackId}/clips/id:${clip.id}`;
}

/**
 * Every property the two clips both animate.
 *
 * A pair can collide on more than one — a preset that moves and fades overlapping
 * another that does both is two findings, not one — and reporting only the first
 * would leave an author fixing the same pair twice.
 */
function sharedProperties(a: CompiledClip, b: CompiledClip): string[] {
  const mine = new Set(a.properties.map((one) => one.property));
  return b.properties.map((one) => one.property).filter((property) => mine.has(property));
}

export function findConflicts(
  slideId: string,
  timeline: CompiledTimeline,
  sourceClips: readonly SourceClip[],
): TimelineConflict[] {
  const source = new Map(sourceClips.map((clip) => [clip.id, clip]));
  const conflicts: TimelineConflict[] = [];

  // Sorted so a pair is always reported the same way round, whatever order the
  // compiler emitted. An author who fixes one and re-opens the deck should not
  // find the same conflict described from the other side.
  const clips = [...timeline.clips].sort(
    (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id),
  );

  for (let i = 0; i < clips.length; i += 1) {
    for (let j = i + 1; j < clips.length; j += 1) {
      const earlier = clips[i]!;
      const later = clips[j]!;
      if (earlier.targetId !== later.targetId) continue;

      const overlapMs = round(Math.min(earlier.endMs, later.endMs) - later.startMs);
      if (overlapMs <= 0) continue;

      for (const property of sharedProperties(earlier, later)) {
        conflicts.push({
          targetId: earlier.targetId,
          property,
          earlierClipId: earlier.id,
          laterClipId: later.id,
          overlapMs,
          message:
            `Two clips animate ${property} on this object for ${Math.round(overlapMs)}ms ` +
            "together. The later one wins where they overlap.",
          fixes: fixesFor(slideId, earlier, later, overlapMs, source),
        });
      }
    }
  }

  return conflicts;
}

function fixesFor(
  slideId: string,
  earlier: CompiledClip,
  later: CompiledClip,
  overlapMs: number,
  source: Map<string, SourceClip>,
): ConflictFix[] {
  const fixes: ConflictFix[] = [];

  const laterSource = source.get(later.id);
  if (laterSource) {
    // Delay the later clip until the earlier one is finished. Written as an
    // offset from the trigger, because that is what the document stores — adding
    // the overlap to the *stored* start keeps a clip on an `afterPrevious` track
    // correct, where writing an absolute time would not.
    fixes.push({
      label: `Start the later clip ${Math.round(overlapMs)}ms later`,
      operations: [
        {
          op: "replace",
          path: `${clipPath(slideId, laterSource)}/startMs`,
          value: round(laterSource.startMs + overlapMs),
        },
      ],
      caveat: "Everything timed after it keeps its own start, so a gap may open.",
    });
  }

  const earlierSource = source.get(earlier.id);
  if (earlierSource) {
    const shortened = round(earlierSource.durationMs - overlapMs);
    if (shortened >= MIN_CLIP_MS) {
      fixes.push({
        label: `Shorten the earlier clip to ${Math.round(shortened)}ms`,
        operations: [
          {
            op: "replace",
            path: `${clipPath(slideId, earlierSource)}/durationMs`,
            value: shortened,
          },
        ],
        caveat: "Its keyframes are offsets, so they compress with it.",
      });
    }
  }

  return fixes;
}
