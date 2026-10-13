import type { DiagramElement } from "@deckastra/presentation-schema";

import type { DiagramEdgeMark, DiagramGroupMark, DiagramNodeMark } from "./diagram";
import { estimateLabelWidth, round } from "./scale";
import { parseColor } from "./semantic";

/**
 * Diagrams with depth (image-led visual systems, item 6, 2026-10-13): System
 * Terminal's exploded wireframe and Spatial Future's orbital scenes.
 *
 * - **isometric**: any automatic layout, its boxes drawn as blocks standing on
 *   a plane tilted 30°. The flat layout is computed first and projected, so a
 *   node is where the layered layout put it, only seen from above.
 * - **stack**: an exploded view. Each rank is a plate, the first rank on top,
 *   raised far enough above the next that no plate covers another.
 * - **orbit**: the first source node at the centre, every other node on a
 *   tilted ring by its distance from it, nearer nodes drawn larger.
 *
 * The projection is affine, so a flat edge's curve (M, L, Q and C only) is
 * projected point by point and stays the same curve. Everything leaves here as
 * concrete numbers: faces as paths, in the order to paint them, so the canvas,
 * the PDF and PowerPoint draw the same depth with no 3D anywhere downstream.
 */

export type SpatialMode = "isometric" | "stack" | "orbit";

export interface SpatialInput {
  element: DiagramElement;
  mode: SpatialMode;
  nodes: DiagramNodeMark[];
  edges: DiagramEdgeMark[];
  groups: DiagramGroupMark[];
  ranks: Map<string, number>;
  width: number;
  height: number;
  warnings: string[];
  /** Colour for orbit rings and stack plate edges. */
  lineColor: string;
  /** Fill for stack plates. */
  plateFill: string;
  labelColor: string;
  labelSize: number;
}

export interface SpatialResult {
  nodes: DiagramNodeMark[];
  edges: DiagramEdgeMark[];
  groups: DiagramGroupMark[];
  edgesAbove: boolean;
}

const COS30 = Math.cos(Math.PI / 6);
const MARGIN = 0.04;

type Point = [number, number];

/** Ground (u, v) at height z, seen from 30° above. */
function iso(u: number, v: number, z: number): Point {
  return [(u - v) * COS30, (u + v) * 0.5 - z];
}

function polygon(points: Point[]): string {
  return `M ${points.map(([x, y]) => `${round(x)} ${round(y)}`).join(" L ")} Z`;
}

/** Every coordinate pair of a path through `map`. Only absolute M, L, Q, C and Z occur. */
function mapPath(d: string, map: (p: Point) => Point): string {
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? [];
  const out: string[] = [];
  let pending: number | undefined;
  for (const token of tokens) {
    if (/^[A-Z]$/i.test(token)) {
      out.push(token.toUpperCase());
      continue;
    }
    const value = Number(token);
    if (pending === undefined) pending = value;
    else {
      const [x, y] = map([pending, value]);
      out.push(`${round(x)} ${round(y)}`);
      pending = undefined;
    }
  }
  return out.join(" ");
}

function pathPoints(d: string): Point[] {
  const numbers = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
  const points: Point[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i]!, numbers[i + 1]!]);
  return points;
}

