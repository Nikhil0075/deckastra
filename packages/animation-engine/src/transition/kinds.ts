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
 * With no pairs it is a crossfade **and says so**. Drawing nothing would look
 * like a broken deck, and drawing a morph of nothing is not a thing; the author
 * asked for a relationship the slides do not currently express, and the honest
 * answer names that rather than quietly substituting a fade.
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

    const paired: TransitionTrack[] = deltas.map((delta) => ({
      targetId: delta.destinationId,
      kind: "paired" as const,
      easing,
      keyframes: [
        {
          offset: 0,
          properties: {
            translateX: `${delta.dx}px`,
            translateY: `${delta.dy}px`,
            scaleX: delta.scaleX,
            scaleY: delta.scaleY,
            rotate: `${delta.rotate}deg`,
            opacity: delta.fadeFrom,
          },
        },
        {
          offset: 1,
          properties: {
            translateX: "0px",
            translateY: "0px",
            scaleX: 1,
            scaleY: 1,
            rotate: "0deg",
            opacity: delta.fadeTo,
          },
        },
      ],
    }));

    return { tracks: [...base, ...paired] };
  },
};

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
