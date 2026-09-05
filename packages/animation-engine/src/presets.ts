/**
 * The MVP motion presets (doc 04 §24).
 *
 * A preset is **not opaque** (doc 04 §22.2). It is a pure function from
 * parameters to property tracks, which buys two things: the timeline can "open"
 * a preset into explicit keyframes so an author can tweak it — an ordinary patch
 * against `clip.propertyTracks` — and the expansion is testable with no renderer
 * and no browser.
 *
 * Every preset declares a reduced-motion fallback. Doc 04 §27.3 makes that a
 * build-time requirement rather than a convention, and `tests/presets.test.ts`
 * enforces it: reduced motion must never mean the content fails to appear.
 *
 * ## `x` and `y` are offsets, not positions
 *
 * Doc 04 §22.2's `blurReveal` sketch animates `y` from `node.bounds.y + 24` to
 * `node.bounds.y` — absolute positions — while §22.4 says `x`/`y` are applied as
 * the CSS `translate` longhand, which is a *delta* from where layout put the
 * element. The two cannot both be right. Offsets win here, for a reason beyond
 * consistency: an animation written as an offset survives the element being
 * moved, the slide being re-laid-out, or the container changing its padding. An
 * absolute one silently animates to the wrong place, and the failure appears as
 * an element that jumps at the end of its own entrance.
 */

import type { Keyframe, PropertyTrack } from "@deckastra/presentation-schema";

import { round, sampleSpring, type Spring } from "./easing";

/** What a preset knows about the thing it is animating. */
export interface PresetContext {
  /** Axis-aligned world bounds of the target. Used for distance defaults. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Resolved motion theme values, already defaulted for the deck's personality. */
  motion: { defaultDurationMs: number; defaultEasing: string; staggerMs: number };
  params: Record<string, unknown>;
  /** The clip's duration, so a spring knows how long it has to settle. */
  durationMs: number;
  /**
   * For `staggerReveal` only: the children to expand across, in the resolved
   * order. Empty for every other preset.
   */
  children?: { id: string; bounds: { x: number; y: number; width: number; height: number } }[];
}

/** A preset expansion. Child clips exist only for `staggerReveal`. */
export interface PresetExpansion {
  tracks: PropertyTrack[];
  /** Per-child tracks with their own delay, for stagger. */
  children?: { targetId: string; delayMs: number; tracks: PropertyTrack[] }[];
  /** Stated when the preset could not do what was asked and did something else. */
  warning?: string;
}

export interface PresetDefinition {
  name: string;
  /**
   * What this becomes under reduced motion (doc 04 §27.3). `"instant"` means the
   * end state with no transition — correct for `drawPath` (show it drawn) and
   * `numberCount` (show the final number), where a fade would be a different lie.
   */
  reducedMotion: string;
  /** Human-readable, for the motion panel. */
  description: string;
  /** Parameters the panel offers, in the order it should offer them. */
  params: { name: string; kind: "number" | "string" | "enum"; options?: string[]; default?: unknown }[];
  expand(context: PresetContext): PresetExpansion;
}

// ------------------------------------------------------------------ helpers

function numberParam(params: Record<string, unknown>, name: string, fallback: number): number {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringParam(params: Record<string, unknown>, name: string, fallback: string): string {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function track(property: PropertyTrack["property"], keyframes: Keyframe[]): PropertyTrack {
  return { property, keyframes };
}

const FADE_IN: Keyframe[] = [
  { offset: 0, value: 0 },
  { offset: 1, value: 1 },
];

/** The offsets a direction moves *from*, as a unit vector. */
function directionVector(direction: string): { x: number; y: number } {
  switch (direction) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "down":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: -1 };
  }
}

// ------------------------------------------------------------------ presets

const fade: PresetDefinition = {
  name: "fade",
  reducedMotion: "fade",
  description: "Appears by fading in.",
  params: [],
  expand: () => ({ tracks: [track("opacity", FADE_IN)] }),
};

const slide: PresetDefinition = {
  name: "slide",
  reducedMotion: "fade",
  description: "Moves in from one side while fading in.",
  params: [
    { name: "direction", kind: "enum", options: ["up", "down", "left", "right"], default: "up" },
    { name: "distance", kind: "number", default: 40 },
  ],
  expand: ({ params }) => {
    const vector = directionVector(stringParam(params, "direction", "up"));
    const distance = numberParam(params, "distance", 40);
    const tracks = [track("opacity", FADE_IN)];

    // Only the axis that moves gets a track. An `x` track of 0 → 0 is a property
    // the sampler has to resolve on every frame to produce no visible effect,
    // and it would collide with any other clip legitimately animating x.
    if (vector.x !== 0) {
      tracks.push(
        track("x", [
          { offset: 0, value: round(vector.x * distance) },
          { offset: 1, value: 0 },
        ]),
      );
    }
    if (vector.y !== 0) {
      tracks.push(
        track("y", [
          { offset: 0, value: round(vector.y * distance) },
          { offset: 1, value: 0 },
        ]),
      );
    }

    return { tracks };
  },
};

