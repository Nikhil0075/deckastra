import type { BrandIcon, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

/**
 * An uploaded SVG, reduced to an icon (design review, 2026-09-27).
 *
 * An SVG is markup someone else wrote arriving in a document other people will
 * open, so this reads it as an allowlist rather than cleaning it: only the
 * geometry of `path`, `circle`, `ellipse`, `rect`, `line`, `polyline` and
 * `polygon` is taken, as numbers and path commands, and nothing else of the
 * file survives — no elements, attributes, styles, scripts or links. The
 * result is plain data the schema checks again (`BrandIconSchema`), so a deck
 * carrying one is as safe to email as one that does not.
 *
 * What it cannot draw faithfully it refuses and says why, rather than drawing
 * something else: a transform (flatten it first), a gradient or pattern, a
 * picture inside the SVG, or text.
 */

export const MAX_SVG_BYTES = 200_000;
const MAX_SHAPES = 200;
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\-+\s]+$/;
const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
/** Containers whose children are read; anything else is skipped or refused. */
const CONTAINERS = new Set(["svg", "g", "defs", "title", "desc", "metadata"]);
const REFUSED: Record<string, string> = {
  image: "it contains a picture",
  text: "it contains text; convert text to outlines first",
  lineargradient: "it uses a gradient",
  radialgradient: "it uses a gradient",
  pattern: "it uses a pattern",
  use: "it reuses shapes by reference; expand them first",
  foreignobject: "it contains HTML",
  script: "it contains a script",
  mask: "it uses a mask",
  clippath: "it clips shapes to other shapes",
  filter: "it uses a filter effect",
};

/** Attributes that make a shape draw with something other than its own geometry and one colour. */
const REFERENCING = ["fill", "stroke", "clip-path", "mask", "filter"];

export type SvgIconResult = { ok: true; icon: BrandIcon } | { ok: false; reason: string };

