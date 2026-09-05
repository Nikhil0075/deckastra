import type { CornerRadius, ShapeKind } from "@deckastra/presentation-schema";

/**
 * Shape geometry (doc 04 §7.2).
 *
 * Every shape resolves to an SVG path, rectangles included. Uniformity is the
 * point: hit testing, export and masking all consume one representation, so none
 * of them needs a per-shape special case that can drift from the others.
 *
 * Paths are emitted in the element's own coordinate space (0,0 to width,height).
 * `customPath` arrives normalized 0..1 (doc 02 §13.2) and is scaled here.
 */

export interface ShapeGeometry {
  pathData: string;
  /** True when the renderer should emit a <rect> instead — rounded corners are
   *  far cheaper and crisper as a native rect than as a path approximation. */
  preferRect: boolean;
  /** Set when the shape itself dictates a radius regardless of style, as a pill
   *  does. Overrides the element's cornerRadius. */
  radiusOverride?: number;
}

function n(value: number): number {
  return Number(value.toFixed(3));
}

function polygonPath(points: readonly [number, number][]): string {
  return (
    points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${n(x)},${n(y)}`).join(" ") + " Z"
  );
}

function regularPolygon(cx: number, cy: number, rx: number, ry: number, sides: number): string {
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    // Start at -90deg so a polygon points upward, which is what everyone expects
    // when they draw a pentagon.
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return polygonPath(points);
}

function starPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  points: number,
  innerRatio: number,
): string {
  const out: [number, number][] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const outer = i % 2 === 0;
    const r = outer ? 1 : innerRatio;
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    out.push([cx + rx * r * Math.cos(angle), cy + ry * r * Math.sin(angle)]);
  }
  return polygonPath(out);
}

/** Scale a normalized 0..1 path into the element box (doc 02 §13.2). */
export function scaleNormalizedPath(pathData: string, width: number, height: number): string {
  let axis = 0;
  return pathData.replace(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g, (match) => {
    const value = Number(match);
    const scaled = axis % 2 === 0 ? value * width : value * height;
    axis += 1;
    return String(n(scaled));
  });
}

export function cornerRadiusToNumber(radius: CornerRadius | undefined): number {
  if (radius === undefined) return 0;
  if (typeof radius === "number") return radius;
  // A single <rect> cannot express four different corners; the caller falls back
  // to a path (and PPTX export rasterizes it — doc 02 §11.1).
  return Math.max(radius.topLeft, radius.topRight, radius.bottomRight, radius.bottomLeft);
}

export function hasUniformCorners(radius: CornerRadius | undefined): boolean {
  if (radius === undefined) return true;
  if (typeof radius === "number") return true;
  const { topLeft, topRight, bottomRight, bottomLeft } = radius;
  return topLeft === topRight && topRight === bottomRight && bottomRight === bottomLeft;
}

export interface ShapeGeometryInput {
  shape: ShapeKind | string;
  width: number;
  height: number;
  pathData?: string;
  points?: number;
  innerRadius?: number;
  cornerRadius?: CornerRadius;
}

export function shapeGeometry(input: ShapeGeometryInput): ShapeGeometry {
  const { shape, width: w, height: h } = input;
  const cx = w / 2;
  const cy = h / 2;

  switch (shape) {
    case "rectangle":
      return {
        pathData: polygonPath([
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ]),
        preferRect: hasUniformCorners(input.cornerRadius),
      };

    case "ellipse": {
      const rx = cx;
      const ry = cy;
      return {
        pathData:
          `M${n(cx - rx)},${n(cy)} ` +
          `a${n(rx)},${n(ry)} 0 1,0 ${n(rx * 2)},0 ` +
          `a${n(rx)},${n(ry)} 0 1,0 ${n(-rx * 2)},0 Z`,
        preferRect: false,
      };
    }

    case "pill":
      return {
        pathData: polygonPath([
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ]),
        preferRect: true,
        radiusOverride: Math.min(w, h) / 2,
      };

    case "triangle":
      return {
        pathData: polygonPath([
          [cx, 0],
          [w, h],
          [0, h],
        ]),
        preferRect: false,
      };

    case "diamond":
      return {
        pathData: polygonPath([
          [cx, 0],
          [w, cy],
          [cx, h],
          [0, cy],
        ]),
        preferRect: false,
      };

    case "parallelogram": {
      const skew = w * 0.2;
      return {
        pathData: polygonPath([
          [skew, 0],
          [w, 0],
          [w - skew, h],
          [0, h],
        ]),
        preferRect: false,
      };
    }

    case "chevron": {
      const notch = w * 0.25;
      return {
        pathData: polygonPath([
          [0, 0],
          [w - notch, 0],
          [w, cy],
          [w - notch, h],
          [0, h],
          [notch, cy],
        ]),
        preferRect: false,
      };
    }

    case "arrow": {
      const headWidth = Math.min(w * 0.4, h);
      const shaft = h * 0.3;
      return {
        pathData: polygonPath([
          [0, cy - shaft],
          [w - headWidth, cy - shaft],
          [w - headWidth, 0],
          [w, cy],
          [w - headWidth, h],
          [w - headWidth, cy + shaft],
          [0, cy + shaft],
        ]),
        preferRect: false,
      };
    }

    case "speechBubble": {
      const tail = Math.min(h * 0.2, 24);
      const body = h - tail;
      return {
        pathData: polygonPath([
          [0, 0],
          [w, 0],
          [w, body],
          [w * 0.3, body],
          [w * 0.2, h],
          [w * 0.22, body],
          [0, body],
        ]),
        preferRect: false,
      };
    }

    case "polygon":
      return {
        pathData: regularPolygon(cx, cy, cx, cy, Math.max(3, input.points ?? 6)),
        preferRect: false,
      };

    case "star":
      return {
        pathData: starPath(cx, cy, cx, cy, Math.max(3, input.points ?? 5), input.innerRadius ?? 0.4),
        preferRect: false,
      };

    case "customPath":
      return {
        // An empty box rather than a crash: pathData is required for customPath and
        // the validator reports its absence, but the renderer must not blank a slide
        // over one bad element.
        pathData: input.pathData ? scaleNormalizedPath(input.pathData, w, h) : "",
        preferRect: false,
      };

    default:
      // An unrecognized shape kind is preserved by the schema (open enum) and
      // degrades to a rectangle here, per doc 02 §0.8.
      return {
        pathData: polygonPath([
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ]),
        preferRect: true,
      };
  }
}
