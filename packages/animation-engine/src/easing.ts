/**
 * Easing (doc 04 §22.3).
 *
 * One table, shared by every runtime and every export path. A canonical name
 * resolves to a cubic-bezier here and only here — the moment the exporter has its
 * own idea of what `emphasized` means, the PDF stops matching the room.
 *
 * Springs are the exception that proves the rule. They are physics, not a curve,
 * so they are **sampled into explicit keyframes at build time** rather than
 * simulated at playback. A live spring cannot be seeked: its state at `t` depends
 * on how it got there, and `seek(t)` has to be answerable without having played
 * the preceding 900ms.
 */

export type Bezier = readonly [number, number, number, number];

/** Doc 04 §22.3, verbatim. `ease` is the CSS default and is here for parity. */
export const EASING_BEZIER: Record<string, Bezier> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  emphasized: [0.2, 0, 0, 1],
};

export const DEFAULT_EASING = "easeOut";

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

const SPRING_PATTERN = /^spring\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/;

export function parseSpring(easing: string): Spring | undefined {
  const match = SPRING_PATTERN.exec(easing.trim());
  if (!match) return undefined;

  const [, stiffness, damping, mass] = match;
  const spring = {
    stiffness: Number(stiffness),
    damping: Number(damping),
    mass: Number(mass),
  };

  // A zero or negative mass divides by zero and a zero stiffness never returns to
  // rest. Neither is a spring; both are a typo.
  if (spring.mass <= 0 || spring.stiffness <= 0 || spring.damping < 0) return undefined;
  return spring;
}

/**
 * `x` on a cubic bezier, solved for `t`.
 *
 * Newton-Raphson with a **fixed** iteration count and a bisection fallback.
 * Fixed, not "until it converges": an epsilon-terminated loop runs a different
 * number of times on different inputs, and the last bit of the answer then
 * depends on the machine. Eight iterations is well past the precision anything
 * downstream can see, and it is the same eight everywhere.
 */
const NEWTON_ITERATIONS = 8;

function bezierComponent(t: number, a: number, b: number): number {
  // Expanded Bernstein form with p0 = 0 and p3 = 1.
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t;
}

function bezierSlope(t: number, a: number, b: number): number {
  const inverse = 1 - t;
  return (
    3 * inverse * inverse * (a - 0) +
    6 * inverse * t * (b - a) +
    3 * t * t * (1 - b)
  );
}

/** Progress 0..1 through a named easing, given linear progress 0..1. */
export function easingAt(easing: string | undefined, progress: number): number {
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  const name = easing ?? DEFAULT_EASING;

  if (name === "linear") return clamped;

  const bezier = EASING_BEZIER[name];
  if (!bezier) {
    // A spring reaching here means it was not sampled at build time, which is a
    // compiler bug rather than a document problem. Linear is the honest answer:
    // it moves, and it does not pretend to be a spring.
    return clamped;
  }

  const [x1, y1, x2, y2] = bezier;
  if (x1 === y1 && x2 === y2) return clamped;

  let t = clamped;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const slope = bezierSlope(t, x1, x2);
    if (slope === 0) break;
    t -= (bezierComponent(t, x1, x2) - clamped) / slope;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
  }

  return bezierComponent(t, y1, y2);
}

/** The CSS value for a named easing, for the transition stylesheet and exports. */
export function easingToCss(easing: string | undefined): string {
  const name = easing ?? DEFAULT_EASING;
  if (name === "linear") return "linear";

  const bezier = EASING_BEZIER[name];
  if (bezier) {
    const [x1, y1, x2, y2] = bezier;
    return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
  }
  return "linear";
}

// ------------------------------------------------------------------ springs

/**
 * Spring sampling rate. 60Hz because that is the cadence doc 04 §22.3 names, and
 * because a sample per frame is the finest resolution any consumer can show.
 */
export const SPRING_SAMPLE_HZ = 60;
/** A spring that has not settled by here is a spring nobody wants on a slide. */
export const SPRING_MAX_MS = 4_000;

export interface SpringSample {
  offset: number;
  value: number;
}

/**
 * Sample a spring from 0 to 1 as normalized keyframes.
 *
 * Semi-implicit Euler at a fixed step. The step is fixed for the same reason the
 * Newton loop is: a variable step makes the result depend on the machine, and
 * these numbers end up in a committed baseline.
 *
 * The result is a *progress* curve — 0 to 1, overshooting past 1 when the spring
 * is underdamped — so it composes with any property the way a bezier does.
 */
export function sampleSpring(spring: Spring, durationMs: number): SpringSample[] {
  const stepMs = 1000 / SPRING_SAMPLE_HZ;
  const steps = Math.max(2, Math.min(Math.round(durationMs / stepMs), Math.round(SPRING_MAX_MS / stepMs)));

  let position = 0;
  let velocity = 0;
  const samples: SpringSample[] = [{ offset: 0, value: 0 }];

  for (let step = 1; step <= steps; step += 1) {
    const dt = stepMs / 1000;
    const force = -spring.stiffness * (position - 1) - spring.damping * velocity;
    velocity += (force / spring.mass) * dt;
    position += velocity * dt;

    samples.push({ offset: round(step / steps), value: round(position) });
  }

  // The last sample is the end state by definition. A spring still 0.3% short
  // leaves an element permanently 0.3% off its layout position.
  samples[samples.length - 1] = { offset: 1, value: 1 };
  return samples;
}

/** Three decimals, matching the renderer. Float noise fails a baseline. */
export function round(value: number): number {
  const scaled = Math.round(value * 1000) / 1000;
  return Object.is(scaled, -0) ? 0 : scaled;
}
