/**
 * Editing the keyframes under a preset (doc 02 §24.5, doc 04 §22.2).
 *
 * A preset is deliberately **not opaque**: it is a pure function from parameters
 * to property tracks, so the timeline can *open* one into explicit keyframes an
 * author can then move. The schema already anticipates this — a clip carrying
 * both `preset` and `propertyTracks` uses the tracks and keeps the name as
 * provenance, so the panel can still say "this started as blurReveal" after it
 * has been taken apart.
 *
 * Opening is therefore an ordinary patch, not a mode. There is no "edited"
 * state, nothing to save, and undo works on it exactly as on a text edit.
 *
 * The rule that governs every function here: **offsets are 0–1 of the clip's
 * duration, not milliseconds** (doc 02 §24.5). Milliseconds would have to be
 * rewritten every time an author dragged a clip edge; a fraction survives it.
 * Callers think in time, so these take milliseconds at the boundary and
 * normalise once, here, rather than in three call sites that will disagree.
 */

import type { Keyframe, PatchOperation, PropertyTrack } from "@deckastra/presentation-schema";

import { round } from "../easing";
import { resolvePreset, type PresetContext } from "../presets";

export interface OpenableClip {
  id: string;
  trackId: string;
  durationMs: number;
  preset?: string;
  presetParams?: Record<string, unknown>;
  propertyTracks?: PropertyTrack[];
}

function clipPath(slideId: string, clip: { trackId: string; id: string }): string {
  return `/slides/id:${slideId}/animations/id:${clip.trackId}/clips/id:${clip.id}`;
}

/** Offsets are ascending by contract; every write goes through this. */
function sortKeyframes(keyframes: readonly Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.offset - b.offset);
}

function normalise(clip: { durationMs: number }, atMs: number): number {
  if (clip.durationMs <= 0) return 0;
  return round(Math.min(1, Math.max(0, atMs / clip.durationMs)));
}

/**
 * Expand a clip's preset into explicit property tracks it can then be edited as.
 *
 * Returns no operations for a clip that is already open — opening twice would
 * throw away the author's edits and replace them with the preset they started
 * from, which is the worst possible response to a double click.
 */
export function openPresetOperations(
  slideId: string,
  clip: OpenableClip,
  context: Omit<PresetContext, "params" | "durationMs">,
): { operations: PatchOperation[]; warning?: string } {
  if (clip.propertyTracks?.length) return { operations: [] };
  if (!clip.preset) {
    return {
      operations: [],
      warning: "This clip has no preset to open, and no keyframes to edit yet.",
    };
  }

  const { preset, degraded } = resolvePreset(clip.preset);
  const expansion = preset.expand({
    ...context,
    params: clip.presetParams ?? {},
    durationMs: clip.durationMs,
  });

  if (expansion.tracks.length === 0) {
    return {
      operations: [],
      warning: `"${clip.preset}" produced no property tracks to edit.`,
    };
  }

  return {
    operations: [
      {
        op: "add",
        path: `${clipPath(slideId, clip)}/propertyTracks`,
        value: expansion.tracks.map((track) => ({
          property: track.property,
          keyframes: sortKeyframes(track.keyframes),
        })),
      },
    ],
    warning: degraded ?? expansion.warning,
  };
}

/**
 * Put a keyframe at `atMs`, or move the value of the one already there.
 *
 * "Already there" is judged on the normalised offset rather than the millisecond,
 * because that is what the document stores: two clicks a millisecond apart on a
 * 300ms clip are the same keyframe, and creating two would leave a pair the
 * author cannot separate on any timeline they can see.
 */
