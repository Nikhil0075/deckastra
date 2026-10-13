import type { MaskDefinition, MaskPart } from "@deckastra/presentation-schema";
import { shapeGeometry } from "./shapes";

/**
 * Image masks (2026-10-13).
 *
 * A mask resolves, once, in the scene build, to outline paths in the element's
 * own box (0,0 to width,height), with its rotation applied and every arc and
 * quadratic turned into cubic curves. The canvas, thumbnails, the PDF and the
 * PowerPoint exporter all read those same paths, so a mask cannot draw one
 * shape on screen and another in a file.
 *
 * Cubics only, because both consumers speak them: an SVG mask draws them and
 * DrawingML's `custGeom` has `cubicBezTo`, so PowerPoint receives the curve
 * itself rather than a polyline approximation.
 *
 * The photograph is never rotated by a mask: the outline turns about the box's
 * centre and the picture behind it stays where its fit and focal point put it.
 */

export interface ImageMaskPayload {
  /** Outlines in element space. The picture shows wherever any of them does. */
  paths: string[];
  /** Keep what lies outside the outlines instead. */
  invert: boolean;
  /**
   * The PowerPoint preset this outline is exactly, when there is one: a
   * picture cropped to a preset stays an ordinary, re-editable crop there.
   */
  preset?: { geometry: "ellipse" } | { geometry: "roundRect"; radius: number };
}

export interface ResolvedMask {
  mask?: ImageMaskPayload;
  /** Said when a mask was asked for and is not drawn as asked. */
  warning?: string;
}

type Point = { x: number; y: number };
type Segment =
  | { op: "M" | "L"; to: Point }
  | { op: "C"; c1: Point; c2: Point; to: Point }
  | { op: "Z" };

/** The cubic control distance that draws a quarter circle (4/3·tan(π/8)). */
const KAPPA = 0.5522847498;

const round = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

// ------------------------------------------------------------------- parsing

/**
 * An SVG path as absolute M, L, C and Z only.
 *
 * H, V, S, Q and T become their L or C equivalents; an arc becomes cubic
 * segments of at most a quarter turn each, which is exact to well under a
 * pixel at slide sizes.
 */
export function cubicPath(d: string): Segment[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let command = "";
  let current: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastCubic: Point | undefined;
  let lastQuad: Point | undefined;
  const number = () => Number(tokens[i++]);
  const more = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]!);

  const quadratic = (c: Point, to: Point) => {
    out.push({
      op: "C",
      c1: { x: current.x + (2 / 3) * (c.x - current.x), y: current.y + (2 / 3) * (c.y - current.y) },
      c2: { x: to.x + (2 / 3) * (c.x - to.x), y: to.y + (2 / 3) * (c.y - to.y) },
      to,
    });
  };

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) command = tokens[i++]!;
    const relative = command === command.toLowerCase();
    const at = (x: number, y: number): Point => (relative ? { x: current.x + x, y: current.y + y } : { x, y });
    const upper = command.toUpperCase();
    if (upper === "Z") {
      out.push({ op: "Z" });
      current = start;
      lastCubic = lastQuad = undefined;
      continue;
    }
    if (!more()) break;
    switch (upper) {
      case "M":
        current = at(number(), number());
        start = current;
        out.push({ op: "M", to: current });
        command = relative ? "l" : "L";
        lastCubic = lastQuad = undefined;
        break;
      case "L":
        current = at(number(), number());
        out.push({ op: "L", to: current });
        lastCubic = lastQuad = undefined;
        break;
      case "H": {
        const x = number();
        current = { x: relative ? current.x + x : x, y: current.y };
        out.push({ op: "L", to: current });
        lastCubic = lastQuad = undefined;
        break;
      }
      case "V": {
        const y = number();
        current = { x: current.x, y: relative ? current.y + y : y };
        out.push({ op: "L", to: current });
        lastCubic = lastQuad = undefined;
        break;
      }
      case "C": {
        const c1 = at(number(), number());
        const c2 = at(number(), number());
        const to = at(number(), number());
        out.push({ op: "C", c1, c2, to });
        lastCubic = c2;
        lastQuad = undefined;
        current = to;
        break;
      }
      case "S": {
        const c1 = lastCubic ? { x: 2 * current.x - lastCubic.x, y: 2 * current.y - lastCubic.y } : current;
        const c2 = at(number(), number());
        const to = at(number(), number());
        out.push({ op: "C", c1, c2, to });
        lastCubic = c2;
        lastQuad = undefined;
        current = to;
        break;
      }
      case "Q": {
        const c = at(number(), number());
        const to = at(number(), number());
        quadratic(c, to);
        lastQuad = c;
        lastCubic = undefined;
        current = to;
        break;
      }
      case "T": {
        const c = lastQuad ? { x: 2 * current.x - lastQuad.x, y: 2 * current.y - lastQuad.y } : current;
        const to = at(number(), number());
        quadratic(c, to);
        lastQuad = c;
        lastCubic = undefined;
        current = to;
        break;
      }
      case "A": {
        const rx = Math.abs(number());
        const ry = Math.abs(number());
        const phi = number();
        const large = number() !== 0;
        const sweep = number() !== 0;
        const to = at(number(), number());
        out.push(...arcCubics(current, to, rx, ry, phi, large, sweep));
        current = to;
        lastCubic = lastQuad = undefined;
        break;
      }
      default:
        // An unknown command: skip its numbers rather than misread them.
        while (more()) i += 1;
    }
  }
  return out;
}

