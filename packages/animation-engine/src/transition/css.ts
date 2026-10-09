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

import { easingToCss } from "../easing";
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
      if (name === "rotateY") {
        declaration.rotate = `y ${value}deg`;
        continue;
      }
      if (name === "blur") {
        if (Number(value) > 0) declaration.filter = `blur(${value}px)`;
        continue;
      }
      declaration[name] = String(value);
    }

    out[targetId] = declaration;
  }

  return out;
}

/** The easing, as a browser wants it. The compiled form carries the name. */
export function transitionEasingCss(transition: CompiledTransition): string {
  return easingToCss(transition.easing);
}
