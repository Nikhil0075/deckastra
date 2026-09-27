/**
 * Tables, charts and diagrams in PowerPoint (doc 04 §33.2).
 *
 * These used to be labelled placeholder boxes: an honest report line, and a
 * PowerPoint file with the author's numbers missing from it. The scene already
 * carries everything needed — a chart's plot, bars, arcs, ticks and labels, a
 * diagram's node boxes and edge paths, a table's cells — resolved to concrete
 * numbers precisely so an export adapter can draw what the editor drew rather
 * than re-deriving it (doc 04 §33, "charts are geometry in the scene").
 *
 * - **A table is a native table** (`a:tbl`): a recipient edits cells in
 *   PowerPoint the way they would their own.
 * - **A chart is drawn**: a group of real shapes and text boxes, placed from the
 *   scene's geometry. It looks like the chart and every label is editable text,
 *   but it is not a PowerPoint chart object with a data sheet — so the report
 *   says `approximated`, not nothing.
 * - **A diagram is drawn**: nodes as labelled rectangles (editable text inside
 *   the shape), edges as paths with arrowheads, groups as outlined boxes.
 *
 * Payload coordinates are local to the element's box; every mark is placed
 * through the node's world matrix, the same one the renderer uses.
 */

import type { SceneNode } from "@deckastra/renderer";

import type { ShapeContext } from "./shapes";
import { alpha, hex, rotation, shapeName, xml, type Units } from "./units";

// ------------------------------------------------------------------ geometry

interface Placement {
  /** Uniform scale from local payload px to world px. */
  scale: number;
  /** Degrees. */
  rotate: number;
  map(x: number, y: number): { x: number; y: number };
}

function placementOf(node: SceneNode): Placement {
  const m = node.worldTransform;
  const scale = Math.hypot(m.a, m.b) || 1;
  const degrees = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  return {
    scale,
    rotate: Math.abs(degrees) < 0.01 ? 0 : degrees,
    map: (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }),
  };
}

/** The xfrm for a local box: its centre carried by the matrix, its size scaled. */
function frame(box: { x: number; y: number; width: number; height: number }, place: Placement, units: Units): string {
  const centre = place.map(box.x + box.width / 2, box.y + box.height / 2);
  const width = Math.max(1, box.width * place.scale);
  const height = Math.max(1, box.height * place.scale);
  const rot = place.rotate ? ` rot="${rotation(place.rotate)}"` : "";
  return (
    `<a:xfrm${rot}><a:off x="${units.px(centre.x - width / 2)}" y="${units.px(centre.y - height / 2)}"/>` +
    `<a:ext cx="${units.px(width)}" cy="${units.px(height)}"/></a:xfrm>`
  );
}

function solid(color: string | undefined, opacity?: number): string {
  if (!color || color === "none" || color === "transparent") return "<a:noFill/>";
  const a = alpha(opacity ?? alphaOf(color));
  return `<a:solidFill><a:srgbClr val="${hex(color)}">${a === undefined ? "" : `<a:alpha val="${a}"/>`}</a:srgbClr></a:solidFill>`;
}

/** The alpha of an `rgba()` colour, which `hex()` discards. */
function alphaOf(color: string): number | undefined {
  const match = /^rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,/]+([\d.]+)\s*\)$/.exec(color.trim());
  return match ? Number(match[1]) : undefined;
}

function outline(
  color: string | undefined,
  width: number,
  units: Units,
  extra: { dash?: string; opacity?: number; head?: boolean; tail?: boolean; roundCap?: boolean } = {},
): string {
  if (!color || width <= 0) return "<a:ln><a:noFill/></a:ln>";
  const dash = extra.dash ? `<a:prstDash val="${dashPreset(extra.dash)}"/>` : "";
  // DrawingML's `tailEnd` is the path's last point, `headEnd` its first — the
  // SVG `markerEnd` / `markerStart` respectively.
  const ends = `${extra.head ? '<a:headEnd type="triangle"/>' : ""}${extra.tail ? '<a:tailEnd type="triangle"/>' : ""}`;
  const cap = extra.roundCap ? ' cap="rnd"' : "";
  return `<a:ln w="${units.px(width)}"${cap}>${solid(color, extra.opacity)}${dash}<a:round/>${ends}</a:ln>`;
}

