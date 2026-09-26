/**
 * One transition type, one definition (doc 02 §26, doc 04 §27).
 *
 * A registry rather than a `switch`, for the reason `presets.ts` is a registry:
 * a kind is then a small pure function that can be read, tested and replaced on
 * its own, and adding one is adding a file rather than editing a branch three
 * other things also read. It also makes the degradation path single — an unknown
 * type resolves through one function, so a v2 deck opened here cannot fall
 * through a `default:` that nobody wrote a message for.
 *
 * Every kind emits **tracks of keyframes with offsets in 0–1**. Absolute
 * milliseconds are the compiler's job, exactly as with clips: everything
 * relative is resolved once, and everything after that is a pure function of
 * time.
 *
 * Longhands only (`translate`, `scale`, `rotate`, `opacity`). The renderer puts
 * a base `transform` on elements, and a shorthand written here would erase it —
 * sending the element to the slide origin, which looks like the transition threw
 * the content away.
 */

import type { PairDelta, TransitionKeyframe, TransitionTrack } from "./types";

export type TransitionDirection = "left" | "right" | "up" | "down";

export interface TransitionKindContext {
  direction: TransitionDirection;
  /** Deltas for the paired elements, already computed. Empty for every non-morph kind. */
  deltas: readonly PairDelta[];
  easing: string;
}

export interface TransitionKindResult {
  tracks: TransitionTrack[];
  /** Said when the kind could not do what was asked and did something else. */
  warning?: string;
}

export interface TransitionKindDefinition {
  name: string;
  /** For the editor's picker. */
  description: string;
  /** Whether the outgoing slide is still visible while this runs. */
  showsBothSlides: boolean;
  plan(context: TransitionKindContext): TransitionKindResult;
}

function slideOffset(direction: TransitionDirection, distance: number): { x: number; y: number } {
  switch (direction) {
    case "left":
      return { x: distance, y: 0 };
    case "right":
      return { x: -distance, y: 0 };
    case "up":
      return { x: 0, y: distance };
    default:
      return { x: 0, y: -distance };
  }
}

function incoming(keyframes: TransitionKeyframe[], easing: string): TransitionTrack {
  return { targetId: "slide:in", kind: "incoming", keyframes, easing };
}

function outgoing(keyframes: TransitionKeyframe[], easing: string): TransitionTrack {
  return { targetId: "slide:out", kind: "outgoing", keyframes, easing };
}

// ------------------------------------------------------------------- kinds

const cut: TransitionKindDefinition = {
  name: "cut",
  description: "No transition. The next slide is simply there.",
  showsBothSlides: false,
  plan: () => ({ tracks: [] }),
};

const fade: TransitionKindDefinition = {
  name: "fade",
  description: "The next slide fades in over the current one.",
  showsBothSlides: true,
  plan: ({ easing }) => ({
    tracks: [
      incoming(
        [
          { offset: 0, properties: { opacity: 0 } },
          { offset: 1, properties: { opacity: 1 } },
        ],
        easing,
      ),
    ],
  }),
};

const slide: TransitionKindDefinition = {
  name: "slide",
  description: "The next slide travels in from one edge, covering this one.",
  showsBothSlides: true,
  plan: ({ direction, easing }) => {
    const from = slideOffset(direction, 100);
    return {
      tracks: [
        incoming(
          [
            { offset: 0, properties: { translateX: `${from.x}%`, translateY: `${from.y}%` } },
            { offset: 1, properties: { translateX: "0%", translateY: "0%" } },
          ],
          easing,
        ),
      ],
    };
  },
};

const push: TransitionKindDefinition = {
  name: "push",
  description: "Both slides move together, as one deck rather than two images.",
  showsBothSlides: true,
  plan: ({ direction, easing }) => {
    const from = slideOffset(direction, 100);
    return {
      tracks: [
        // The outgoing slide leaving is what makes this a push rather than a
        // cover: without it the viewer sees a new slide slide *over* a stationary
        // one, which reads as two pictures instead of one continuous surface.
        outgoing(
          [
            { offset: 0, properties: { translateX: "0%", translateY: "0%" } },
            { offset: 1, properties: { translateX: `${-from.x}%`, translateY: `${-from.y}%` } },
          ],
          easing,
        ),
        incoming(
          [
            { offset: 0, properties: { translateX: `${from.x}%`, translateY: `${from.y}%` } },
            { offset: 1, properties: { translateX: "0%", translateY: "0%" } },
          ],
          easing,
        ),
      ],
    };
  },
};

const zoom: TransitionKindDefinition = {
  name: "zoom",
  description: "The next slide settles in from slightly larger.",
  showsBothSlides: true,
  plan: ({ easing }) => ({
    tracks: [
      incoming(
        [
          { offset: 0, properties: { opacity: 0, scale: 1.06 } },
          { offset: 1, properties: { opacity: 1, scale: 1 } },
        ],
        easing,
      ),
    ],
  }),
};

/**
 * Shared-element morph.
 *
 * The paired elements travel; everything else crossfades underneath them. That
 * split is the whole illusion — an audience reads "the same object moved" only
 * if the object does not also fade, and reads "the slide changed" from
 * everything that does.
 *
 * So a pair is drawn as **two copies above both slides**, not as the element
 * inside the arriving slide: that slide is fading in from nothing, and anything
 * inside it fades with it, which is how the first version showed a ghost
 * sliding in over a copy that never moved. The leaving copy (`pair:out:`) and
 * the arriving one (`pair:in:`) follow one path from the source's geometry to
 * the destination's, and cross over while they do. Where the two look the same,
 * the cross is invisible and the object simply moves and resizes; where they
 * differ — new words, a new colour — it becomes the other on the way.
 *
 * With no pairs it is a crossfade **and says so**.
 */