/** A face's colour: the node's own, darkened. A fill that is not a plain colour falls back to the line colour. */
function shade(fill: string, amount: number, fallback: string): string {
  const rgb = parseColor(fill) ?? parseColor(fallback);
  if (!rgb) return fill;
  const hex = (value: number) => Math.round(Math.max(0, Math.min(255, value * (1 - amount)))).toString(16).padStart(2, "0");
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

function bounds(points: Point[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

interface Block {
  mark: DiagramNodeMark;
  top: Point[];
  sides: { points: Point[]; fill: string }[];
  depth: number;
}

/** A box on the ground at (u, v), w by d, from z to z + h, as its visible faces. */
function block(mark: DiagramNodeMark, u: number, v: number, w: number, d: number, z: number, h: number, lineColor: string): Block {
  const at = (a: number, b: number, c: number) => iso(a, b, c);
  const top = [at(u, v, z + h), at(u + w, v, z + h), at(u + w, v + d, z + h), at(u, v + d, z + h)];
  // The two faces turned towards the viewer: the one along the near v edge and
  // the one along the near u edge. The far two are never visible from here.
  const left = [at(u, v + d, z + h), at(u + w, v + d, z + h), at(u + w, v + d, z), at(u, v + d, z)];
  const right = [at(u + w, v, z + h), at(u + w, v + d, z + h), at(u + w, v + d, z), at(u + w, v, z)];
  return {
    mark,
    top,
    sides: [
      { points: left, fill: shade(mark.fill, 0.2, lineColor) },
      { points: right, fill: shade(mark.fill, 0.34, lineColor) },
    ],
    // Painted back to front: the nearer the block's front corner, the later.
    depth: u + w + v + d + z * 0.01,
  };
}

export function spatialDiagram(input: SpatialInput): SpatialResult {
  if (input.mode === "orbit") return orbit(input);
  return input.mode === "stack" ? stack(input) : isometric(input);
}

// ------------------------------------------------------------------ isometric

function isometric(input: SpatialInput): SpatialResult {
  const { element, nodes, edges, groups, lineColor } = input;
  // Each node keeps the place the flat layout gave it on screen, and stands on
  // the tilted ground as a square block, its top a diamond. Projecting the whole
  // layout instead would turn a left-to-right flow into a diagonal that fills a
  // third of its box. The ground point under a screen point (x, y) is the one
  // `iso` sends back there: u - v = x / cos 30°, u + v = 2y.
  const ground = (x: number, y: number): Point => [(x / COS30 + 2 * y) / 2, (2 * y - x / COS30) / 2];
  // A footprint as wide as the box was and no deeper than the space to its
  // neighbour, so blocks in one rank never touch.
  const side = (mark: DiagramNodeMark) => Math.min(mark.width * 0.62, mark.height + 30);
  const height = Math.max(10, round(Math.min(...nodes.map(side)) * 0.3));
  const feet = new Map<string, { u: number; v: number; f: number }>();
  const blocks = nodes
    .map((mark) => {
      const [u, v] = ground(mark.x + mark.width / 2, mark.y + mark.height / 2);
      const f = side(mark);
      feet.set(mark.id, { u, v, f });
      return block(mark, u - f / 2, v - f / 2, f, f, 0, height, lineColor);
    })
    .sort((a, b) => a.depth - b.depth);

  // Edges are straight on the ground, from where the line between two centres
  // leaves one footprint to where it enters the other, at the blocks' tops.
  const exit = (from: { u: number; v: number; f: number }, to: { u: number; v: number }): Point => {
    const du = to.u - from.u;
    const dv = to.v - from.v;
    const t = (from.f / 2) / Math.max(Math.abs(du), Math.abs(dv), 1e-9);
    return [from.u + du * Math.min(1, t), from.v + dv * Math.min(1, t)];
  };
  const projectedEdges = edges.flatMap((edge) => {
    const source = element.edges.find((candidate) => candidate.id === edge.id);
    const from = source && feet.get(source.from);
    const to = source && feet.get(source.to);
    if (!from || !to || from === to) return [];
    const start = iso(...exit(from, to), height);
    const end = iso(...exit(to, from), height);
    return [{
      ...edge,
      d: `M ${round(start[0])} ${round(start[1])} L ${round(end[0])} ${round(end[1])}`,
      label: edge.label ? { ...edge.label, x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2 - 8 } : undefined,
    }];
  });

  // A group is a region on the ground: the hull of its members' footprints,
  // each grown by a margin. A box aligned to the tilted ground would be a huge
  // diamond around a horizontal row, covering nodes outside the group.
  const plates = groups.flatMap((group) => {
    const source = element.groups?.find((candidate) => candidate.id === group.id);
    const members = (source?.nodeIds ?? []).map((id) => feet.get(id)).filter((foot): foot is { u: number; v: number; f: number } => foot !== undefined);
    if (members.length === 0) return [];
    const pad = 22;
    const corners = hull(
      members.flatMap((m) => {
        const r = m.f / 2 + pad;
        return [iso(m.u - r, m.v - r, 0), iso(m.u + r, m.v - r, 0), iso(m.u + r, m.v + r, 0), iso(m.u - r, m.v + r, 0)];
      }),
    );
    // Named under its lowest point, centred: nothing stands in front of a region.
    const lowest = corners.reduce((best, point) => (point[1] > best[1] ? point : best));
    return [{
      ...group,
      ...bounds(corners),
      outline: polygon(corners),
      label: group.label
        ? { ...group.label, x: lowest[0] - estimateLabelWidth(group.label.text, group.label.size) / 2, y: lowest[1] + group.label.size + 8 }
        : undefined,
    }];
  });
  return fit(input, blocks, projectedEdges, plates, true);
}

const xy = ([x, y]: Point) => ({ x, y });

/** Convex hull, Andrew's monotone chain; ties broken by coordinate, so it is the same every time. */
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

// ---------------------------------------------------------------------- stack

const STACK_GAP = 40;
const PLATE_PAD = 36;
const PLATE_THICKNESS = 8;

function stack(input: SpatialInput): SpatialResult {
  const { element, nodes, edges, ranks, lineColor, plateFill, warnings } = input;
  const byRank = new Map<number, DiagramNodeMark[]>();
  for (const mark of nodes) {
    const rank = ranks.get(mark.id) ?? 0;
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank)!.push(mark);
  }
  const order = [...byRank.keys()].sort((a, b) => a - b);
  const height = Math.max(10, round(Math.min(...nodes.map((n) => Math.min(n.width, n.height))) * 0.32));

  // Every plate the same size, so the stack reads as one object pulled apart.
  const rowWidth = (row: DiagramNodeMark[]) => row.reduce((sum, n) => sum + n.width, 0) + STACK_GAP * (row.length - 1);
  const plateW = Math.max(...order.map((rank) => rowWidth(byRank.get(rank)!))) + PLATE_PAD * 2;
  // At least half as deep as wide: a plate, not a strip.
  const plateD = Math.max(Math.max(...nodes.map((n) => n.height)) + PLATE_PAD * 2, plateW * 0.5);
  // Raised by a plate's whole on-screen depth plus its blocks: no plate can
  // cover the blocks on the one below.
  const gap = (plateW + plateD) * 0.5 + height + PLATE_THICKNESS + 28;

  const blocks: Block[] = [];
  const plates: DiagramGroupMark[] = [];
  const centres = new Map<string, { u: number; v: number; z: number; w: number; d: number }>();
  // A layer is named by a group whose members are exactly that layer's nodes.
  // A group that spans layers, or covers only part of one, has no plate to name.
  const layerName = new Map<number, string>();
  let unmatched = 0;
  for (const group of element.groups ?? []) {
    const members = new Set(group.nodeIds);
    const rank = ranks.get(group.nodeIds[0] ?? "");
    const layer = rank === undefined ? [] : byRank.get(rank) ?? [];
    const exact = layer.length === members.size && layer.every((mark) => members.has(mark.id));
    if (exact && group.label && rank !== undefined) layerName.set(rank, group.label);
    else unmatched += 1;
  }

  order.forEach((rank, index) => {
    const row = byRank.get(rank)!;
    const z = (order.length - 1 - index) * gap;
    let u = (plateW - rowWidth(row)) / 2;
    for (const mark of row) {
      const v = (plateD - mark.height) / 2;
      blocks.push(block(mark, u, v, mark.width, mark.height, z + PLATE_THICKNESS, height, lineColor));
      centres.set(mark.id, { u, v, z: z + PLATE_THICKNESS + height, w: mark.width, d: mark.height });
      u += mark.width + STACK_GAP;
    }
    const name = layerName.get(rank);
    const plate = block(
      { id: `plate:${rank}`, x: 0, y: 0, width: 0, height: 0, radius: 0, fill: plateFill, strokeWidth: 1, label: "", labelColor: "", labelSize: 0, sublabelSize: 0 },
      0, 0, plateW, plateD, z, PLATE_THICKNESS, lineColor,
    );
    const corner = iso(0, 0, z + PLATE_THICKNESS);
    plates.push({
      id: `${element.id}:plate:${rank}`,
      ...bounds(plate.top),
      radius: 0,
      fill: plateFill,
      stroke: lineColor,
      strokeWidth: 1,
      outline: polygon(plate.top),
      sides: plate.sides.map((side) => ({ d: polygon(side.points), fill: side.fill })),
      label: name ? { text: name, x: corner[0] - 4, y: corner[1] - 12, size: input.labelSize, color: input.labelColor } : undefined,
    });
  });
  if (unmatched > 0) {
    warnings.push(
      `A stacked view names a layer by a group of exactly its boxes; ${unmatched} ${unmatched === 1 ? "group does" : "groups do"} not match the layers, so ${unmatched === 1 ? "it is" : "they are"} not drawn.`,
    );
  }
  blocks.sort((a, b) => a.depth - b.depth);

  // Within a layer an edge runs across the block tops, side to side. Between
  // layers it leaves the upper block from the middle of its near bottom edge
  // and arrives at the middle of the lower block's far top edge, so it starts
  // below one label and ends above the other instead of crossing either.
  const projectedEdges = edges.flatMap((edge) => {
    const source = element.edges.find((candidate) => candidate.id === edge.id);
    const from = source && centres.get(source.from);
    const to = source && centres.get(source.to);
    if (!from || !to || from === to) return [];
    let start: Point;
    let end: Point;
    if (from.z === to.z) {
      const rightward = to.u > from.u;
      start = iso(rightward ? from.u + from.w : from.u, from.v + from.d / 2, from.z);
      end = iso(rightward ? to.u : to.u + to.w, to.v + to.d / 2, to.z);
    } else {
      const down = to.z < from.z;
      const [upper, lower] = down ? [from, to] : [to, from];
      const leave = iso(upper.u + upper.w / 2, upper.v + upper.d, upper.z - height);
      const arrive = iso(lower.u + lower.w / 2, lower.v, lower.z);
      [start, end] = down ? [leave, arrive] : [arrive, leave];
    }
    return [{
      ...edge,
      d: `M ${round(start[0])} ${round(start[1])} L ${round(end[0])} ${round(end[1])}`,
      label: edge.label ? { ...edge.label, x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2 - 8 } : undefined,
    }];
  });
  return fit(input, blocks, projectedEdges, plates.reverse(), true);
}

// ---------------------------------------------------------------------- orbit

const TILT = 0.38;

function orbit(input: SpatialInput): SpatialResult {
  const { element, nodes, edges, ranks, lineColor, warnings } = input;
  // The centre: the first node nothing points at, in document order.
  const root = nodes.find((mark) => (ranks.get(mark.id) ?? 0) === 0) ?? nodes[0]!;
  const neighbours = new Map<string, string[]>(nodes.map((mark) => [mark.id, []]));
  for (const edge of element.edges) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }
  const ring = new Map<string, number>([[root.id, 0]]);
  const queue = [root.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of neighbours.get(id) ?? []) {
      if (!ring.has(next)) {
        ring.set(next, ring.get(id)! + 1);
        queue.push(next);
      }
    }
  }
  const reached = Math.max(0, ...ring.values());
  // A node joined to nothing goes on a ring of its own outside the others.
  const outer = reached + 1;
  for (const mark of nodes) if (!ring.has(mark.id)) ring.set(mark.id, outer);
  if (nodes.some((mark) => ring.get(mark.id) === outer)) warnings.push("Nodes with no connection to the centre are placed on the outermost ring.");

  // Wide enough that a node beside the centre clears it at the ring's widest
  // tilt (30° below the horizontal is cos 30° of the radius across).
  const widest = Math.max(...nodes.map((mark) => mark.width));
  const step = Math.max(220, (widest * 1.125 + 40) / COS30);
  const rings = Math.max(...ring.values());
  const placed: DiagramNodeMark[] = [];
  const rects = new Map<string, DiagramNodeMark>();
  const ringMarks: DiagramGroupMark[] = [];
  for (let index = 1; index <= rings; index += 1) {
    const members = nodes.filter((mark) => ring.get(mark.id) === index);
    if (members.length === 0) continue;
    const rx = step * index;
    const ry = rx * TILT;
    ringMarks.push({
      id: `${element.id}:ring:${index}`,
      x: -rx,
      y: -ry,
      width: rx * 2,
      height: ry * 2,
      radius: 0,
      stroke: lineColor,
      strokeWidth: 1.5,
      dash: "4 8",
      outline: ellipse(rx, ry),
    });
    members.forEach((mark, k) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * k) / members.length + (index % 2 === 0 ? Math.PI / members.length : 0);
      // Nearer the viewer (lower on the ring), larger.
      const scale = 0.8 + 0.3 * ((Math.sin(angle) + 1) / 2);
      const node = sized(mark, rx * Math.cos(angle), ry * Math.sin(angle), scale);
      placed.push(node);
      rects.set(mark.id, node);
    });
  }
  const centre = sized(root, 0, 0, 1.15);
  placed.push(centre);
  rects.set(root.id, centre);
  placed.sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));

  const projectedEdges = edges.flatMap((edge) => {
    const source = element.edges.find((candidate) => candidate.id === edge.id);
    const from = source && rects.get(source.from);
    const to = source && rects.get(source.to);
    if (!from || !to || from === to) return [];
    const start = toward(from, to);
    const end = toward(to, from);
    return [{
      ...edge,
      d: `M ${round(start[0])} ${round(start[1])} L ${round(end[0])} ${round(end[1])}`,
      label: edge.label ? { ...edge.label, x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2 - 8 } : undefined,
    }];
  });
  if ((element.groups?.length ?? 0) > 0) warnings.push("Groups are not drawn in an orbit; the rings show the structure.");
  const blocks = placed.map((mark) => ({ mark, top: [] as Point[], sides: [], depth: 0 }));
  return fit(input, blocks, projectedEdges, ringMarks, false);
}