function dashPreset(dash: string): string {
  const [on = 0, off = 0] = dash.split(/[\s,]+/).map(Number);
  return on <= off / 2 ? "sysDot" : "dash";
}

// --------------------------------------------------------------- SVG paths

type Point = { x: number; y: number };
type Segment =
  | { op: "M" | "L"; to: Point }
  | { op: "C"; c1: Point; c2: Point; to: Point }
  | { op: "Q"; c: Point; to: Point }
  | { op: "Z" };

/**
 * An SVG path as absolute segments DrawingML can express.
 *
 * M L H V C S Q T Z map directly (S and T by reflecting the previous control
 * point); an elliptical arc (A) — a pie or donut slice — is flattened to short
 * cubic-free line segments, a few per degree of sweep, which is visually exact
 * at slide sizes.
 */
export function parsePath(d: string): Segment[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let command = "";
  let current: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastControl: Point | undefined;
  let lastQuad: Point | undefined;
  const number = () => Number(tokens[i++]);
  const more = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]!);

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) command = tokens[i++]!;
    const relative = command === command.toLowerCase();
    const at = (x: number, y: number): Point => (relative ? { x: current.x + x, y: current.y + y } : { x, y });
    const upper = command.toUpperCase();
    if (upper === "Z") {
      out.push({ op: "Z" });
      current = start;
      lastControl = lastQuad = undefined;
      continue;
    }
    if (!more()) break;
    switch (upper) {
      case "M": {
        current = at(number(), number());
        start = current;
        out.push({ op: "M", to: current });
        command = relative ? "l" : "L";
        lastControl = lastQuad = undefined;
        break;
      }
      case "L":
        current = at(number(), number());
        out.push({ op: "L", to: current });
        lastControl = lastQuad = undefined;
        break;
      case "H": {
        const x = number();
        current = { x: relative ? current.x + x : x, y: current.y };
        out.push({ op: "L", to: current });
        lastControl = lastQuad = undefined;
        break;
      }
      case "V": {
        const y = number();
        current = { x: current.x, y: relative ? current.y + y : y };
        out.push({ op: "L", to: current });
        lastControl = lastQuad = undefined;
        break;
      }
      case "C": {
        const c1 = at(number(), number());
        const c2 = at(number(), number());
        const to = at(number(), number());
        out.push({ op: "C", c1, c2, to });
        lastControl = c2;
        lastQuad = undefined;
        current = to;
        break;
      }
      case "S": {
        const c1 = lastControl ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y } : current;
        const c2 = at(number(), number());
        const to = at(number(), number());
        out.push({ op: "C", c1, c2, to });
        lastControl = c2;
        lastQuad = undefined;
        current = to;
        break;
      }
      case "Q": {
        const c = at(number(), number());
        const to = at(number(), number());
        out.push({ op: "Q", c, to });
        lastQuad = c;
        lastControl = undefined;
        current = to;
        break;
      }
      case "T": {
        const c = lastQuad ? { x: 2 * current.x - lastQuad.x, y: 2 * current.y - lastQuad.y } : current;
        const to = at(number(), number());
        out.push({ op: "Q", c, to });
        lastQuad = c;
        lastControl = undefined;
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
        for (const point of arcPoints(current, to, rx, ry, phi, large, sweep)) out.push({ op: "L", to: point });
        current = to;
        lastControl = lastQuad = undefined;
        break;
      }
      default:
        // An unknown command: skip its numbers rather than misread them.
        while (more()) i += 1;
    }
  }
  return out;
}