export function setKeyframeOperations(
  slideId: string,
  clip: OpenableClip,
  property: string,
  atMs: number,
  value: unknown,
): { operations: PatchOperation[]; warning?: string } {
  const track = clip.propertyTracks?.find((candidate) => candidate.property === property);
  if (!track) {
    return {
      operations: [],
      warning: `This clip does not animate ${property}. Open its preset first.`,
    };
  }

  const offset = normalise(clip, atMs);
  const index = clip.propertyTracks!.indexOf(track);
  const existing = track.keyframes.findIndex((frame) => round(frame.offset) === offset);
  const keyframes =
    existing >= 0
      ? track.keyframes.map((frame, at) => (at === existing ? { ...frame, value } : frame))
      : [...track.keyframes, { offset, value }];

  return {
    operations: [
      {
        // Numeric index, and legitimately: keyframes have no ids, which is the
        // one case the id-addressing rule excepts (doc 02 §31.3). The whole
        // track is replaced rather than one keyframe so the sort is part of the
        // same operation — a patch that left them unordered would be a document
        // the compiler reads differently than the author sees.
        op: "replace",
        path: `${clipPath(slideId, clip)}/propertyTracks/${index}/keyframes`,
        value: sortKeyframes(keyframes),
      },
    ],
  };
}

/**
 * Move an existing keyframe along the clip.
 *
 * The ends are not special-cased and deliberately so: an author who drags the
 * last keyframe to the middle is saying the animation finishes early and holds,
 * which doc 02 §24.5 already defines — a track that does not span the range
 * holds its end values.
 */
export function moveKeyframeOperations(
  slideId: string,
  clip: OpenableClip,
  property: string,
  fromOffset: number,
  toMs: number,
): { operations: PatchOperation[]; warning?: string } {
  const track = clip.propertyTracks?.find((candidate) => candidate.property === property);
  if (!track) return { operations: [], warning: `This clip does not animate ${property}.` };

  const index = clip.propertyTracks!.indexOf(track);
  const target = round(fromOffset);
  const moving = track.keyframes.find((frame) => round(frame.offset) === target);
  if (!moving) return { operations: [], warning: "That keyframe is no longer there." };

  const offset = normalise(clip, toMs);
  const others = track.keyframes.filter((frame) => round(frame.offset) !== target);
  // Landing on another keyframe replaces it. Two keyframes at one offset is a
  // document whose meaning depends on array order, and an author cannot see
  // which of them they are dragging next time.
  const collided = others.some((frame) => round(frame.offset) === offset);

  return {
    operations: [
      {
        op: "replace",
        path: `${clipPath(slideId, clip)}/propertyTracks/${index}/keyframes`,
        value: sortKeyframes([
          ...others.filter((frame) => round(frame.offset) !== offset),
          { ...moving, offset },
        ]),
      },
    ],
    warning: collided ? "There was already a keyframe there, so it was replaced." : undefined,
  };
}

/**
 * Remove a keyframe, unless it is the last one.
 *
 * `PropertyTrackSchema` requires at least one: a track with none animates
 * nothing and cannot be parsed back. Removing the track itself is a different
 * intent — "stop animating this property" — and belongs to a different control.
 */
export function removeKeyframeOperations(
  slideId: string,
  clip: OpenableClip,
  property: string,
  offset: number,
): { operations: PatchOperation[]; warning?: string } {
  const track = clip.propertyTracks?.find((candidate) => candidate.property === property);
  if (!track) return { operations: [], warning: `This clip does not animate ${property}.` };

  if (track.keyframes.length <= 1) {
    return {
      operations: [],
      warning: `${property} has only one keyframe left. Remove the property itself to stop animating it.`,
    };
  }

  const index = clip.propertyTracks!.indexOf(track);
  const target = round(offset);
  const keyframes = track.keyframes.filter((frame) => round(frame.offset) !== target);
  if (keyframes.length === track.keyframes.length) {
    return { operations: [], warning: "That keyframe is no longer there." };
  }

  return {
    operations: [
      {
        op: "replace",
        path: `${clipPath(slideId, clip)}/propertyTracks/${index}/keyframes`,
        value: sortKeyframes(keyframes),
      },
    ],
  };
}