function sized(mark: DiagramNodeMark, cx: number, cy: number, scale: number): DiagramNodeMark {
  const width = mark.width * scale;
  const height = mark.height * scale;
  return {
    ...mark,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    radius: height / 2,
    labelSize: mark.labelSize * scale,
    sublabelSize: mark.sublabelSize * scale,
  };
}

/** Where the line from one node's centre towards another's leaves its box. */
function toward(from: DiagramNodeMark, to: DiagramNodeMark): Point {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const dx = to.x + to.width / 2 - cx;
  const dy = to.y + to.height / 2 - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const scale = Math.min(dx === 0 ? Infinity : from.width / 2 / Math.abs(dx), dy === 0 ? Infinity : from.height / 2 / Math.abs(dy));
  return [cx + dx * scale, cy + dy * scale];
}

/** An ellipse as four cubic curves, so every consumer meets only M, C and Z. */
function ellipse(rx: number, ry: number): string {
  const k = 0.5523;
  const p = (x: number, y: number) => `${round(x)} ${round(y)}`;
  return (
    `M ${p(rx, 0)} C ${p(rx, ry * k)} ${p(rx * k, ry)} ${p(0, ry)} ` +
    `C ${p(-rx * k, ry)} ${p(-rx, ry * k)} ${p(-rx, 0)} ` +
    `C ${p(-rx, -ry * k)} ${p(-rx * k, -ry)} ${p(0, -ry)} ` +
    `C ${p(rx * k, -ry)} ${p(rx, -ry * k)} ${p(rx, 0)} Z`
  );
}