/** SVG's endpoint arc parameterisation (SVG 1.1 §F.6.5), flattened. */
function arcPoints(from: Point, to: Point, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean): Point[] {
  if (rxIn === 0 || ryIn === 0 || (from.x === to.x && from.y === to.y)) return [to];
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
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs((delta * 180) / Math.PI) / 3));
  const points: Point[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = theta + (delta * step) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    points.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy });
  }
  points[points.length - 1] = to;
  return points;
}

/** A path's local bounding box, from every point it names (controls included). */
function boundsOf(segments: Segment[]): { x: number; y: number; width: number; height: number } {
  const points = segments.flatMap((segment) =>
    segment.op === "Z" ? [] : segment.op === "C" ? [segment.c1, segment.c2, segment.to] : segment.op === "Q" ? [segment.c, segment.to] : [segment.to],
  );
  if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...points.map((p) => p.x));
  const y = Math.min(...points.map((p) => p.y));
  const width = Math.max(...points.map((p) => p.x)) - x;
  const height = Math.max(...points.map((p) => p.y)) - y;
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
}

/** `a:custGeom` for a path, in coordinates relative to its own box, scaled to world px. */
function customGeometry(segments: Segment[], box: { x: number; y: number; width: number; height: number }, scale: number, units: Units, filled: boolean): string {
  const w = units.px(box.width * scale);
  const h = units.px(box.height * scale);
  const pt = (p: Point) => `<a:pt x="${units.px((p.x - box.x) * scale)}" y="${units.px((p.y - box.y) * scale)}"/>`;
  const body = segments
    .map((segment) => {
      switch (segment.op) {
        case "M":
          return `<a:moveTo>${pt(segment.to)}</a:moveTo>`;
        case "L":
          return `<a:lnTo>${pt(segment.to)}</a:lnTo>`;
        case "C":
          return `<a:cubicBezTo>${pt(segment.c1)}${pt(segment.c2)}${pt(segment.to)}</a:cubicBezTo>`;
        case "Q":
          return `<a:quadBezTo>${pt(segment.c)}${pt(segment.to)}</a:quadBezTo>`;
        case "Z":
          return "<a:close/>";
      }
    })
    .join("");
  return (
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>` +
    `<a:pathLst><a:path w="${w}" h="${h}"${filled ? "" : ' fill="none"'}>${body}</a:path></a:pathLst></a:custGeom>`
  );
}

/**
 * `a:custGeom` for a shape the scene resolved to a path in its own box (a
 * custom path, or a kind with no preset). Undefined when the path has nothing
 * drawable, so the caller keeps its rectangle and its warning.
 */
export function pathGeometry(d: string, width: number, height: number, units: Units): { xml: string; flattenedArcs: boolean } | undefined {
  const segments = parsePath(d);
  if (!segments.some((segment) => segment.op !== "M" && segment.op !== "Z")) return undefined;
  return { xml: customGeometry(segments, { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }, 1, units, true), flattenedArcs: /[Aa]/.test(d) };
}

// ------------------------------------------------------------------ writers

interface Writer {
  node: SceneNode;
  context: ShapeContext;
  place: Placement;
  parts: string[];
  index: number;
}

function name(writer: Writer, suffix: string): string {
  writer.index += 1;
  return xml(`${shapeName(writer.node.id)}-${suffix}-${writer.index}`);
}

function addBox(
  writer: Writer,
  box: { x: number; y: number; width: number; height: number },
  look: { fill?: string; fillOpacity?: number; stroke?: string; strokeWidth?: number; dash?: string; radius?: number; ellipse?: boolean },
  text?: { lines: { text: string; size: number; color: string; bold?: boolean }[]; align?: "l" | "ctr" | "r" },
): void {
  const { units } = writer.context;
  const geometry = look.ellipse
    ? `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>`
    : look.radius && look.radius > 0
      ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(Math.min(50_000, (look.radius / Math.max(1, Math.min(box.width, box.height))) * 100_000))}"/></a:avLst></a:prstGeom>`
      : `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  const body = text
    ? `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
      text.lines.map((line) => paragraphXml(line, text.align ?? "ctr", writer)).join("") +
      `</p:txBody>`
    : "";
  writer.parts.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${writer.context.nextId()}" name="${name(writer, "box")}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${frame(box, writer.place, units)}${geometry}${solid(look.fill, look.fillOpacity)}` +
      `${outline(look.stroke, look.strokeWidth ?? 0, units, { dash: look.dash })}</p:spPr>${body}</p:sp>`,
  );
}

function paragraphXml(line: { text: string; size: number; color: string; bold?: boolean }, align: string, writer: Writer): string {
  const family = fontFamily(writer);
  return (
    `<a:p><a:pPr algn="${align}"><a:buNone/></a:pPr><a:r><a:rPr lang="en-US" sz="${writer.context.units.fontSize(line.size * writer.place.scale)}"${line.bold ? ' b="1"' : ""}>` +
    `${solid(line.color)}<a:latin typeface="${xml(family)}"/><a:cs typeface="${xml(family)}"/></a:rPr><a:t>${xml(line.text)}</a:t></a:r></a:p>`
  );
}

function fontFamily(writer: Writer): string {
  const payload = writer.node.renderPayload as { labelTypography?: { fontFamily?: string }; typography?: { fontFamily?: string } };
  const family = payload.labelTypography?.fontFamily ?? payload.typography?.fontFamily ?? "Inter";
  return family.split(",")[0]!.trim().replace(/["']/g, "");
}

function addPath(
  writer: Writer,
  d: string,
  look: { fill?: string; fillOpacity?: number; stroke?: string; strokeWidth?: number; dash?: string; head?: boolean; tail?: boolean; roundCap?: boolean },
): void {
  const segments = parsePath(d);
  if (segments.length === 0) return;
  const box = boundsOf(segments);
  const { units } = writer.context;
  const filled = Boolean(look.fill && look.fill !== "none");
  writer.parts.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${writer.context.nextId()}" name="${name(writer, "path")}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${frame(box, writer.place, units)}${customGeometry(segments, box, writer.place.scale, units, filled)}` +
      `${filled ? solid(look.fill, look.fillOpacity) : "<a:noFill/>"}` +
      `${outline(look.stroke, look.strokeWidth ?? 0, units, { dash: look.dash, head: look.head, tail: look.tail, roundCap: look.roundCap })}</p:spPr></p:sp>`,
  );
}

