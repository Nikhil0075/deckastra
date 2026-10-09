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

import type {
  CustomMotionPreset,
  Keyframe,
  PropertyTrack,
} from "@deckastra/presentation-schema";

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
  /** Optional path element named by `params.pathElementId`. */
  path?: { id: string; bounds: { x: number; y: number; width: number; height: number } };
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
  category: "entrance" | "emphasis" | "loop" | "exit" | "path";
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

export type CustomPresetCatalog = Readonly<Record<string, CustomMotionPreset>>;

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
  category: "entrance",
  reducedMotion: "fade",
  description: "Appears by fading in.",
  params: [],
  expand: () => ({ tracks: [track("opacity", FADE_IN)] }),
};

const slide: PresetDefinition = {
  name: "slide",
  category: "entrance",
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
  category: "entrance",
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
  category: "entrance",
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
  category: "entrance",
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
  category: "entrance",
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
  category: "path",
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
  category: "entrance",
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
  category: "entrance",
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
  category: "entrance",
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

// ------------------------------------------------------- emphasis and loops

function simplePreset(
  name: string,
  category: PresetDefinition["category"],
  description: string,
  tracks: PropertyTrack[],
  reducedMotion: string = category === "loop" ? "instant" : "fade",
): PresetDefinition {
  return { name, category, description, reducedMotion, params: [], expand: () => ({ tracks }) };
}

const pulse = simplePreset("pulse", "emphasis", "Briefly grows and settles.", [
  track("scale", [{ offset: 0, value: 1 }, { offset: 0.5, value: 1.08 }, { offset: 1, value: 1 }]),
]);
const wiggle = simplePreset("wiggle", "emphasis", "Rocks gently from side to side.", [
  track("rotation", [{ offset: 0, value: 0 }, { offset: 0.25, value: -4 }, { offset: 0.75, value: 4 }, { offset: 1, value: 0 }]),
]);
const pop = simplePreset("pop", "emphasis", "Pops forward and returns to rest.", [
  track("scale", [{ offset: 0, value: 1 }, { offset: 0.4, value: 1.14 }, { offset: 1, value: 1 }]),
  track("opacity", [{ offset: 0, value: 1 }, { offset: 0.4, value: 0.88 }, { offset: 1, value: 1 }]),
]);
const colorShift = simplePreset("colorShift", "emphasis", "Shifts to an accent colour and back.", [
  track("fill", [{ offset: 0, value: "currentColor" }, { offset: 0.5, value: "var(--dk-accent, currentColor)" }, { offset: 1, value: "currentColor" }]),
]);
const underlineDraw = simplePreset("underlineDraw", "emphasis", "Draws the target stroke for emphasis.", [
  track("pathProgress", [{ offset: 0, value: 0 }, { offset: 1, value: 1 }]),
], "instant");
const highlightSweep = simplePreset("highlightSweep", "emphasis", "Sweeps a lightweight highlight across the object.", [
  track("x", [{ offset: 0, value: -12 }, { offset: 1, value: 12 }]),
  track("opacity", [{ offset: 0, value: 0.72 }, { offset: 0.5, value: 1 }, { offset: 1, value: 0.72 }]),
]);
const shake = simplePreset("shake", "emphasis", "Shakes quickly from side to side and returns to rest.", [
  track("x", [
    { offset: 0, value: 0 },
    { offset: 0.2, value: -8 },
    { offset: 0.4, value: 8 },
    { offset: 0.6, value: -6 },
    { offset: 0.8, value: 4 },
    { offset: 1, value: 0 },
  ]),
]);

const moveAlongPath: PresetDefinition = {
  name: "moveAlongPath",
  category: "path",
  reducedMotion: "instant",
  description: "Moves along a declared path vector while retaining a portable final frame.",
  params: [
    { name: "pathElementId", kind: "string" },
    { name: "deltaX", kind: "number", default: 160 },
    { name: "deltaY", kind: "number", default: 0 },
  ],
  expand: ({ params, path }) => {
    const requestedPath = stringParam(params, "pathElementId", "");
    return {
      tracks: [
        track("x", [
          { offset: 0, value: 0 },
          { offset: 1, value: round(numberParam(params, "deltaX", path?.bounds.width ?? 160)) },
        ]),
        track("y", [
          { offset: 0, value: 0 },
          { offset: 1, value: round(numberParam(params, "deltaY", path?.bounds.height ?? 0)) },
        ]),
      ],
      warning: requestedPath && !path
        ? `The path element ${requestedPath} was not found, so the preset used its portable fallback vector.`
        : undefined,
    };
  },
};

const float = simplePreset("float", "loop", "Drifts gently up and down.", [
  track("y", [{ offset: 0, value: 0 }, { offset: 0.5, value: -10 }, { offset: 1, value: 0 }]),
]);
const breathe = simplePreset("breathe", "loop", "Breathes with a small scale and opacity change.", [
  track("scale", [{ offset: 0, value: 1 }, { offset: 0.5, value: 1.035 }, { offset: 1, value: 1 }]),
  track("opacity", [{ offset: 0, value: 0.94 }, { offset: 0.5, value: 1 }, { offset: 1, value: 0.94 }]),
]);
const spin = simplePreset("spin", "loop", "Turns slowly through one revolution.", [
  track("rotation", [{ offset: 0, value: 0 }, { offset: 1, value: 360 }]),
]);
const glow = simplePreset("glow", "loop", "Pulses a prepared glow layer using opacity only.", [
  track("opacity", [{ offset: 0, value: 0.78 }, { offset: 0.5, value: 1 }, { offset: 1, value: 0.78 }]),
]);
const shimmer: PresetDefinition = {
  name: "shimmer",
  category: "loop",
  reducedMotion: "instant",
  description: "Sweeps a prepared sheen layer across the object.",
  params: [],
  expand: ({ bounds }) => {
    // Travel far enough for the sheen to enter and leave the object entirely.
    // The old fixed ±24px movement was nearly static on cards and large text.
    const travel = Math.max(48, round(bounds.width * 0.75));
    return {
      tracks: [
        track("x", [{ offset: 0, value: -travel }, { offset: 1, value: travel }]),
        track("opacity", [
          { offset: 0, value: 0 },
          { offset: 0.15, value: 0.7 },
          { offset: 0.85, value: 0.7 },
          { offset: 1, value: 0 },
        ]),
      ],
    };
  },
};
const orbit = simplePreset("orbit", "loop", "Moves in a small orbit around the resting position.", [
  track("x", [{ offset: 0, value: 0 }, { offset: 0.25, value: 8 }, { offset: 0.5, value: 0 }, { offset: 0.75, value: -8 }, { offset: 1, value: 0 }]),
  track("y", [{ offset: 0, value: -6 }, { offset: 0.25, value: 0 }, { offset: 0.5, value: 6 }, { offset: 0.75, value: 0 }, { offset: 1, value: -6 }]),
]);
const kenBurns = simplePreset("kenBurns", "loop", "Slowly pans and zooms a picture.", [
  track("scale", [{ offset: 0, value: 1 }, { offset: 1, value: 1.08 }]),
  track("x", [{ offset: 0, value: -8 }, { offset: 1, value: 8 }]),
]);
const gradientDrift = simplePreset("gradientDrift", "loop", "Drifts a prepared gradient layer.", [
  track("x", [{ offset: 0, value: -16 }, { offset: 1, value: 16 }]),
  track("opacity", [{ offset: 0, value: 0.92 }, { offset: 0.5, value: 1 }, { offset: 1, value: 0.92 }]),
]);
const marquee = simplePreset("marquee", "loop", "Moves content steadily across its lane.", [
  track("x", [{ offset: 0, value: 0 }, { offset: 1, value: -120 }]),
]);

function exitPreset(name: string, source: PresetDefinition, description: string): PresetDefinition {
  return {
    name,
    category: "exit",
    reducedMotion: "instant",
    description,
    params: source.params,
    expand: (context) => {
      const expanded = source.expand(context);
      const reverse = (tracks: PropertyTrack[]) => tracks.map((property) => ({
        ...property,
        keyframes: property.keyframes.map((frame) => ({ ...frame, offset: round(1 - frame.offset) })).reverse(),
      }));
      return {
        ...expanded,
        tracks: reverse(expanded.tracks),
        children: expanded.children?.map((child) => ({ ...child, tracks: reverse(child.tracks) })),
      };
    },
  };
}

const byWord = { ...fade, name: "byWord", category: "entrance" as const, description: "Reveals text one word at a time." };
const byLetter = { ...fade, name: "byLetter", category: "entrance" as const, description: "Reveals text one grapheme at a time." };
const typewriter = { ...fade, name: "typewriter", category: "entrance" as const, description: "Types text in grapheme by grapheme." };
const lineByLine = { ...fade, name: "lineByLine", category: "entrance" as const, description: "Reveals text one line at a time." };
const wordCascade = simplePreset("wordCascade", "entrance", "Cascades words upward into place.", [
  track("opacity", FADE_IN),
  track("y", [{ offset: 0, value: 12 }, { offset: 1, value: 0 }]),
]);
const rotatingWord = simplePreset("rotatingWord", "emphasis", "Rotates a changing word through the text slot.", [
  track("y", [{ offset: 0, value: 0 }, { offset: 0.5, value: -8 }, { offset: 1, value: 0 }]),
  // An emphasis must return to the authored resting state. Ending at zero made
  // the entire text box disappear permanently and hid any child word effects.
  track("opacity", [{ offset: 0, value: 1 }, { offset: 0.5, value: 0.45 }, { offset: 1, value: 1 }]),
]);

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
  pulse,
  wiggle,
  pop,
  colorShift,
  underlineDraw,
  highlightSweep,
  shake,
  moveAlongPath,
  float,
  breathe,
  spin,
  glow,
  shimmer,
  orbit,
  kenBurns,
  gradientDrift,
  marquee,
  byWord,
  byLetter,
  typewriter,
  lineByLine,
  wordCascade,
  rotatingWord,
  fadeOut: exitPreset("fadeOut", fade, "Fades out."),
  slideOut: exitPreset("slideOut", slide, "Moves out of the slide."),
  scaleOut: exitPreset("scaleOut", scale, "Shrinks out of view."),
  blurOut: exitPreset("blurOut", blurReveal, "Blurs out of view."),
  maskOut: exitPreset("maskOut", maskReveal, "Wipes out of view."),
  wipeOut: exitPreset("wipeOut", maskReveal, "Wipes out of view."),
  staggerOut: exitPreset("staggerOut", staggerReveal, "Removes children one after another."),
  drawPathOut: exitPreset("drawPathOut", drawPath, "Erases a drawn path."),
  numberCountOut: exitPreset("numberCountOut", numberCount, "Counts away from the displayed number."),
  springOut: exitPreset("springOut", springIn, "Springs away from rest."),
  sharedElementMorphOut: exitPreset("sharedElementMorphOut", sharedElementMorph, "Moves out toward a paired element."),
};

export const PRESET_NAMES = Object.keys(PRESETS);
/** The frozen catalog used by the web editor. */
export const LEGACY_PRESET_NAMES = [
  "fade", "slide", "scale", "blurReveal", "maskReveal", "staggerReveal",
  "drawPath", "numberCount", "springIn", "sharedElementMorph",
] as const;

/**
 * Look a preset up, degrading to `fade` and saying so.
 *
 * The schema keeps unknown preset names (doc 02 §0.8), so a v2 deck opened here
 * must still animate. Refusing would delete motion the author wrote; drawing
 * nothing would look like a broken slide.
 */
export function resolvePreset(
  name: string,
  customPresets?: CustomPresetCatalog,
): { preset: PresetDefinition; degraded?: string } {
  const found = PRESETS[name];
  if (found) return { preset: found };
  const custom = customPresets?.[name];
  if (custom) {
    return {
      preset: {
        name,
        category: custom.category ?? "entrance",
        description: custom.description ?? `Theme motion preset ${name}.`,
        reducedMotion: custom.reducedMotion ?? "instant",
        params: [],
        expand: () => ({ tracks: custom.propertyTracks }),
      },
    };
  }
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
