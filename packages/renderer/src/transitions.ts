/**
 * Slide transitions (doc 02 §26, doc 04 §27).
 *
 * Resolved here rather than in the present-mode component so that there is one
 * definition of what "push from the left over 400ms" means. Present mode, the
 * editor's preview and — when it lands — the video export all read this, and a
 * transition that looks different in the export than in the room is the kind of
 * bug that is only found in the room.
 *
 * Two rules the resolution encodes:
 *
 * - A transition type this build cannot draw degrades to a fade and *says so*.
 *   The schema keeps unknown types (doc 02 §0.8), so a v2 deck opened in a v1
 *   reader must still advance.
 * - Reduced motion is resolved here, not left to a media query on one keyframe.
 *   A presenter who asked their OS for less motion gets a cut, and the caller
 *   can see that it happened.
 */

export type TransitionDirection = "left" | "right" | "up" | "down";

export interface ResolvedTransition {
  /** The type actually drawn. */
  type: string;
  requestedType: string;
  durationMs: number;
  easing: string;
  /** CSS `@keyframes` body for the incoming slide, or undefined for a cut. */
  keyframes?: string;
  /** Name to reference the keyframes by. Stable for a given resolution. */
  name: string;
  degraded?: string;
}

const DRAWABLE = new Set(["cut", "fade", "slide", "zoom", "push"]);

/** Cubic-bezier for the named easings the schema allows. */
const EASING: Record<string, string> = {
  linear: "linear",
  ease: "ease",
  easeIn: "cubic-bezier(0.42, 0, 1, 1)",
  easeOut: "cubic-bezier(0, 0, 0.58, 1)",
  easeInOut: "cubic-bezier(0.42, 0, 0.58, 1)",
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
};

function offsetFor(direction: TransitionDirection, distance: string): string {
  switch (direction) {
    case "left":
      return `translateX(${distance})`;
    case "right":
      return `translateX(-${distance})`;
    case "up":
      return `translateY(${distance})`;
    default:
      return `translateY(-${distance})`;
  }
}

export interface TransitionInput {
  type?: string;
  durationMs?: number;
  easing?: string;
  direction?: TransitionDirection;
}

export function resolveTransition(
  transition: TransitionInput | undefined,
  options: { reducedMotion?: boolean } = {},
): ResolvedTransition {
  const requestedType = transition?.type ?? "fade";
  const direction = transition?.direction ?? "left";
  const easing = EASING[transition?.easing ?? "easeOut"] ?? "ease-out";

  if (options.reducedMotion) {
    // Not a shortened fade — none. Halving the duration of something a viewer
    // asked not to see is not an accommodation.
    return {
      type: "cut",
      requestedType,
      durationMs: 0,
      easing,
      name: "deckastra-cut",
      degraded: requestedType === "cut" ? undefined : "Reduced motion is on, so slides cut.",
    };
  }

  let type = requestedType;
  let degraded: string | undefined;

  if (!DRAWABLE.has(type)) {
    // morph, mask and custom need shared-element pairing and a timeline, which
    // is Phase 7. Fading is the honest stand-in; silently cutting would look
    // like the transition was ignored.
    degraded = `"${requestedType}" transitions are not drawn yet; faded instead.`;
    type = "fade";
  }

  const durationMs = type === "cut" ? 0 : (transition?.durationMs ?? 300);

  if (type === "cut" || durationMs === 0) {
    return { type: "cut", requestedType, durationMs: 0, easing, name: "deckastra-cut", degraded };
  }

  const name = `deckastra-${type}-${direction}`;

  const keyframes =
    type === "fade"
      ? "from { opacity: 0; } to { opacity: 1; }"
      : type === "zoom"
        ? "from { opacity: 0; transform: scale(1.06); } to { opacity: 1; transform: scale(1); }"
        : type === "slide"
          ? `from { transform: ${offsetFor(direction, "100%")}; } to { transform: translate(0, 0); }`
          : // push moves a shorter distance and fades, so the outgoing slide is not
            // simply covered — it reads as one deck moving rather than two images.
            `from { opacity: 0; transform: ${offsetFor(direction, "8%")}; } to { opacity: 1; transform: translate(0, 0); }`;

  return { type, requestedType, durationMs, easing, keyframes, name, degraded };
}

/**
 * Every keyframes block a deck needs, emitted once.
 *
 * Deduplicated by name so a 60-slide deck with one transition style produces one
 * rule rather than sixty.
 */
export function transitionStylesheet(transitions: readonly ResolvedTransition[]): string {
  const seen = new Map<string, string>();
  for (const transition of transitions) {
    if (transition.keyframes) seen.set(transition.name, transition.keyframes);
  }
  return [...seen]
    .map(([name, body]) => `@keyframes ${name} { ${body} }`)
    .join("\n");
}