function addLine(writer: Writer, line: { x1: number; y1: number; x2: number; y2: number }, color: string, width: number, opacity?: number): void {
  addPathWithOpacity(writer, `M ${line.x1} ${line.y1} L ${line.x2} ${line.y2}`, color, width, opacity);
}

function addPathWithOpacity(writer: Writer, d: string, color: string, width: number, opacity?: number): void {
  const segments = parsePath(d);
  const box = boundsOf(segments);
  const { units } = writer.context;
  writer.parts.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${writer.context.nextId()}" name="${name(writer, "line")}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${frame(box, writer.place, units)}${customGeometry(segments, box, writer.place.scale, units, false)}<a:noFill/>` +
      `${outline(color, width, units, { opacity })}</p:spPr></p:sp>`,
  );
}

/**
 * A text mark positioned the way SVG positions it: `x` is the anchor point on
 * the baseline (or the middle, when `middle` is set). The box is sized from the
 * glyph count — generous, and without wrapping, so a label never breaks.
 */
function addText(
  writer: Writer,
  mark: { text: string; x: number; y: number; size: number; color: string; anchor?: "start" | "middle" | "end"; bold?: boolean; rotate?: number; middle?: boolean },
): void {
  const width = Math.max(mark.size, mark.text.length * mark.size * 0.62 + mark.size * 0.6);
  const height = mark.size * 1.35;
  const left = mark.anchor === "middle" ? mark.x - width / 2 : mark.anchor === "end" ? mark.x - width : mark.x;
  const top = mark.middle ? mark.y - height / 2 : mark.y - mark.size * 1.02;
  const box = { x: left, y: top, width, height };
  const { units } = writer.context;
  const align = mark.anchor === "middle" ? "ctr" : mark.anchor === "end" ? "r" : "l";
  const rotate = (writer.place.rotate + (mark.rotate ?? 0)) % 360;
  const place = mark.rotate
    ? { ...writer.place, rotate }
    : writer.place;
  // A rotated label turns about its anchor in SVG and about its centre here; for
  // the one rotated label charts draw (the value-axis title, −90° about a point
  // at its own middle) those are the same place.
  writer.parts.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${writer.context.nextId()}" name="${name(writer, "text")}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${frame(mark.rotate ? { x: mark.x - width / 2, y: mark.y - height / 2, width, height } : box, place, units)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
      paragraphXml({ text: mark.text, size: mark.size, color: mark.color, bold: mark.bold }, align, writer) +
      `</p:txBody></p:sp>`,
  );
}

function group(writer: Writer): string {
  const { node, context } = writer;
  const { units } = context;
  const b = node.bounds;
  const frameXml =
    `<a:xfrm><a:off x="${units.px(b.x)}" y="${units.px(b.y)}"/><a:ext cx="${units.px(Math.max(1, b.width))}" cy="${units.px(Math.max(1, b.height))}"/>` +
    `<a:chOff x="${units.px(b.x)}" y="${units.px(b.y)}"/><a:chExt cx="${units.px(Math.max(1, b.width))}" cy="${units.px(Math.max(1, b.height))}"/></a:xfrm>`;
  const label = node.a11y.label ? ` descr="${xml(node.a11y.label.slice(0, 300))}"` : "";
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${context.nextId()}" name="${xml(shapeName(context.nameOverrides?.get(node.id) ?? node.id))}"${label}/>` +
    `<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${frameXml}</p:grpSpPr>${writer.parts.join("")}</p:grpSp>`
  );
}