const morph: TransitionKindDefinition = {
  name: "morph",
  description: "Paired elements travel between the slides; the rest crossfades.",
  showsBothSlides: true,
  plan: ({ deltas, easing }) => {
    const base = fade.plan({ deltas, easing, direction: "left" }).tracks;
    if (deltas.length === 0) {
      return {
        tracks: base,
        warning:
          "This morph has no paired elements, so it was drawn as a crossfade. " +
          "Pair the elements that should travel, or turn on automatic pairing.",
      };
    }

    const tracks: TransitionTrack[] = [...base];
    for (const delta of deltas) {
      const arriving = `pair:in:${delta.destinationId}`;
      const leaving = `pair:out:${delta.sourceId}`;

      // The arriving copy starts drawn over the source and settles where it
      // lives. The leaving copy starts where it was and ends drawn over the
      // destination — the inverse mapping, so both are on one path at every
      // instant rather than two objects near each other.
      tracks.push({
        targetId: arriving,
        kind: "paired",
        easing,
        keyframes: [
          { offset: 0, properties: placement(delta.from, delta.to, delta.scaleX, delta.scaleY, delta.rotate) },
          { offset: 1, properties: placement(delta.to, delta.to, 1, 1, 0) },
        ],
      });
      tracks.push({
        targetId: leaving,
        kind: "paired",
        easing,
        keyframes: [
          { offset: 0, properties: placement(delta.from, delta.from, 1, 1, 0) },
          {
            offset: 1,
            properties: placement(delta.to, delta.from, inverse(delta.scaleX), inverse(delta.scaleY), -delta.rotate),
          },
        ],
      });

      // The cross, on its own linear clock. Separate from the movement because
      // a track's easing applies within each pair of keyframes: a third
      // keyframe in the movement track would make the object brake to a stop
      // halfway and set off again. The arriving copy is fully there by the
      // midpoint while the leaving one is still whole beneath it, so nothing
      // ever dips to half-transparent — two identical copies at half opacity
      // each read as a flicker.
      tracks.push({
        targetId: arriving,
        kind: "paired",
        easing: "linear",
        keyframes: [
          { offset: 0, properties: { opacity: 0 } },
          { offset: 0.5, properties: { opacity: 1 } },
          { offset: 1, properties: { opacity: 1 } },
        ],
      });
      tracks.push({
        targetId: leaving,
        kind: "paired",
        easing: "linear",
        keyframes: [
          { offset: 0, properties: { opacity: 1 } },
          { offset: 0.5, properties: { opacity: 1 } },
          { offset: 1, properties: { opacity: 0 } },
        ],
      });
    }

    return { tracks };
  },
};

function inverse(scale: number): number {
  return scale === 0 ? 1 : Math.round((1 / scale) * 1000) / 1000;
}

/**
 * The longhands that draw an element whose matching point is `own` so that it
 * lands on `target`, scaled and rotated about that point.
 *
 * The renderer places every element with `transform-origin` at the slide's own
 * origin (its world matrix is emitted once, from 0,0), and CSS applies
 * `translate`, `rotate` and `scale` about that same origin. Scaling by `s` there
 * also moves the element: something at x = 1000 scaled by 0.5 lands at x = 500.
 * The first morph ignored that, so a resizing pair started in the wrong place
 * and swooped. Solving `target = t + R·S·own` for `t` puts it where it belongs,
 * and because `t` is then linear in the scale, interpolating the two ends
 * keeps the point on a straight line for the whole transition.
 */
function placement(
  target: { x: number; y: number },
  own: { x: number; y: number },
  scaleX: number,
  scaleY: number,
  rotate: number,
): Record<string, string | number> {
  const radians = (rotate * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = own.x * scaleX;
  const sy = own.y * scaleY;
  const tx = target.x - (cos * sx - sin * sy);
  const ty = target.y - (sin * sx + cos * sy);
  return {
    translateX: `${Math.round(tx * 1000) / 1000}px`,
    translateY: `${Math.round(ty * 1000) / 1000}px`,
    scaleX,
    scaleY,
    rotate: `${rotate}deg`,
  };
}

/** Every transition this build can draw, by name. */
export const TRANSITION_KINDS: Record<string, TransitionKindDefinition> = {
  cut,
  fade,
  slide,
  push,
  zoom,
  morph,
};

export const TRANSITION_KIND_NAMES = Object.keys(TRANSITION_KINDS);

/**
 * Look a kind up, degrading to a fade and saying so.
 *
 * The schema keeps unknown transition types (doc 02 §0.8), so a v2 deck opened
 * in this build must still advance. Refusing would strand the deck on a slide;
 * cutting silently would look like the transition was ignored.
 */
export function resolveTransitionKind(name: string): {
  kind: TransitionKindDefinition;
  degraded?: string;
} {
  const found = TRANSITION_KINDS[name];
  if (found) return { kind: found };
  return {
    kind: fade,
    degraded: `"${name}" is not a transition this build can draw, so it was faded instead.`,
  };
}
