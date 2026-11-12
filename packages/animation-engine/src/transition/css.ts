/**
 * The one place a transition becomes CSS.
 *
 * Kept apart from the sampler on purpose. `sample.ts` answers "what is true at
 * `t`" in numbers, which a video export, a test and a headless render all need;
 * this turns those numbers into the string a browser wants. Mixing them would
 * make the engine's output only usable by a DOM — which is the mistake doc 04
 * §23.1 warns about when it argues against handing interpolation to WAAPI.
 *
 * Longhands, always. The renderer already puts a base `transform` on an element,
 * and a `transform:` shorthand written here would erase it — sending the element
 * to the slide origin mid-transition, which reads as the content being thrown
 * away rather than moved.
 */

import { easingToCss, round } from "../easing";
import type { CompiledTransition } from "./types";
import { sampleTransition } from "./sample";

/** Properties that compose into `translate`, in the order CSS expects them. */
const TRANSLATE = ["translateX", "translateY"] as const;
const SCALE = ["scaleX", "scaleY"] as const;

/**
 * Sampled styles as a CSS declaration block for one target.
 *
 * `translateX`/`translateY` and `scaleX`/`scaleY` are folded into the `translate`
 * and `scale` longhands, because those are what the animation adapter already
 * writes and two mechanisms setting the same visual property is how one silently
 * wins.
 */
export function transitionCss(
  transition: CompiledTransition,
  t: number,
): Record<string, Record<string, string>> {
  const sampled = sampleTransition(transition, t);
  const out: Record<string, Record<string, string>> = {};

  for (const [targetId, properties] of Object.entries(sampled)) {
    const declaration: Record<string, string> = {};

    const translate = TRANSLATE.map((name) => properties[name]).filter((value) => value !== undefined);
    if (translate.length > 0) declaration.translate = translate.map(String).join(" ");

    const scale = SCALE.map((name) => properties[name]).filter((value) => value !== undefined);
    if (scale.length > 0) declaration.scale = scale.map(String).join(" ");

    for (const [name, value] of Object.entries(properties)) {
      if ((TRANSLATE as readonly string[]).includes(name)) continue;
      if ((SCALE as readonly string[]).includes(name)) continue;
      if (name === "clipInset") {
        declaration.clipPath = `inset(0 ${value}% 0 0)`;
        continue;
      }
      if (name === "clipRadius") {
        declaration.clipPath = `circle(${value}% at 50% 50%)`;
        continue;
      }
      if (name === "clipSweep") {
        declaration.clipPath = sweepPolygon(Number(value));
        continue;
      }
      if (name === "rotateY") {
        declaration.rotate = `y ${value}deg`;
        continue;
      }
      if (name === "rotateX") {
        declaration.rotate = `x ${value}deg`;
        continue;
      }
      if (name === "behind") {
        // Which slide is in front, as a whole number: a fractional z-index is
        // not a value a browser accepts, and one it ignores leaves the last
        // frame's order in place.
        declaration.zIndex = Number(value) >= 0.5 ? "-1" : "0";
        continue;
      }
      if (name === "blur") {
        // Written at zero too. Skipping it left the previous frame's blur on
        // the element, so a slide that had resolved into focus stayed a
        // fraction of a pixel soft.
        declaration.filter = Number(value) > 0 ? `blur(${value}px)` : "none";
        continue;
      }
      declaration[name] = String(value);
    }

    out[targetId] = declaration;
  }

  return out;
}

/** Where the sweep passes each corner of the box, clockwise from twelve. */
const SWEEP_CORNERS: readonly (readonly [number, string])[] = [
  [45, "100% 0%"],
  [135, "100% 100%"],
  [225, "0% 100%"],
  [315, "0% 0%"],
];

/**
 * The part of a box a clock hand has swept, as a `clip-path`.
 *
 * Measured in the box's own proportions, so the hand passes each corner at an
 * eighth of a turn whatever the slide's aspect ratio: a true angle on a 16:9
 * slide would spend most of the sweep on the two short sides. The vertex count
 * changes as corners are passed, which a browser could not interpolate; nothing
 * asks it to, because every frame is sampled and written whole.
 */
export function sweepPolygon(degrees: number): string {
  const angle = Number.isFinite(degrees) ? Math.max(0, Math.min(360, degrees)) : 0;
  if (angle >= 360) return "none";
  // An empty shape, not `none`: nothing has been uncovered yet.
  if (angle <= 0) return "polygon(50% 50%, 50% 50%, 50% 50%)";

  const points = ["50% 50%", "50% 0%"];
  for (const [at, corner] of SWEEP_CORNERS) {
    if (angle > at) points.push(corner);
  }
  const radians = (angle * Math.PI) / 180;
  const x = Math.sin(radians);
  const y = -Math.cos(radians);
  const reach = 50 / Math.max(Math.abs(x), Math.abs(y));
  points.push(`${round(50 + x * reach)}% ${round(50 + y * reach)}%`);
  return `polygon(${points.join(", ")})`;
}

/** The easing, as a browser wants it. The compiled form carries the name. */
export function transitionEasingCss(transition: CompiledTransition): string {
  return easingToCss(transition.easing);
}