// -------------------------------------------------------------------- chart

export function chartShape(node: SceneNode, context: ShapeContext): string | undefined {
  const payload = node.renderPayload;
  if (payload.kind !== "chart") return undefined;
  const writer: Writer = { node, context, place: placementOf(node), parts: [], index: 0 };
  const labelColor = String(payload.labelTypography.color ?? "#000000");

  if (payload.notice) {
    addText(writer, { text: payload.notice, x: node.localBounds.width / 2, y: node.localBounds.height / 2, size: 18, color: labelColor, anchor: "middle", middle: true });
  } else {
    for (const line of payload.gridlines) addLine(writer, line, labelColor, 1, 0.18);
    for (const line of payload.axisLines) addLine(writer, line, labelColor, 1.5, 0.45);
    for (const rect of payload.rects) addBox(writer, rect, { fill: rect.fill, radius: rect.radius });
    for (const path of payload.paths) {
      addPath(writer, path.d, { fill: path.fill, fillOpacity: path.fillOpacity, stroke: path.stroke, strokeWidth: path.strokeWidth, dash: path.dash });
    }
    for (const point of payload.points) {
      addBox(writer, { x: point.cx - point.r, y: point.cy - point.r, width: point.r * 2, height: point.r * 2 }, { fill: point.fill, ellipse: true });
    }
    for (const text of payload.texts) {
      addText(writer, { text: text.text, x: text.x, y: text.y, size: text.fontSize, color: text.fill, anchor: text.anchor, bold: (text.weight ?? 400) >= 600, rotate: text.rotate });
    }
    const legendSize = payload.labelTypography.fontSize ?? 16;
    for (const item of payload.legend) {
      addBox(writer, item.swatch, { fill: item.color, radius: 3 });
      addText(writer, { text: item.label, x: item.textX, y: item.textY, size: legendSize, color: labelColor, anchor: "start", middle: true });
    }
  }

  context.ledger.record({
    severity: "info",
    slideId: context.scene.slideId,
    elementId: node.id,
    feature: "chart",
    action: "approximated",
    message:
      "Charts are drawn as shapes and editable text that match the slide exactly, " +
      "not as a PowerPoint chart object — the numbers cannot be edited as a data sheet in PowerPoint.",
  });
  return group(writer);
}