/** SVG's endpoint arc (SVG 1.1 §F.6.5) as cubics of at most 90° each. */
function arcCubics(from: Point, to: Point, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean): Segment[] {
  if (rxIn === 0 || ryIn === 0) return [{ op: "L", to }];
  if (from.x === to.x && from.y === to.y) return [];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  let rx = rxIn;
  let ry = ryIn;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const factor = sign * Math.sqrt(Math.max(0, numerator / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (factor * rx * y1) / ry;
  const cy1 = (-factor * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  // A point on the ellipse at parameter t, and its derivative.
  const point = (t: number): Point => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  });
  const tangent = (t: number): Point => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  });
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Segment[] = [];
  for (let index = 0; index < steps; index += 1) {
    const a = theta + step * index;
    const b = a + step;
    const p0 = point(a);
    const p3 = point(b);
    const d0 = tangent(a);
    const d3 = tangent(b);
    out.push({
      op: "C",
      c1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y },
      c2: { x: p3.x - k * d3.x, y: p3.y - k * d3.y },
      to: index === steps - 1 ? to : p3,
    });
  }
  return out;
}

function transform(segments: Segment[], map: (p: Point) => Point): Segment[] {
  return segments.map((segment) => {
    switch (segment.op) {
      case "Z":
        return segment;
      case "C":
        return { op: "C", c1: map(segment.c1), c2: map(segment.c2), to: map(segment.to) };
      default:
        return { op: segment.op, to: map(segment.to) };
    }
  });
}

function serialize(segments: Segment[]): string {
  const p = (point: Point) => `${round(point.x)},${round(point.y)}`;
  return segments
    .map((segment) => {
      switch (segment.op) {
        case "Z":
          return "Z";
        case "C":
          return `C${p(segment.c1)} ${p(segment.c2)} ${p(segment.to)}`;
        default:
          return `${segment.op}${p(segment.to)}`;
      }
    })
    .join(" ");
}

const drawable = (segments: Segment[]) => segments.some((segment) => segment.op === "L" || segment.op === "C");

// ------------------------------------------------------------------- outlines

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return (
    `M${cx - rx},${cy} ` +
    `C${cx - rx},${cy - ky} ${cx - kx},${cy - ry} ${cx},${cy - ry} ` +
    `C${cx + kx},${cy - ry} ${cx + rx},${cy - ky} ${cx + rx},${cy} ` +
    `C${cx + rx},${cy + ky} ${cx + kx},${cy + ry} ${cx},${cy + ry} ` +
    `C${cx - kx},${cy + ry} ${cx - rx},${cy + ky} ${cx - rx},${cy} Z`
  );
}

