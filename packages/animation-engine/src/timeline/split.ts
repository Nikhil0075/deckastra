/**
 * Cutting a clip in two (doc 04 §25.2).
 *
 * The operation that looks trivial on a timeline and is not, because of a design
 * decision three files away: **a keyframe's offset is 0–1 of its clip's
 * duration**, not a time (doc 02 §24.5). That normalisation is what makes
 * trimming a clip one property change instead of N — but it means a split cannot
 * copy keyframes across. Each half has its own duration, so every offset has to
 * be re-expressed against it.
 *
 * And the seam has to hold. At the moment of the cut both halves describe the
 * same instant, so each needs an explicit keyframe there carrying the value the
 * original had — the first half ending on it, the second beginning from it. Left
 * out, the second half starts from whatever its first surviving keyframe says
 * and the element jumps at the join, which is the one artefact a split must
 * never introduce.
 */

import type { Keyframe, PatchOperation, PropertyTrack } from "@deckastra/presentation-schema";

import { round } from "../easing";
import { MIN_CLIP_MS } from "./edits";

export interface SplitTarget {
  id: string;
  trackId: string;
  startMs: number;
  durationMs: number;
  delayMs?: number;
  preset?: string;
  presetParams?: Record<string, unknown>;
  propertyTracks?: PropertyTrack[];
  easing?: string;
}

export interface SplitResult {
  operations: PatchOperation[];
  /** The id given to the second half, so a caller can select it. */
  newClipId: string;
  /** Stated when the cut could not be made cleanly. */
  warning?: string;
}

/**
 * Linear interpolation between two keyframes at a fraction of the way between.
 *
 * Numbers only. A colour, a path or an enum has no midpoint this module could
 * invent, and inventing one would put a value in the document that the author
 * never chose — so the nearer keyframe's value is taken and the caller is told.
 */
function valueAt(
  before: Keyframe,
  after: Keyframe,
  progress: number,
): { value: unknown; exact: boolean } {
  if (typeof before.value === "number" && typeof after.value === "number") {
    return { value: round(before.value + (after.value - before.value) * progress), exact: true };
  }
  return { value: progress < 0.5 ? before.value : after.value, exact: false };
}

function sampleTrack(track: PropertyTrack, offset: number): { value: unknown; exact: boolean } {
  const sorted = [...track.keyframes].sort((a, b) => a.offset - b.offset);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  // A track that does not span the full range holds its end values (doc 02
  // §24.5), so a cut outside it takes the value it is holding.
  if (offset <= first.offset) return { value: first.value, exact: true };
  if (offset >= last.offset) return { value: last.value, exact: true };

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const before = sorted[index]!;
    const after = sorted[index + 1]!;
    if (offset >= before.offset && offset <= after.offset) {
      const span = after.offset - before.offset;
      return valueAt(before, after, span <= 0 ? 1 : (offset - before.offset) / span);
    }
  }
  return { value: last.value, exact: true };
}

/** Re-express a track's keyframes against one side of the cut. */
function halve(
  track: PropertyTrack,
  cut: number,
  side: "before" | "after",
): { track: PropertyTrack; exact: boolean } {
  const sorted = [...track.keyframes].sort((a, b) => a.offset - b.offset);
  const seam = sampleTrack(track, cut);

  const kept =
    side === "before"
      ? sorted.filter((frame) => frame.offset < cut).map((frame) => ({ ...frame, offset: round(frame.offset / cut) }))
      : sorted
          .filter((frame) => frame.offset > cut)
          .map((frame) => ({ ...frame, offset: round((frame.offset - cut) / (1 - cut)) }));

  // The seam keyframe, at the end of the first half and the start of the second.
  const boundary: Keyframe = { offset: side === "before" ? 1 : 0, value: seam.value };
  const keyframes = side === "before" ? [...kept, boundary] : [boundary, ...kept];

  return {
    // `.min(1)` on the schema is satisfied by the seam alone, so a half that
    // inherited no keyframes still describes a value rather than failing to parse.
    track: { property: track.property, keyframes },
    exact: seam.exact,
  };
}

/**
 * Split `clip` at `atMs` measured from the clip's own start.
 *
 * Refuses rather than producing something unusable: a cut that would leave
 * either half below `MIN_CLIP_MS` is not a split, it is a clip with a sliver
 * beside it that an author then has to find and delete.
 */
export function splitClip(
  slideId: string,
  clip: SplitTarget,
  atMs: number,
  newClipId: string,
): SplitResult | { operations: []; newClipId: string; warning: string } {
  const first = Math.round(atMs);
  const second = Math.round(clip.durationMs - atMs);

  if (first < MIN_CLIP_MS || second < MIN_CLIP_MS) {
    return {
      operations: [],
      newClipId,
      warning:
        `A split here would leave a clip shorter than ${MIN_CLIP_MS}ms. ` +
        "Move the cut further from the edge, or lengthen the clip first.",
    };
  }

  const cut = first / clip.durationMs;
  const base = `/slides/id:${slideId}/animations/id:${clip.trackId}`;
  const clipPath = `${base}/clips/id:${clip.id}`;

  let inexact = false;
  const before: PropertyTrack[] = [];
  const after: PropertyTrack[] = [];
  for (const track of clip.propertyTracks ?? []) {
    const left = halve(track, cut, "before");
    const right = halve(track, cut, "after");
    before.push(left.track);
    after.push(right.track);
    if (!left.exact || !right.exact) inexact = true;
  }

  const operations: PatchOperation[] = [
    { op: "replace", path: `${clipPath}/durationMs`, value: first },
  ];

  if (clip.propertyTracks?.length) {
    operations.push({ op: "replace", path: `${clipPath}/propertyTracks`, value: before });
  }

  operations.push({
    op: "add",
    path: `${base}/clips/-`,
    value: {
      id: newClipId,
      // The second half begins where the first ends. `startMs` is an offset from
      // the trigger, so this is arithmetic on the same axis rather than a
      // conversion — and getting that wrong would put the second half at the
      // trigger instead of at the cut.
      startMs: round(clip.startMs + first),
      durationMs: second,
      ...(clip.delayMs !== undefined ? { delayMs: clip.delayMs } : {}),
      ...(clip.easing !== undefined ? { easing: clip.easing } : {}),
      // The preset name travels as provenance: "this started as blurReveal" is
      // still true of both halves, and the panel says so. Its *parameters* do
      // not, when the clip was opened — the property tracks are what animates,
      // and parameters that no longer describe them would mislead the inspector.
      ...(clip.preset !== undefined ? { preset: clip.preset } : {}),
      ...(clip.propertyTracks?.length
        ? { propertyTracks: after }
        : clip.presetParams !== undefined
          ? { presetParams: clip.presetParams }
          : {}),
    },
  });

  return {
    operations,
    newClipId,
    warning: inexact
      ? "Some values on this clip cannot be interpolated — a colour or a path has no midpoint — " +
        "so the nearer keyframe's value was used at the cut."
      : undefined,
  };
}
