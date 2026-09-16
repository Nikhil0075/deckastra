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
  // Centre to centre. Corner-to-corner drifts whenever the two boxes differ in
  // size, which is exactly the case a morph exists for: the element appears to
  // slide sideways as it grows.
  const sourceCentre = {
    x: source.bounds.x + source.bounds.width / 2,
    y: source.bounds.y + source.bounds.height / 2,
  };
  const destinationCentre = {
    x: destination.bounds.x + destination.bounds.width / 2,
    y: destination.bounds.y + destination.bounds.height / 2,
  };

  const scales =
    matchMode === "position"
      ? { scaleX: 1, scaleY: 1 }
      : {
          scaleX: round(ratio(destination.bounds.width, source.bounds.width)),
          scaleY: round(ratio(destination.bounds.height, source.bounds.height)),
        };

  // The delta is expressed from the *destination's* resting place backwards,
  // because that is where the element lives once the transition ends. The
  // incoming element starts displaced and settles; nothing has to be positioned
  // absolutely at any point.
  const delta: PairDelta = {
    sourceId: source.id,
    destinationId: destination.id,
    dx: round(sourceCentre.x - destinationCentre.x),
    dy: round(sourceCentre.y - destinationCentre.y),
    ...scales,
    rotate: 0,
    fadeFrom: 1,
    fadeTo: 1,
  };

  if (matchMode === "full") {
    // Only `full` interpolates what the element *is* rather than where it sits.
    // Rotation and opacity change an element's appearance, and an author who
    // asked for position matching did not ask for that.
    delta.rotate = round((source.rotation ?? 0) - (destination.rotation ?? 0));
    delta.fadeFrom = source.opacity ?? 1;
    delta.fadeTo = destination.opacity ?? 1;
  }

  return delta;
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
