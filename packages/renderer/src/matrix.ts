import type { Point, Rect, Transform } from "@deckastra/presentation-schema";

/**
 * 2D affine transforms (doc 04 §8.2, §12.1).
 *
 * Stored in the same six-component form CSS uses, so emitting a matrix costs no
 * conversion:
 *
 *     | a  c  e |
 *     | b  d  f |
 *     | 0  0  1 |
 */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Compare with a tolerance of 0.01 logical px (doc 04 §4.4) — float drift is
 *  expected and exact equality would make snapping and caching misbehave. */
export const EPSILON = 0.01;

export function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** `a` then `b`, i.e. the matrix product a × b. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function translation(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function applyToPoint(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/**
 * Local transform for an element (doc 02 §10.1).
 *
 * `x, y` place the element's *unrotated* top-left in its parent's space, while
 * rotation and scale act about (originX, originY) as a fraction of the element's
 * own box. So the origin has to be translated to, transformed about, and
 * translated back from — doing it in the other order rotates about the corner and
 * makes every rotated element drift as it resizes.
 */
export function localMatrix(transform: Transform): Matrix {
  const {
    x,
    y,
    width,
    height,
    rotation = 0,
    scaleX = 1,
    scaleY = 1,
    originX = 0.5,
    originY = 0.5,
  } = transform;

  const ox = width * originX;
  const oy = height * originY;

  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  // translate(x + ox, y + oy) × rotate × scale × translate(-ox, -oy)
  const rotateScale: Matrix = {
    a: cos * scaleX,
    b: sin * scaleX,
    c: -sin * scaleY,
    d: cos * scaleY,
    e: 0,
    f: 0,
  };

  return multiply(
    multiply(translation(x + ox, y + oy), rotateScale),
    translation(-ox, -oy),
  );
}

/** Axis-aligned world bounds of a box under a transform: all four corners, then
 *  the extremes. Using only two corners is wrong the moment anything rotates. */
export function transformedBounds(m: Matrix, width: number, height: number): Rect {
  const corners = [
    applyToPoint(m, { x: 0, y: 0 }),
    applyToPoint(m, { x: width, y: 0 }),
    applyToPoint(m, { x: width, y: height }),
    applyToPoint(m, { x: 0, y: height }),
  ];

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** CSS `matrix()` form. */
export function toCss(m: Matrix): string {
  const n = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Number(v.toFixed(4)));
  return `matrix(${n(m.a)}, ${n(m.b)}, ${n(m.c)}, ${n(m.d)}, ${n(m.e)}, ${n(m.f)})`;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