const scale: PresetDefinition = {
  name: "scale",
  reducedMotion: "fade",
  description: "Grows into place while fading in.",
  params: [
    { name: "from", kind: "number", default: 0.92 },
    { name: "origin", kind: "enum", options: ["center", "topLeft", "bottomRight"], default: "center" },
  ],
  expand: ({ params }) => ({
    tracks: [
      track("opacity", FADE_IN),
      track("scale", [
        { offset: 0, value: round(numberParam(params, "from", 0.92)) },
        { offset: 1, value: 1 },
      ]),
    ],
  }),
};

const blurReveal: PresetDefinition = {
  name: "blurReveal",
  reducedMotion: "fade",
  description: "Resolves from a blur while rising slightly.",
  params: [
    { name: "blur", kind: "number", default: 12 },
    { name: "distance", kind: "number", default: 24 },
  ],
  expand: ({ params }) => ({
    tracks: [
      track("opacity", FADE_IN),
      track("blur", [
        { offset: 0, value: round(numberParam(params, "blur", 12)) },
        { offset: 1, value: 0 },
      ]),
      track("y", [
        { offset: 0, value: round(numberParam(params, "distance", 24)) },
        { offset: 1, value: 0 },
      ]),
    ],
  }),
};

const maskReveal: PresetDefinition = {
  name: "maskReveal",
  reducedMotion: "fade",
  description: "Wipes into view behind a moving edge.",
  params: [
    { name: "direction", kind: "enum", options: ["up", "down", "left", "right"], default: "left" },
    { name: "softness", kind: "number", default: 0 },
  ],
  expand: ({ params }) => {
    // `clip` carries an inset as [top, right, bottom, left] percentages, which is
    // what the DOM adapter writes into `clip-path: inset()` and what a PPTX wipe
    // maps onto. A single number would not survive either.
    const direction = stringParam(params, "direction", "left");
    const closed: Record<string, number[]> = {
      left: [0, 100, 0, 0],
      right: [0, 0, 0, 100],
      up: [100, 0, 0, 0],
      down: [0, 0, 100, 0],
    };

    return {
      tracks: [
        track("clip", [
          { offset: 0, value: closed[direction] ?? closed.left },
          { offset: 1, value: [0, 0, 0, 0] },
        ]),
      ],
    };
  },
};

const staggerReveal: PresetDefinition = {
  name: "staggerReveal",
  reducedMotion: "fade",
  description: "Reveals a group's children one after another.",
  params: [
    { name: "childPreset", kind: "string", default: "slide" },
    { name: "staggerMs", kind: "number" },
    { name: "order", kind: "enum", options: ["reading", "sequence", "outsideIn", "custom"], default: "reading" },
  ],
  expand: (context) => {
    const children = context.children ?? [];
    const childPresetName = stringParam(context.params, "childPreset", "slide");
    const childPreset = PRESETS[childPresetName] ?? slide;
    const staggerMs = numberParam(context.params, "staggerMs", context.motion.staggerMs);

    if (children.length === 0) {
      // A stagger over nothing is a bug in the document, not a reason to fail:
      // the target animates as a whole with the child preset, and says so.
      return {
        tracks: childPreset.expand({ ...context, params: {} }).tracks,
        warning:
          "staggerReveal was applied to an element with no children, so it was " +
          `animated as a whole with ${childPresetName}.`,
      };
    }

    return {
      tracks: [],
      children: children.map((child, index) => ({
        targetId: child.id,
        delayMs: round(index * staggerMs),
        tracks: childPreset.expand({
          ...context,
          bounds: child.bounds,
          params: context.params,
          children: undefined,
        }).tracks,
      })),
    };
  },
};

const drawPath: PresetDefinition = {
  name: "drawPath",
  // Not a fade. A path that fades in is a different statement from one that
  // draws; under reduced motion the honest answer is the finished path.
  reducedMotion: "instant",
  description: "Draws a stroke from one end to the other.",
  params: [
    { name: "direction", kind: "enum", options: ["forward", "reverse"], default: "forward" },
  ],
  expand: ({ params }) => {
    const reverse = stringParam(params, "direction", "forward") === "reverse";
    return {
      tracks: [
        track("pathProgress", [
          { offset: 0, value: reverse ? 1 : 0 },
          { offset: 1, value: reverse ? 0 : 1 },
        ]),
      ],
    };
  },
};