interface Corners {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

function cornersOf(radius: number | Record<string, number>, w: number, h: number): Corners {
  const read = (key: keyof Corners) => (typeof radius === "number" ? radius : Number(radius[key] ?? 0));
  // CSS's rule: corners that would overlap are scaled down together.
  const raw = { topLeft: read("topLeft"), topRight: read("topRight"), bottomRight: read("bottomRight"), bottomLeft: read("bottomLeft") };
  for (const key of Object.keys(raw) as (keyof Corners)[]) raw[key] = Math.max(0, Number.isFinite(raw[key]) ? raw[key] : 0);
  const scale = Math.min(
    1,
    w / Math.max(1e-9, raw.topLeft + raw.topRight),
    w / Math.max(1e-9, raw.bottomLeft + raw.bottomRight),
    h / Math.max(1e-9, raw.topLeft + raw.bottomLeft),
    h / Math.max(1e-9, raw.topRight + raw.bottomRight),
  );
  return {
    topLeft: raw.topLeft * scale,
    topRight: raw.topRight * scale,
    bottomRight: raw.bottomRight * scale,
    bottomLeft: raw.bottomLeft * scale,
  };
}

function roundedPath(w: number, h: number, c: Corners): string {
  const k = 1 - KAPPA;
  return (
    `M${c.topLeft},0 L${w - c.topRight},0 ` +
    `C${w - c.topRight * k},0 ${w},${c.topRight * k} ${w},${c.topRight} ` +
    `L${w},${h - c.bottomRight} ` +
    `C${w},${h - c.bottomRight * k} ${w - c.bottomRight * k},${h} ${w - c.bottomRight},${h} ` +
    `L${c.bottomLeft},${h} ` +
    `C${c.bottomLeft * k},${h} 0,${h - c.bottomLeft * k} 0,${h - c.bottomLeft} ` +
    `L0,${c.topLeft} ` +
    `C0,${c.topLeft * k} ${c.topLeft * k},0 ${c.topLeft},0 Z`
  );
}

/** A semicircular top over straight sides; flattened when the box is too short. */
function archPath(w: number, h: number): string {
  const rx = w / 2;
  const ry = Math.min(rx, h);
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return (
    `M0,${h} L0,${ry} ` +
    `C0,${ry - ky} ${rx - kx},0 ${rx},0 ` +
    `C${rx + kx},0 ${w},${ry - ky} ${w},${ry} ` +
    `L${w},${h} Z`
  );
}

/** A fixed organic outline, normalized 0..1, so every renderer draws the same edge. */
const BLOB =
  "M0.55,0.04 C0.72,0 0.9,0.08 0.95,0.26 C1,0.42 0.88,0.5 0.9,0.64 C0.93,0.82 0.8,0.98 0.6,0.96 " +
  "C0.46,0.95 0.4,0.86 0.27,0.9 C0.12,0.95 0,0.82 0.03,0.64 C0.06,0.48 0.18,0.44 0.12,0.3 " +
  "C0.06,0.12 0.3,0.08 0.55,0.04 Z";

/**
 * A torn-paper rectangle: ragged top and bottom edges from a fixed sequence,
 * never a random one, so the tear is the same on every open and in every file.
 */
const TEAR = [0.6, 0.15, 0.85, 0.35, 0.05, 0.7, 0.45, 0.95, 0.25, 0.55, 0.1, 0.8, 0.4, 0.65, 0.2, 0.9, 0.3, 0.75, 0.5, 0.0];
function tornPath(w: number, h: number): string {
  const depth = Math.min(h * 0.06, 18);
  const teeth = TEAR.length;
  const top = TEAR.map((value, index) => `L${(w * (index + 1)) / (teeth + 1)},${depth * value}`).join(" ");
  const bottom = TEAR.map((value, index) => `L${w - (w * (index + 1)) / (teeth + 1)},${h - depth * (1 - value)}`).join(" ");
  return `M0,${depth * 0.5} ${top} L${w},${depth * 0.4} L${w},${h - depth * 0.6} ${bottom} L0,${h - depth * 0.3} Z`;
}

function partOutline(part: MaskPart, w: number, h: number): { d?: string; unknown?: string } {
  switch (part.type) {
    case "ellipse":
      return { d: ellipsePath(w / 2, h / 2, w / 2, h / 2) };
    case "rounded":
      return { d: roundedPath(w, h, cornersOf(part.radius as number | Record<string, number>, w, h)) };
    case "path": {
      // Normalized 0..1 to the box (doc 02 §13.2), like a custom shape.
      const segments = transform(cubicPath(part.pathData), (p) => ({ x: p.x * w, y: p.y * h }));
      return { d: serialize(segments) };
    }
    case "shape": {
      switch (part.shape) {
        case "circle": {
          const r = Math.min(w, h) / 2;
          return { d: ellipsePath(w / 2, h / 2, r, r) };
        }
        case "ellipse":
          return { d: ellipsePath(w / 2, h / 2, w / 2, h / 2) };
        case "pill":
          return { d: roundedPath(w, h, cornersOf(Math.min(w, h) / 2, w, h)) };
        case "arch":
          return { d: archPath(w, h) };
        case "blob":
          return { d: serialize(transform(cubicPath(BLOB), (p) => ({ x: p.x * w, y: p.y * h }))) };
        case "torn":
          return { d: tornPath(w, h) };
        case "triangle":
        case "diamond":
        case "star":
        case "polygon":
        case "chevron":
        case "parallelogram":
        case "speechBubble":
          return {
            d: shapeGeometry({ shape: part.shape, width: w, height: h, points: part.points ?? (part.shape === "polygon" ? 6 : undefined) }).pathData,
          };
        default:
          return { unknown: String(part.shape) };
      }
    }
  }
}

/**
 * Resolve an image's mask to outlines in its box. Anything that cannot be
 * drawn as asked is drawn unmasked and says why — a picture silently losing
 * its arch is a slide that no longer looks like the one the author made.
 */
export function resolveImageMask(mask: MaskDefinition | undefined, width: number, height: number): ResolvedMask {
  if (!mask) return {};
  const w = Math.max(1, width);
  const h = Math.max(1, height);

  if (mask.type === "shapeRef") {
    return { warning: "This picture's mask borrows another object's outline, which this version cannot draw yet, so the picture is shown without it." };
  }

  const parts: MaskPart[] = mask.type === "compound" ? mask.parts : [mask];
  const outer = mask.rotation ?? 0;
  const paths: string[] = [];
  for (const part of parts) {
    const outline = partOutline(part, w, h);
    if (outline.unknown) {
      return { warning: `The mask shape "${outline.unknown}" is not known to this version, so the picture is shown without it.` };
    }
    let segments = cubicPath(outline.d ?? "");
    if (!drawable(segments)) {
      return { warning: "This picture's mask outline is empty, so the picture is shown without it." };
    }
    const degrees = outer + (mask.type === "compound" ? part.rotation ?? 0 : 0);
    if (degrees % 360 !== 0) {
      const radians = (degrees * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const cx = w / 2;
      const cy = h / 2;
      segments = transform(segments, (p) => ({
        x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
        y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
      }));
    }
    paths.push(serialize(segments));
  }

  const invert = mask.invert === true;
  const result: ImageMaskPayload = { paths, invert };
  const single = mask.type === "compound" ? undefined : mask;
  if (single && !invert && (single.rotation ?? 0) % 360 === 0) {
    if (single.type === "ellipse" || (single.type === "shape" && single.shape === "ellipse")) {
      result.preset = { geometry: "ellipse" };
    } else if (single.type === "shape" && single.shape === "pill") {
      result.preset = { geometry: "roundRect", radius: round(Math.min(w, h) / 2) };
    } else if (single.type === "rounded" && typeof single.radius === "number") {
      result.preset = { geometry: "roundRect", radius: round(Math.min(single.radius, w / 2, h / 2)) };
    }
  }
  return { mask: result };
}

/**
 * The mask as a CSS `mask-image` value: an SVG the size of the box, stretched
 * to it. The picture shows where the SVG is opaque. Inverted, the outlines are
 * cut out of a full box with an SVG mask, which keeps overlapping parts a
 * single hole rather than toggling them back in as an even-odd fill would.
 *
 * `feather` softens the edge over that many pixels (`edgeFeather`). Without a
 * mask the outline is the box, inset by the feather so the picture fades to
 * nothing exactly at its edge rather than half a feather outside it.
 */
export function maskImageCss(mask: ImageMaskPayload | undefined, width: number, height: number, feather = 0): string {
  const w = round(Math.max(1, width));
  const h = round(Math.max(1, height));
  const soft = Math.max(0, Math.min(feather, w / 2, h / 2));
  const outline: ImageMaskPayload =
    mask ?? { paths: [`M${round(soft)},${round(soft)} L${round(w - soft)},${round(soft)} L${round(w - soft)},${round(h - soft)} L${round(soft)},${round(h - soft)} Z`], invert: false };
  const shapes = outline.paths.map((d) => `<path d="${d}"/>`).join("");
  // Two-thirds of the feather as the blur's spread reaches about the whole
  // feather visibly; a standard deviation of the full width looks twice as soft.
  const filter = soft > 0
    ? `<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${round((soft * 2) / 3)}"/></filter>`
    : "";
  const blur = soft > 0 ? ' filter="url(#f)"' : "";
  const body = outline.invert
    ? `<defs>${filter}<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="#fff"/><g fill="#000"${blur}>${shapes}</g></mask></defs>` +
      `<rect width="${w}" height="${h}" fill="#000" mask="url(#m)"/>`
    : `${filter ? `<defs>${filter}</defs>` : ""}<g fill="#000"${blur}>${shapes}</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