export function parseSvgIcon(text: string): SvgIconResult {
  if (text.length > MAX_SVG_BYTES) return { ok: false, reason: `The file is larger than ${Math.round(MAX_SVG_BYTES / 1000)} KB.` };
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { ok: false, reason: "The file declares a document type, which an icon has no need of." };
  let root: Element | null;
  try {
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    if (parsed.getElementsByTagName("parsererror").length) return { ok: false, reason: "This is not a readable SVG file." };
    root = parsed.documentElement;
  } catch {
    return { ok: false, reason: "This is not a readable SVG file." };
  }
  if (!root || root.localName.toLowerCase() !== "svg") return { ok: false, reason: "This is not an SVG file." };

  // The whole file, not only what is drawn: a gradient or pattern is usually
  // declared in <defs> and used by reference, so refusing it only where it
  // appears in the drawing lets the common case through.
  for (const element of Array.from(root.getElementsByTagName("*"))) {
    const name = element.localName.toLowerCase();
    if (REFUSED[name]) return { ok: false, reason: `This SVG cannot be used as an icon: ${REFUSED[name]}.` };
    for (const attribute of REFERENCING) {
      const direct = element.getAttribute(attribute) ?? "";
      const styled = element.getAttribute("style")?.match(new RegExp(`(?:^|;)\\s*${attribute}\\s*:\\s*([^;]+)`))?.[1] ?? "";
      if (/url\(/i.test(direct) || /url\(/i.test(styled)) {
        const what = attribute === "fill" || attribute === "stroke" ? "a gradient or pattern" : attribute === "clip-path" ? "clipping" : `a ${attribute}`;
        return { ok: false, reason: `This SVG cannot be used as an icon: it uses ${what}. Use flat colours only.` };
      }
    }
  }

  const box = viewBoxOf(root);
  if (!box) return { ok: false, reason: "The SVG has no size (no viewBox, width or height)." };

  const paths: string[] = [];
  const circles: [number, number, number][] = [];
  let filled = 0;
  let stroked = 0;
  let problem: string | undefined;

  const visit = (element: Element, inherited: { fill?: string; stroke?: string }) => {
    if (problem) return;
    const name = element.localName.toLowerCase();
    if (REFUSED[name]) {
      problem = `This SVG cannot be used as an icon: ${REFUSED[name]}.`;
      return;
    }
    const transform = element.getAttribute("transform");
    if (transform && !/^\s*(translate\(\s*0([\s,]+0)?\s*\)|scale\(\s*1([\s,]+1)?\s*\)|matrix\(\s*1[\s,]+0[\s,]+0[\s,]+1[\s,]+0[\s,]+0\s*\))?\s*$/.test(transform)) {
      problem = "This SVG uses transforms; flatten them first (in most editors, convert every object to a path).";
      return;
    }
    const paint = {
      fill: attribute(element, "fill") ?? inherited.fill,
      stroke: attribute(element, "stroke") ?? inherited.stroke,
    };
    if (CONTAINERS.has(name)) {
      if (name === "defs" || name === "title" || name === "desc" || name === "metadata") return;
      for (const child of Array.from(element.children)) visit(child, paint);
      return;
    }
    if (!SHAPES.has(name)) return;
    if (paths.length + circles.length >= MAX_SHAPES) {
      problem = `This SVG has more than ${MAX_SHAPES} shapes; an icon should be simpler.`;
      return;
    }
    const drawn = shapeOf(element, name);
    if (!drawn) return;
    if ("circle" in drawn) circles.push(drawn.circle);
    else if (PATH.test(drawn.d)) paths.push(drawn.d.replace(/\s+/g, " ").trim());
    else {
      problem = "A path in this SVG uses something other than drawing commands.";
      return;
    }
    // SVG's default is a black fill and no stroke, so a shape that says
    // nothing is filled.
    const fill = paint.fill ?? "black";
    const stroke = paint.stroke ?? "none";
    if (fill !== "none") filled += 1;
    if (stroke !== "none") stroked += 1;
  };
  visit(root, {});
  if (problem) return { ok: false, reason: problem };
  if (paths.length + circles.length === 0) return { ok: false, reason: "This SVG has no shapes to draw." };

  // A square grid, with the drawing centred in it, so the icon sits in its box
  // the way every other icon does.
  const size = Math.max(box.width, box.height);
  const dx = (size - box.width) / 2 - box.x;
  const dy = (size - box.height) / 2 - box.y;
  const shifted = dx || dy ? paths.map((d) => translatePath(d, dx, dy)) : paths;
  const icon: BrandIcon = {
    viewBox: round(size),
    paths: shifted,
    ...(circles.length ? { circles: circles.map(([cx, cy, r]) => [round(cx + dx), round(cy + dy), round(r)] as [number, number, number]) } : {}),
    ...(filled >= stroked ? { fill: true } : {}),
  };
  return { ok: true, icon };
}

/** A name for an uploaded icon from its file name, unique among the theme's. */
export function brandIconName(document: PresentationDocument, fileName: string): string {
  const base =
    fileName
      .replace(/\.svg$/i, "")
      .replace(/[./~]+/g, " ")
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .slice(0, 50) || "Icon";
  const taken = new Set(Object.keys(document.theme.icons ?? {}).map((name) => name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
  return name;
}

export function addBrandIconOperations(document: PresentationDocument, name: string, icon: BrandIcon): PatchOperation[] {
  const escaped = name.replace(/~/g, "~0").replace(/\//g, "~1");
  return document.theme.icons ? [{ op: "add", path: `/theme/icons/${escaped}`, value: icon }] : [{ op: "add", path: "/theme/icons", value: { [name]: icon } }];
}

export function removeBrandIconOperations(document: PresentationDocument, name: string): PatchOperation[] {
  if (!(document.theme.icons ?? {})[name]) return [];
  if (Object.keys(document.theme.icons ?? {}).length === 1) return [{ op: "remove", path: "/theme/icons" }];
  return [{ op: "remove", path: `/theme/icons/${name.replace(/~/g, "~0").replace(/\//g, "~1")}` }];
}

// ------------------------------------------------------------------ helpers

function attribute(element: Element, name: "fill" | "stroke"): string | undefined {
  const direct = element.getAttribute(name);
  // Only the one declaration is read from a style attribute; the rest of it is ignored.
  const style = element.getAttribute("style")?.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1];
  const value = (style ?? direct)?.trim().toLowerCase();
  return value || undefined;
}

function viewBoxOf(root: Element): { x: number; y: number; width: number; height: number } | undefined {
  const raw = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (raw && raw.length === 4 && raw.every(Number.isFinite) && raw[2]! > 0 && raw[3]! > 0) return { x: raw[0]!, y: raw[1]!, width: raw[2]!, height: raw[3]! };
  const width = parseFloat(root.getAttribute("width") ?? "");
  const height = parseFloat(root.getAttribute("height") ?? "");
  return width > 0 && height > 0 ? { x: 0, y: 0, width, height } : undefined;
}

function n(element: Element, name: string): number {
  const value = parseFloat(element.getAttribute(name) ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function shapeOf(element: Element, name: string): { d: string } | { circle: [number, number, number] } | undefined {
  switch (name) {
    case "path": {
      const d = element.getAttribute("d");
      return d ? { d } : undefined;
    }
    case "circle":
      return n(element, "r") > 0 ? { circle: [n(element, "cx"), n(element, "cy"), n(element, "r")] } : undefined;
    case "ellipse": {
      const [cx, cy, rx, ry] = [n(element, "cx"), n(element, "cy"), n(element, "rx"), n(element, "ry")];
      if (rx <= 0 || ry <= 0) return undefined;
      return { d: `M${round(cx - rx)} ${round(cy)}a${round(rx)} ${round(ry)} 0 1 0 ${round(2 * rx)} 0a${round(rx)} ${round(ry)} 0 1 0 ${round(-2 * rx)} 0Z` };
    }
    case "rect": {
      const [x, y, w, h] = [n(element, "x"), n(element, "y"), n(element, "width"), n(element, "height")];
      if (w <= 0 || h <= 0) return undefined;
      const r = Math.min(n(element, "rx") || n(element, "ry"), w / 2, h / 2);
      if (!r) return { d: `M${round(x)} ${round(y)}h${round(w)}v${round(h)}h${round(-w)}Z` };
      return {
        d:
          `M${round(x + r)} ${round(y)}h${round(w - 2 * r)}a${round(r)} ${round(r)} 0 0 1 ${round(r)} ${round(r)}v${round(h - 2 * r)}` +
          `a${round(r)} ${round(r)} 0 0 1 ${round(-r)} ${round(r)}h${round(-(w - 2 * r))}a${round(r)} ${round(r)} 0 0 1 ${round(-r)} ${round(-r)}` +
          `v${round(-(h - 2 * r))}a${round(r)} ${round(r)} 0 0 1 ${round(r)} ${round(-r)}Z`,
      };
    }
    case "line":
      return { d: `M${round(n(element, "x1"))} ${round(n(element, "y1"))}L${round(n(element, "x2"))} ${round(n(element, "y2"))}` };
    case "polyline":
    case "polygon": {
      const values = (element.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (values.length < 4) return undefined;
      const pairs: string[] = [];
      for (let i = 0; i + 1 < values.length; i += 2) pairs.push(`${round(values[i]!)} ${round(values[i + 1]!)}`);
      return { d: `M${pairs.join("L")}${name === "polygon" ? "Z" : ""}` };
    }
    default:
      return undefined;
  }
}

/**
 * Move a path by (dx, dy): absolute coordinates shift, relative ones do not.
 * Enough for centring on a square grid; arcs keep their radii and flags.
 */
function translatePath(d: string, dx: number, dy: number): string {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const out: string[] = [];
  let command = "";
  let index = 0;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  for (const token of tokens) {
    if (/^[a-zA-Z]$/.test(token)) {
      command = token;
      index = 0;
      out.push(token);
      continue;
    }
    const value = Number(token);
    const upper = command.toUpperCase();
    const absolute = command === upper;
    const position = index % (arity[upper] || 1);
    let shifted = value;
    if (absolute) {
      if (upper === "H") shifted = value + dx;
      else if (upper === "V") shifted = value + dy;
      else if (upper === "A") shifted = position === 5 ? value + dx : position === 6 ? value + dy : value;
      else shifted = position % 2 === 0 ? value + dx : value + dy;
    }
    out.push(String(round(shifted)));
    index += 1;
  }
  return out.join(" ").replace(/ ([a-zA-Z]) /g, "$1").trim();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