const numberCount: PresetDefinition = {
  name: "numberCount",
  // The final number, not a fade. A metric that fades in from nothing reads as a
  // loading state; a metric that is simply there reads as a fact.
  reducedMotion: "instant",
  description: "Counts a number up to its final value.",
  params: [
    { name: "from", kind: "number", default: 0 },
    { name: "to", kind: "number" },
    { name: "format", kind: "string" },
  ],
  expand: ({ params }) => ({
    tracks: [
      track("numberValue", [
        { offset: 0, value: numberParam(params, "from", 0) },
        { offset: 1, value: numberParam(params, "to", 0) },
      ]),
    ],
  }),
};

const springIn: PresetDefinition = {
  name: "springIn",
  reducedMotion: "fade",
  description: "Settles into place with a spring.",
  params: [
    { name: "stiffness", kind: "number", default: 180 },
    { name: "damping", kind: "number", default: 14 },
    { name: "mass", kind: "number", default: 1 },
    { name: "distance", kind: "number", default: 24 },
  ],
  expand: ({ params, durationMs }) => {
    const spring: Spring = {
      stiffness: numberParam(params, "stiffness", 180),
      damping: numberParam(params, "damping", 14),
      mass: numberParam(params, "mass", 1),
    };
    const distance = numberParam(params, "distance", 24);

    // Sampled here, at build time. A live simulation cannot answer `seek(t)`
    // without having played the preceding frames (doc 04 §22.3).
    const progress = sampleSpring(spring, durationMs);

    return {
      tracks: [
        track("opacity", FADE_IN),
        track(
          "y",
          progress.map((sample) => ({
            offset: sample.offset,
            value: round(distance * (1 - sample.value)),
            // Linear between samples: the curve *is* the samples, and easing
            // between them would apply the shape twice.
            easing: "linear",
          })),
        ),
      ],
    };
  },
};

const sharedElementMorph: PresetDefinition = {
  name: "sharedElementMorph",
  reducedMotion: "fade",
  description: "Moves an element from where it was on the previous slide.",
  params: [
    { name: "sourceId", kind: "string" },
    { name: "targetId", kind: "string" },
  ],
  expand: ({ params, bounds }) => {
    // The pairing lives in the slide transition, so a clip on its own can only
    // express the destination half: start displaced by the recorded delta and
    // resolve to identity. The transition engine supplies the delta; without one
    // this degrades to a fade, which is what §24's fallback column says anyway.
    const dx = numberParam(params, "deltaX", 0);
    const dy = numberParam(params, "deltaY", 0);
    const fromScale = numberParam(params, "fromScale", 1);

    if (dx === 0 && dy === 0 && fromScale === 1) {
      return {
        tracks: [track("opacity", FADE_IN)],
        warning:
          "sharedElementMorph had no paired source, so it was drawn as a crossfade.",
      };
    }

    return {
      tracks: [
        track("x", [{ offset: 0, value: round(dx) }, { offset: 1, value: 0 }]),
        track("y", [{ offset: 0, value: round(dy) }, { offset: 1, value: 0 }]),
        track("scale", [{ offset: 0, value: round(fromScale) }, { offset: 1, value: 1 }]),
      ],
    };
  },
};

/** Every MVP preset, by name (doc 04 §24). */
export const PRESETS: Record<string, PresetDefinition> = {
  fade,
  slide,
  scale,
  blurReveal,
  maskReveal,
  staggerReveal,
  drawPath,
  numberCount,
  springIn,
  sharedElementMorph,
};

export const PRESET_NAMES = Object.keys(PRESETS);

/**
 * Look a preset up, degrading to `fade` and saying so.
 *
 * The schema keeps unknown preset names (doc 02 §0.8), so a v2 deck opened here
 * must still animate. Refusing would delete motion the author wrote; drawing
 * nothing would look like a broken slide.
 */
export function resolvePreset(name: string): { preset: PresetDefinition; degraded?: string } {
  const found = PRESETS[name];
  if (found) return { preset: found };
  return {
    preset: fade,
    degraded: `"${name}" is not a preset this build knows, so it was drawn as a fade.`,
  };
}

/**
 * Duration guidance by element scale (doc 04 §24.2). Used when a clip declares no
 * duration and the theme has no opinion either.
 */
export function durationForBounds(bounds: { width: number; height: number }): number {
  const area = bounds.width * bounds.height;
  if (area <= 40_000) return 280; // icon, chip, number
  if (area <= 400_000) return 450; // card, image, heading
  return 650; // full-bleed
}