// ------------------------------------------------------------------------ fit

/**
 * Scale and centre everything into the element's box, one factor for both
 * axes. Text scales with the drawing, within the bounds the flat layout uses,
 * and says so when it had to be drawn small.
 */
function fit(
  input: SpatialInput,
  blocks: Block[] | { mark: DiagramNodeMark; top: Point[]; sides: { points: Point[]; fill: string }[] }[],
  edges: DiagramEdgeMark[],
  groups: DiagramGroupMark[],
  edgesAbove: boolean,
): SpatialResult {
  const points: Point[] = [];
  for (const b of blocks) {
    if (b.top.length) points.push(...b.top, ...b.sides.flatMap((side) => side.points));
    else points.push([b.mark.x, b.mark.y], [b.mark.x + b.mark.width, b.mark.y + b.mark.height]);
  }
  for (const group of groups) {
    if (group.outline) points.push(...pathPoints(group.outline));
    for (const side of group.sides ?? []) points.push(...pathPoints(side.d));
    if (group.label) points.push([group.label.x, group.label.y - group.label.size], [group.label.x + estimateLabelWidth(group.label.text, group.label.size), group.label.y]);
  }
  for (const edge of edges) points.push(...pathPoints(edge.d));
  if (points.length === 0) return { nodes: [], edges: [], groups: [], edgesAbove };

  const extent = bounds(points);
  const availableW = input.width * (1 - MARGIN * 2);
  const availableH = input.height * (1 - MARGIN * 2);
  const k = Math.min(1.4, availableW / Math.max(1, extent.width), availableH / Math.max(1, extent.height));
  const tx = input.width / 2 - (extent.x + extent.width / 2) * k;
  const ty = input.height / 2 - (extent.y + extent.height / 2) * k;
  const map = ([x, y]: Point): Point => [x * k + tx, y * k + ty];
  // Text follows the drawing, but no smaller than can be read at slide size.
  const text = (size: number) => round(Math.max(9, size * Math.min(1.4, Math.max(0.55, k))));
  if (k < 0.55) input.warnings.push("This diagram is drawn small to fit its box; make the box larger for readable labels.");

  const nodes = blocks.map((b) => {
    const mark = b.mark;
    if (!b.top.length) {
      const [x, y] = map([mark.x, mark.y]);
      return {
        ...mark,
        x: round(x),
        y: round(y),
        width: round(mark.width * k),
        height: round(mark.height * k),
        radius: round(mark.radius * k),
        labelSize: text(mark.labelSize),
        sublabelSize: text(mark.sublabelSize),
      };
    }
    const top = b.top.map(map);
    const box = bounds(top);
    return {
      ...mark,
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      radius: 0,
      outline: polygon(top),
      sides: b.sides.map((side) => ({ d: polygon(side.points.map(map)), fill: side.fill })),
      labelSize: text(mark.labelSize),
      sublabelSize: text(mark.sublabelSize),
    };
  });

  return {
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      d: mapPath(edge.d, map),
      label: edge.label ? { ...edge.label, ...xy(map([edge.label.x, edge.label.y]).map(round) as Point), size: text(edge.label.size) } : undefined,
    })),
    groups: groups.map((group) => {
      const [x, y] = map([group.x, group.y]);
      return {
        ...group,
        x: round(x),
        y: round(y),
        width: round(group.width * k),
        height: round(group.height * k),
        outline: group.outline ? mapPath(group.outline, map) : undefined,
        sides: group.sides?.map((side) => ({ ...side, d: mapPath(side.d, map) })),
        label: group.label ? { ...group.label, ...xy(map([group.label.x, group.label.y]).map(round) as Point), size: text(group.label.size) } : undefined,
      };
    }),
    edgesAbove,
  };
}
