/**
 * What a paired element actually does, as a delta (doc 04 §22.4).
 *
 * Separate from pairing because the two answer different questions and fail in
 * different ways: pairing can be wrong about *which* elements correspond, and
 * this can be wrong about *how far* one travels. Keeping them apart means a test
 * for one is not a test for the other.
 *
 * Deltas, never destinations — the rule the motion presets already follow. An
 * element told to move by `dx` survives the slide being re-laid out; one told to
 * move to a coordinate animates to the wrong place the moment a container
 * changes its padding, and the failure shows up as an element that jumps at the
 * end of its own transition.
 */

import { round } from "../easing";
import type { MatchMode, PairDelta, TransitionNode } from "./types";

/** A zero-size box cannot be scaled *to* anything; treat it as unscaled. */
function ratio(from: number, to: number): number {
  if (from === 0) return 1;
  return to / from;
}

/**
 * The delta for one pair, honouring what the author allowed.
 *
 * `matchMode` is a permission, not a hint. An author who wrote `"position"`
 * decided that the element should travel without resizing — usually because the
 * two sizes differ for a reason (a thumbnail and a full-bleed image) and
 * interpolating between them looks like a mistake. Scaling anyway would override
 * a decision they made deliberately.
 */
export function pairDelta(
  source: TransitionNode,
  destination: TransitionNode,
  matchMode: MatchMode,
): PairDelta {
  const text = source.fontSize !== undefined && destination.fontSize !== undefined;

  // The point that corresponds on both. For a box, its centre: corner-to-corner
  // drifts whenever the two boxes differ in size, which is exactly the case a
  // morph exists for. For text, the edge the words are aligned to: a
  // left-aligned headline whose box grew stays put on the left, and matching
  // centres would slide every letter sideways as it arrived.
  const from = text && source.anchor ? source.anchor : centre(source);
  const to = text && destination.anchor ? destination.anchor : centre(destination);

  let scales: { scaleX: number; scaleY: number };
  if (matchMode === "position") {
    scales = { scaleX: 1, scaleY: 1 };
  } else if (text) {
    // Text scales by its type size, uniformly. The box says where the words may
    // wrap, not how big they are: a box made twice as wide with the same 40px
    // type would otherwise draw every glyph stretched to double width and
    // squeeze it back — the single most visible way a morph looks broken.
    const uniform = round(ratio(destination.fontSize!, source.fontSize!));
    scales = { scaleX: uniform, scaleY: uniform };
  } else {
    scales = {
      scaleX: round(ratio(destination.bounds.width, source.bounds.width)),
      scaleY: round(ratio(destination.bounds.height, source.bounds.height)),
    };
  }

  // Expressed from the *destination's* resting place backwards, because that is
  // where the element lives once the transition ends.
  const delta: PairDelta = {
    sourceId: source.id,
    destinationId: destination.id,
    dx: round(from.x - to.x),
    dy: round(from.y - to.y),
    ...scales,
    rotate: 0,
    fadeFrom: 1,
    fadeTo: 1,
    from: { x: round(from.x), y: round(from.y) },
    to: { x: round(to.x), y: round(to.y) },
  };

  if (matchMode === "full") {
    // Only `full` interpolates what the element *is* rather than where it sits.
    delta.rotate = round((source.rotation ?? 0) - (destination.rotation ?? 0));
    delta.fadeFrom = source.opacity ?? 1;
    delta.fadeTo = destination.opacity ?? 1;
  }

  return delta;
}

function centre(node: TransitionNode): { x: number; y: number } {
  return { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 };
}

/** Whether a delta would visibly do anything, so a no-op pair can be dropped. */
export function isMoving(delta: PairDelta): boolean {
  return (
    Math.abs(delta.dx) > 0.5 ||
    Math.abs(delta.dy) > 0.5 ||
    Math.abs(delta.scaleX - 1) > 0.005 ||
    Math.abs(delta.scaleY - 1) > 0.005 ||
    Math.abs(delta.rotate) > 0.5 ||
    Math.abs(delta.fadeFrom - delta.fadeTo) > 0.005
  );
}