// ------------------------------------------------------------------ diagram

export function diagramShape(node: SceneNode, context: ShapeContext): string | undefined {
  const payload = node.renderPayload;
  if (payload.kind !== "diagram") return undefined;
  const writer: Writer = { node, context, place: placementOf(node), parts: [], index: 0 };

  if (payload.notice) {
    addText(writer, { text: payload.notice, x: node.localBounds.width / 2, y: node.localBounds.height / 2, size: 18, color: "#808080", anchor: "middle", middle: true });
  }
  for (const box of payload.groups) {
    addBox(writer, box, { fill: box.fill, stroke: box.stroke, strokeWidth: box.strokeWidth, dash: box.dash, radius: box.radius });
    if (box.label) addText(writer, { text: box.label.text, x: box.label.x, y: box.label.y, size: box.label.size, color: box.label.color, anchor: "start" });
  }
  for (const edge of payload.edges) {
    addPath(writer, edge.d, { stroke: edge.stroke, strokeWidth: edge.strokeWidth, dash: edge.dash, head: edge.markerStart, tail: edge.markerEnd });
    if (edge.label) addText(writer, { text: edge.label.text, x: edge.label.x, y: edge.label.y, size: edge.label.size, color: edge.label.color, anchor: "middle" });
  }
  for (const box of payload.nodes) {
    // The label is the node's own text, so a recipient edits it in the box.
    const lines = [{ text: box.label, size: box.labelSize, color: box.labelColor, bold: true }];
    if (box.sublabel) lines.push({ text: box.sublabel, size: box.sublabelSize, color: box.labelColor, bold: false });
    addBox(writer, box, { fill: box.fill, stroke: box.stroke, strokeWidth: box.strokeWidth, dash: box.dash, radius: box.radius }, { lines });
  }

  context.ledger.record({
    severity: "info",
    slideId: context.scene.slideId,
    elementId: node.id,
    feature: "diagram",
    action: "approximated",
    message:
      "Diagrams are drawn as boxes and connector paths with their labels as editable text; " +
      "they will not re-lay themselves out if a box is added in PowerPoint.",
  });
  return group(writer);
}

// --------------------------------------------------------------------- icon

/**
 * An icon as editable freeform shapes (design review, 2026-09-27). Icons used
 * to arrive in PowerPoint as labelled placeholder boxes — the one object a deck
 * could look right with in the editor and lose on export. Every curated icon is
 * stroked paths and circles in a square viewBox, drawn centred and contained
 * in the element's box (SVG's default `xMidYMid meet`), so each becomes a
 * `custGeom` outline or an ellipse in the same place, at the same weight, with
 * round caps and joins, grouped under the element's name.
 *
 * Arcs in a path are flattened to short segments, as a chart's pie slices are,
 * and the report says so; an icon with none is exact.
 */
export function iconShape(node: SceneNode, context: ShapeContext): string | undefined {
  const payload = node.renderPayload;
  if (payload.kind !== "icon" || payload.missing) return undefined;
  const base = placementOf(node);
  const { width, height } = node.localBounds;
  const s = Math.min(width, height) / payload.viewBox;
  const ox = (width - payload.viewBox * s) / 2;
  const oy = (height - payload.viewBox * s) / 2;
  const place: Placement = {
    scale: base.scale * s,
    rotate: base.rotate,
    map: (x, y) => base.map(ox + x * s, oy + y * s),
  };
  const writer: Writer = { node, context, place, parts: [], index: 0 };
  const stroke = payload.strokeWidth * base.scale * s;
  // A brand's logo mark is filled shapes; a line icon is outlines.
  const look = payload.fill ? { fill: payload.color } : { stroke: payload.color, strokeWidth: stroke };
  for (const d of payload.paths) addPath(writer, d, payload.fill ? look : { ...look, roundCap: true });
  for (const [cx, cy, r] of payload.circles) {
    addBox(writer, { x: cx - r, y: cy - r, width: r * 2, height: r * 2 }, { ...look, ellipse: true });
  }
  if (payload.paths.some((d) => /[Aa]/.test(d))) {
    context.ledger.record({
      severity: "info",
      slideId: context.scene.slideId,
      elementId: node.id,
      feature: "icon",
      action: "approximated",
      message: `The "${payload.name}" icon's curves are drawn as short straight segments; it is still an editable shape.`,
    });
  }
  return group(writer);
}

// -------------------------------------------------------------------- table

export function tableShape(node: SceneNode, context: ShapeContext): string | undefined {
  const payload = node.renderPayload;
  if (payload.kind !== "table") return undefined;
  const { units } = context;
  const place = placementOf(node);
  const width = node.localBounds.width;
  const height = node.localBounds.height;
  const columns = payload.columns.length;
  if (columns === 0) return undefined;

  // Column widths: explicit ones in proportion, the rest sharing what is left.
  const explicit = payload.columns.map((column) => column.width ?? 0);
  const fixed = explicit.reduce((sum, value) => sum + value, 0);
  const free = explicit.filter((value) => !value).length;
  const share = free > 0 ? Math.max(0, width - fixed) / free : 0;
  const raw = explicit.map((value) => value || share);
  const total = raw.reduce((sum, value) => sum + value, 0) || width;
  const widths = raw.map((value) => (value / total) * width * place.scale);

  const header = payload.headerRow;
  const rowCount = payload.rows.length + (header ? 1 : 0);
  const rowHeight = (height / Math.max(1, rowCount)) * place.scale;
  const border = payload.borderColor;
  const family = (payload.typography.fontFamily ?? "Inter").split(",")[0]!.trim().replace(/["']/g, "");
  const pad = payload.padding;

  const line = (side: "L" | "R" | "T" | "B", on: boolean) =>
    on && payload.borders !== "none"
      ? `<a:ln${side} w="${units.px(1)}">${solid(border)}</a:ln${side}>`
      : `<a:ln${side} w="0"><a:noFill/></a:ln${side}>`;
  const cell = (
    text: string,
    options: { header: boolean; align?: string; fill?: string; row: number; column: number; span?: number; rowSpan?: number; merged?: "h" | "v" },
  ) => {
    const typography = options.header ? payload.headerTypography : payload.typography;
    const size = units.fontSize((typography.fontSize ?? 20) * place.scale);
    const bold = options.header || (typography.fontWeight ?? 400) >= 600 ? ' b="1"' : "";
    const algn = options.align === "right" ? "r" : options.align === "center" ? "ctr" : "l";
    const lastRow = options.row === rowCount - 1;
    const firstRow = options.row === 0;
    const firstColumn = options.column === 0;
    const lastColumn = options.column + (options.span ?? 1) - 1 === columns - 1;
    const horizontal = payload.borders === "all" || payload.borders === "horizontal";
    const vertical = payload.borders === "all";
    const outer = payload.borders === "outer";
    const lines =
      line("L", vertical || (outer && firstColumn)) +
      line("R", vertical || (outer && lastColumn)) +
      line("T", horizontal || (outer && firstRow)) +
      line("B", horizontal || (outer && lastRow));
    const attributes = `${options.span && options.span > 1 ? ` gridSpan="${options.span}"` : ""}${options.rowSpan && options.rowSpan > 1 ? ` rowSpan="${options.rowSpan}"` : ""}${options.merged === "h" ? ' hMerge="1"' : options.merged === "v" ? ' vMerge="1"' : ""}`;
    return (
      `<a:tc${attributes}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="${algn}"><a:buNone/></a:pPr>` +
      (text
        ? `<a:r><a:rPr lang="en-US" sz="${size}"${bold}>${solid(String(typography.color ?? "#000000"))}<a:latin typeface="${xml(family)}"/><a:cs typeface="${xml(family)}"/></a:rPr><a:t>${xml(text)}</a:t></a:r>`
        : "") +
      `</a:p></a:txBody><a:tcPr marL="${units.px(pad.left * place.scale)}" marR="${units.px(pad.right * place.scale)}" marT="${units.px(pad.top * place.scale)}" marB="${units.px(pad.bottom * place.scale)}" anchor="ctr">` +
      `${lines}${options.fill ? solid(options.fill) : "<a:noFill/>"}</a:tcPr></a:tc>`
    );
  };

  const rows: string[] = [];
  if (header) {
    rows.push(
      `<a:tr h="${units.px(rowHeight)}">` +
        payload.columns.map((column, index) => cell(column.label ?? "", { header: true, align: column.align, fill: payload.headerFill, row: 0, column: index })).join("") +
        `</a:tr>`,
    );
  }
  // Spans: a cell the payload omits because a neighbour spans it is written as
  // the merged continuation DrawingML requires, so every row has `columns` cells.
  const covered = new Set<string>();
  payload.rows.forEach((row, r) => {
    const rowIndex = r + (header ? 1 : 0);
    const cells: string[] = [];
    let source = 0;
    const band = payload.banding === "rows" && r % 2 === 1 ? payload.bandColor : undefined;
    const emphasis = row.emphasis && row.emphasis !== "none" ? payload.emphasisFill : undefined;
    for (let column = 0; column < columns; column += 1) {
      if (covered.has(`${r}:${column}`)) {
        const fromLeft = covered.has(`${r}:${column}:h`);
        cells.push(cell("", { header: false, row: rowIndex, column, merged: fromLeft ? "h" : "v" }));
        continue;
      }
      const entry = row.cells[source++];
      const span = Math.min(entry?.colSpan ?? 1, columns - column);
      const rowSpan = Math.min(entry?.rowSpan ?? 1, payload.rows.length - r);
      for (let dc = 0; dc < span; dc += 1) {
        for (let dr = 0; dr < rowSpan; dr += 1) {
          if (dc === 0 && dr === 0) continue;
          covered.add(`${r + dr}:${column + dc}`);
          if (dc > 0) covered.add(`${r + dr}:${column + dc}:h`);
        }
      }
      const bandColumn = payload.banding === "columns" && column % 2 === 1 ? payload.bandColor : undefined;
      const headerColumn = payload.headerColumn && column === 0;
      cells.push(
        cell(entry?.text ?? "", {
          header: headerColumn,
          align: entry?.align ?? payload.columns[column]?.align,
          fill: entry?.fill ?? emphasis ?? band ?? bandColumn ?? (headerColumn ? payload.headerFill : undefined),
          row: rowIndex,
          column,
          span,
          rowSpan,
        }),
      );
    }
    rows.push(`<a:tr h="${units.px(rowHeight)}">${cells.join("")}</a:tr>`);
  });

  const b = { x: 0, y: 0, width, height };
  const centre = place.map(b.width / 2, b.height / 2);
  const w = width * place.scale;
  const h = height * place.scale;
  if (place.rotate) {
    context.ledger.record({
      severity: "info",
      slideId: context.scene.slideId,
      elementId: node.id,
      feature: "table",
      action: "approximated",
      message: "PowerPoint cannot rotate a table, so this one is exported upright.",
    });
  }
  const label = node.a11y.label ? ` descr="${xml(node.a11y.label.slice(0, 300))}"` : "";
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${context.nextId()}" name="${xml(shapeName(context.nameOverrides?.get(node.id) ?? node.id))}"${label}/>` +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${units.px(centre.x - w / 2)}" y="${units.px(centre.y - h / 2)}"/><a:ext cx="${units.px(w)}" cy="${units.px(h)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr${header ? ' firstRow="1"' : ""}${payload.banding === "rows" ? ' bandRow="1"' : ""}/>` +
    `<a:tblGrid>${widths.map((value) => `<a:gridCol w="${units.px(value)}"/>`).join("")}</a:tblGrid>` +
    `${rows.join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}
