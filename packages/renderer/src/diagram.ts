import type {
  DiagramEdge,
  DiagramElement,
  DiagramNode,
  TypographyStyle,
} from "@deckastra/presentation-schema";

import { estimateLabelWidth, round } from "./scale";
import { paintToCss, resolveTypography, resolveValue, type ResolvedTheme } from "./theme";

/**
 * Diagram layout (doc 04 §20).
 *
 * A diagram is structure in the document and geometry here. Every algorithm below
 * is deterministic — fixed iteration counts, document order as the tie-break, and
 * a seeded generator for the force layout (doc 02 §18.5 requires the seed for
 * exactly this reason). A layout that settles differently on each run would make
 * every visual-regression snapshot meaningless and would move a user's diagram
 * under them on reload.
 */

export interface DiagramNodeMark {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill: string;
  stroke?: string;
  strokeWidth: number;
  dash?: string;
  label: string;
  sublabel?: string;
  labelColor: string;
  labelSize: number;
  sublabelSize: number;
  role?: string;
}

export interface DiagramEdgeMark {
  id: string;
  d: string;
  stroke: string;
  strokeWidth: number;
  dash?: string;
  markerStart: boolean;
  markerEnd: boolean;
  label?: { text: string; x: number; y: number; size: number; color: string };
}

export interface DiagramGroupMark {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill?: string;
  stroke: string;
  strokeWidth: number;
  dash?: string;
  label?: { text: string; x: number; y: number; size: number; color: string };
}

export interface DiagramPayload {
  kind: "diagram";
  diagramType: string;
  algorithm: string;
  nodes: DiagramNodeMark[];
  edges: DiagramEdgeMark[];
  groups: DiagramGroupMark[];
  typography: TypographyStyle;
  warnings: string[];
  notice?: string;
}

const MIN_NODE_WIDTH = 140;
const MAX_NODE_WIDTH = 320;
const NODE_PADDING_X = 28;
const NODE_PADDING_Y = 20;
const GROUP_PADDING = 24;
const GROUP_LABEL_SPACE = 26;

/**
 * mulberry32. Small, fast, and — the only property that matters here —
 * reproducible from an integer seed on every engine.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sized {
  node: DiagramNode;
  width: number;
  height: number;
}

function sizeNode(node: DiagramNode, labelSize: number, sublabelSize: number): Sized {
  const labelWidth = estimateLabelWidth(node.label, labelSize);
  const sublabelWidth = node.sublabel ? estimateLabelWidth(node.sublabel, sublabelSize) : 0;

  const width = Math.min(
    MAX_NODE_WIDTH,
    Math.max(MIN_NODE_WIDTH, Math.max(labelWidth, sublabelWidth) + NODE_PADDING_X * 2),
  );

  // Wrapping is estimated, like every other pre-DOM measurement in the renderer.
  const lines = Math.max(1, Math.ceil(labelWidth / Math.max(1, width - NODE_PADDING_X * 2)));
  const height =
    NODE_PADDING_Y * 2 + lines * labelSize * 1.3 + (node.sublabel ? sublabelSize * 1.4 : 0);

  return { node, width: round(width), height: round(height) };
}

// ------------------------------------------------------------------- ranking

/**
 * Longest-path ranking, with declared ranks pinned.
 *
 * Cycles are normal in an architecture diagram — a Critic that routes work back
 * to the Layout Agent is a cycle — so this must terminate on one rather than
 * assume a DAG. The visit set does that: an edge that would revisit a node in the
 * current path is ignored for ranking and still drawn.
 */
function assignRanks(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, number> {
  const ranks = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of edges) {
    if (outgoing.has(edge.from) && outgoing.has(edge.to)) outgoing.get(edge.from)!.push(edge.to);
  }

  for (const node of nodes) {
    if (typeof node.rank === "number") ranks.set(node.id, node.rank);
  }

  const incoming = new Set(edges.map((edge) => edge.to));
  const roots = nodes.filter((node) => !incoming.has(node.id));
  // A fully cyclic diagram has no root; start from the first node so it still lays out.
  const starts = roots.length > 0 ? roots : nodes.slice(0, 1);

  const walk = (id: string, depth: number, path: Set<string>): void => {
    if (path.has(id)) return;
    const pinned = nodes.find((node) => node.id === id)?.rank;
    const rank = typeof pinned === "number" ? pinned : Math.max(depth, ranks.get(id) ?? 0);

    if (ranks.get(id) !== undefined && ranks.get(id)! >= rank && typeof pinned !== "number") {
      // Already placed at least this deep; nothing to propagate.
      if (ranks.get(id)! > rank) return;
    }
    ranks.set(id, rank);

    const next = new Set(path);
    next.add(id);
    for (const child of outgoing.get(id) ?? []) walk(child, rank + 1, next);
  };

  for (const start of starts) walk(start.id, ranks.get(start.id) ?? 0, new Set());
  for (const node of nodes) if (!ranks.has(node.id)) ranks.set(node.id, 0);

  // Normalise so the smallest rank is 0 — a declared negative rank is legal.
  const lowest = Math.min(...ranks.values());
  if (lowest !== 0) for (const [id, rank] of ranks) ranks.set(id, rank - lowest);

  return ranks;
}

/**
 * One barycentre sweep per rank, in fixed order.
 *
 * Two sweeps remove most crossings on the diagrams this renders; more iterations
 * buy little and every extra pass is another chance for the result to depend on
 * traversal order. Ties keep document order, which is what makes it stable.
 */
function orderWithinRanks(
  byRank: Map<number, string[]>,
  edges: DiagramEdge[],
  documentOrder: Map<string, number>,
): void {
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    (neighbours.get(edge.to) ?? neighbours.set(edge.to, []).get(edge.to)!).push(edge.from);
    (neighbours.get(edge.from) ?? neighbours.set(edge.from, []).get(edge.from)!).push(edge.to);
  }

  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  for (let pass = 0; pass < 2; pass += 1) {
    for (const rank of ranks) {
      const ids = byRank.get(rank)!;
      const positions = new Map<string, number>();
      for (const otherRank of ranks) {
        byRank.get(otherRank)!.forEach((id, index) => positions.set(id, index));
      }

      const barycentre = new Map<string, number>();
      for (const id of ids) {
        const linked = (neighbours.get(id) ?? []).filter((other) => positions.has(other));
        barycentre.set(
          id,
          linked.length === 0
            ? (documentOrder.get(id) ?? 0)
            : linked.reduce((sum, other) => sum + positions.get(other)!, 0) / linked.length,
        );
      }

      ids.sort((a, b) => {
        const delta = barycentre.get(a)! - barycentre.get(b)!;
        return delta !== 0 ? delta : (documentOrder.get(a) ?? 0) - (documentOrder.get(b) ?? 0);
      });
    }
  }
}

// ------------------------------------------------------------------ layouts

interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

function layeredLayout(
  sized: Sized[],
  edges: DiagramEdge[],
  box: { width: number; height: number },
  hint: { direction: string; nodeSpacing: number; rankSpacing: number },
): Map<string, Placement> {
  const nodes = sized.map((s) => s.node);
  const ranks = assignRanks(nodes, edges);
  const documentOrder = new Map(nodes.map((node, index) => [node.id, index]));

  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id)!;
    (byRank.get(rank) ?? byRank.set(rank, []).get(rank)!).push(node.id);
  }
  orderWithinRanks(byRank, edges, documentOrder);

  const sizeOf = new Map(sized.map((s) => [s.node.id, s]));
  const rankValues = [...byRank.keys()].sort((a, b) => a - b);
  const vertical = hint.direction === "TB" || hint.direction === "BT";

  // Along-rank extent per rank, then the cross-rank extent of the whole diagram.
  const rankExtent = rankValues.map((rank) => {
    const ids = byRank.get(rank)!;
    const sizes = ids.map((id) => sizeOf.get(id)!);
    const along = sizes.reduce(
      (sum, s) => sum + (vertical ? s.width : s.height),
      hint.nodeSpacing * (ids.length - 1),
    );
    const across = Math.max(...sizes.map((s) => (vertical ? s.height : s.width)));
    return { rank, ids, along, across };
  });

  const totalAcross = rankExtent.reduce(
    (sum, r) => sum + r.across,
    hint.rankSpacing * (rankExtent.length - 1),
  );

  const placements = new Map<string, Placement>();
  const forward = hint.direction === "RL" || hint.direction === "BT" ? -1 : 1;

  let acrossCursor =
    forward === 1
      ? Math.max(0, ((vertical ? box.height : box.width) - totalAcross) / 2)
      : (vertical ? box.height : box.width) -
        Math.max(0, ((vertical ? box.height : box.width) - totalAcross) / 2);

  for (const { ids, along, across } of rankExtent) {
    const acrossStart = forward === 1 ? acrossCursor : acrossCursor - across;
    let alongCursor = Math.max(0, ((vertical ? box.width : box.height) - along) / 2);

    for (const id of ids) {
      const size = sizeOf.get(id)!;
      const alongSize = vertical ? size.width : size.height;

      placements.set(id, {
        x: round(vertical ? alongCursor : acrossStart + (across - size.width) / 2),
        y: round(vertical ? acrossStart + (across - size.height) / 2 : alongCursor),
        width: size.width,
        height: size.height,
      });

      alongCursor += alongSize + hint.nodeSpacing;
    }

    acrossCursor += forward * (across + hint.rankSpacing);
  }

  return placements;
}

function gridLayout(
  sized: Sized[],
  box: { width: number; height: number },
  spacing: number,
): Map<string, Placement> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(sized.length)));
  const rows = Math.ceil(sized.length / columns);

  const cellWidth = Math.max(...sized.map((s) => s.width)) + spacing;
  const cellHeight = Math.max(...sized.map((s) => s.height)) + spacing;

  const offsetX = Math.max(0, (box.width - columns * cellWidth + spacing) / 2);
  const offsetY = Math.max(0, (box.height - rows * cellHeight + spacing) / 2);

  const placements = new Map<string, Placement>();
  sized.forEach((s, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    placements.set(s.node.id, {
      x: round(offsetX + column * cellWidth + (cellWidth - spacing - s.width) / 2),
      y: round(offsetY + row * cellHeight + (cellHeight - spacing - s.height) / 2),
      width: s.width,
      height: s.height,
    });
  });

  return placements;
}

function radialLayout(
  sized: Sized[],
  edges: DiagramEdge[],
  box: { width: number; height: number },
): Map<string, Placement> {
  const placements = new Map<string, Placement>();
  if (sized.length === 0) return placements;

  const ranks = assignRanks(
    sized.map((s) => s.node),
    edges,
  );

  const byDepth = new Map<number, Sized[]>();
  for (const s of sized) {
    const depth = ranks.get(s.node.id) ?? 0;
    (byDepth.get(depth) ?? byDepth.set(depth, []).get(depth)!).push(s);
  }

  const centreX = box.width / 2;
  const centreY = box.height / 2;
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const maxRadius = Math.min(box.width, box.height) / 2 - Math.max(...sized.map((s) => s.width)) / 2;
  const ringGap = depths.length > 1 ? maxRadius / (depths.length - 1) : 0;

  for (const depth of depths) {
    const ring = byDepth.get(depth)!;
    const radius = depth === 0 ? 0 : ringGap * depth;

    ring.forEach((s, index) => {
      // Start at 12 o'clock so a single child sits above its parent rather than
      // beside it, which reads as a hierarchy rather than a list.
      const angle = -Math.PI / 2 + (index / ring.length) * Math.PI * 2;
      placements.set(s.node.id, {
        x: round(centreX + radius * Math.cos(angle) - s.width / 2),
        y: round(centreY + radius * Math.sin(angle) - s.height / 2),
        width: s.width,
        height: s.height,
      });
    });
  }

  return placements;
}

/**
 * Seeded force layout with a fixed iteration count.
 *
 * Not an equilibrium solver — it runs exactly `ITERATIONS` steps and stops.
 * Running to convergence would make the result depend on a tolerance and on
 * floating-point order; a fixed count gives the same diagram every time, which
 * doc 02 §18.5 requires by making `seed` mandatory for this algorithm.
 */
function forceLayout(
  sized: Sized[],
  edges: DiagramEdge[],
  box: { width: number; height: number },
  seed: number,
): Map<string, Placement> {
  const ITERATIONS = 200;
  const random = seededRandom(seed);

  const positions = sized.map((s) => ({
    id: s.node.id,
    width: s.width,
    height: s.height,
    x: random() * box.width,
    y: random() * box.height,
    vx: 0,
    vy: 0,
  }));

  const index = new Map(positions.map((p) => [p.id, p]));
  const links = edges
    .map((edge) => ({ a: index.get(edge.from), b: index.get(edge.to) }))
    .filter((link): link is { a: (typeof positions)[number]; b: (typeof positions)[number] } =>
      Boolean(link.a && link.b),
    );

  const idealLength = Math.min(box.width, box.height) / Math.max(2, Math.sqrt(positions.length));
  const repulsion = idealLength * idealLength;

  for (let step = 0; step < ITERATIONS; step += 1) {
    const cooling = 1 - step / ITERATIONS;

    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const a = positions[i]!;
        const b = positions[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 0.01) {
          // Coincident nodes have no direction to separate along; nudge them
          // apart deterministically rather than with a fresh random.
          dx = (i - j) || 1;
          dy = 1;
          distance = Math.sqrt(dx * dx + dy * dy);
        }
        const force = repulsion / (distance * distance);
        a.vx += (dx / distance) * force;
        a.vy += (dy / distance) * force;
        b.vx -= (dx / distance) * force;
        b.vy -= (dy / distance) * force;
      }
    }

    for (const { a, b } of links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      const force = (distance - idealLength) * 0.08;
      a.vx += (dx / distance) * force;
      a.vy += (dy / distance) * force;
      b.vx -= (dx / distance) * force;
      b.vy -= (dy / distance) * force;
    }

    for (const p of positions) {
      p.x += Math.max(-20, Math.min(20, p.vx)) * cooling * 0.1;
      p.y += Math.max(-20, Math.min(20, p.vy)) * cooling * 0.1;
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x = Math.max(p.width / 2, Math.min(box.width - p.width / 2, p.x));
      p.y = Math.max(p.height / 2, Math.min(box.height - p.height / 2, p.y));
    }
  }

  return new Map(
    positions.map((p) => [
      p.id,
      { x: round(p.x - p.width / 2), y: round(p.y - p.height / 2), width: p.width, height: p.height },
    ]),
  );
}

// --------------------------------------------------------------------- edges

function anchorOn(placement: Placement, towards: Placement): { x: number; y: number } {
  const cx = placement.x + placement.width / 2;
  const cy = placement.y + placement.height / 2;
  const tx = towards.x + towards.width / 2;
  const ty = towards.y + towards.height / 2;

  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: round(cx), y: round(cy) };

  // Intersect the centre-to-centre ray with the box, so an edge meets the border
  // rather than disappearing under the node.
  const scaleX = dx === 0 ? Infinity : placement.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : placement.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return { x: round(cx + dx * scale), y: round(cy + dy * scale) };
}

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  vertical: boolean,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  // A gentle S-curve along the flow direction. Straight lines between ranks
  // collide with the nodes between them; an orthogonal router is Phase 8 work
  // and this reads correctly without it.
  const bend = vertical ? Math.abs(dy) * 0.4 : Math.abs(dx) * 0.4;

  const c1 = vertical
    ? { x: from.x, y: round(from.y + Math.sign(dy || 1) * bend) }
    : { x: round(from.x + Math.sign(dx || 1) * bend), y: from.y };
  const c2 = vertical
    ? { x: to.x, y: round(to.y - Math.sign(dy || 1) * bend) }
    : { x: round(to.x - Math.sign(dx || 1) * bend), y: to.y };

  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
}

function selfLoop(placement: Placement): string {
  const x = round(placement.x + placement.width);
  const y = round(placement.y + placement.height / 2);
  const r = 26;
  return `M ${x} ${round(y - 8)} C ${round(x + r)} ${round(y - r)} ${round(x + r)} ${round(y + r)} ${x} ${round(y + 8)}`;
}

// --------------------------------------------------------------------- build

export function buildDiagramPayload(
  element: DiagramElement,
  width: number,
  height: number,
  theme: ResolvedTheme,
): DiagramPayload {
  const warnings: string[] = [];
  const diagramTheme = theme.source.diagram;

  const nodeTypography = resolveTypography(
    theme,
    diagramTheme?.nodeTypography ?? {
      fontFamily: "token:typography.body.fontFamily",
      fontSize: 22,
      fontWeight: 600,
      color: "token:colors.foreground",
    },
  );
  const labelSize = nodeTypography.fontSize;
  const sublabelSize = round(labelSize * 0.72);
  const labelColor = String(nodeTypography.color ?? "#000");

  const edgeStroke = diagramTheme?.edgeStroke;
  const edgeColor =
    (edgeStroke && paintToCss(theme, edgeStroke.paint)) ??
    String(resolveValue(theme, "token:colors.foregroundMuted", "#888"));
  const edgeWidth = edgeStroke?.width ?? 2;
  const edgeLabelColor = String(
    resolveValue(theme, "token:colors.foregroundSubtle", edgeColor),
  );

  const defaultFill =
    (diagramTheme?.nodeFill && paintToCss(theme, diagramTheme.nodeFill)) ??
    String(resolveValue(theme, "token:colors.surface", "#eee"));
  const defaultStrokeColor =
    (diagramTheme?.nodeStroke && paintToCss(theme, diagramTheme.nodeStroke.paint)) ??
    String(resolveValue(theme, "token:colors.border", "#ccc"));
  const defaultStrokeWidth = diagramTheme?.nodeStroke?.width ?? 1;
  const nodeRadius = diagramTheme?.nodeRadius ?? 10;

  if (element.nodes.length === 0) {
    return {
      kind: "diagram",
      diagramType: element.diagramType,
      algorithm: "none",
      nodes: [],
      edges: [],
      groups: [],
      typography: nodeTypography,
      warnings,
      notice: "This diagram has no nodes.",
    };
  }

  const hint = element.layoutHint ?? {};
  const mode = hint.mode ?? "hybrid";
  const direction = hint.direction ?? (element.diagramType === "architecture" ? "LR" : "TB");
  const nodeSpacing = hint.nodeSpacing ?? 40;
  const rankSpacing = hint.rankSpacing ?? 90;

  let algorithm = hint.algorithm ?? "layered";
  if (algorithm === "force" && typeof hint.seed !== "number") {
    // Doc 02 §18.5 makes the seed mandatory precisely so this cannot happen
    // silently. Falling back to layered is better than inventing a seed and
    // producing a diagram that moves on the next open.
    warnings.push("A force layout needs a seed to be reproducible; laid out in layers instead.");
    algorithm = "layered";
  }

  const sized = element.nodes.map((node) => sizeNode(node, labelSize, sublabelSize));
  const box = { width, height };

  // Group labels need headroom, and a boundary drawn tight to its nodes reads as
  // a border on the node rather than around the set.
  const groupInset = (element.groups?.length ?? 0) > 0 ? GROUP_PADDING + GROUP_LABEL_SPACE : 0;
  const layoutBox = {
    width: Math.max(1, width - groupInset * 2),
    height: Math.max(1, height - groupInset * 2),
  };

  let placements: Map<string, Placement>;
  switch (algorithm) {
    case "grid":
      placements = gridLayout(sized, layoutBox, nodeSpacing);
      break;
    case "radial":
      placements = radialLayout(sized, element.edges, layoutBox);
      break;
    case "force":
      placements = forceLayout(sized, element.edges, layoutBox, hint.seed!);
      break;
    case "manual":
      placements = new Map(
        sized.map((s) => [
          s.node.id,
          {
            x: round(s.node.position?.x ?? 0),
            y: round(s.node.position?.y ?? 0),
            width: s.width,
            height: s.height,
          },
        ]),
      );
      break;
    default:
      placements = layeredLayout(sized, element.edges, layoutBox, {
        direction,
        nodeSpacing,
        rankSpacing,
      });
  }

  if (groupInset > 0) {
    for (const placement of placements.values()) {
      placement.x = round(placement.x + groupInset);
      placement.y = round(placement.y + groupInset);
    }
  }

  // Hybrid honours a user's drag and lays out everything else. Doc 02 §18.5 calls
  // out that silently discarding the drag is the one outcome that must not be
  // reachable, which is why "managed" has to be asked for explicitly.
  if (mode !== "managed" && algorithm !== "manual") {
    for (const s of sized) {
      if (s.node.position) {
        placements.set(s.node.id, {
          x: round(s.node.position.x),
          y: round(s.node.position.y),
          width: s.width,
          height: s.height,
        });
      }
    }
  }

  const roleStyles = diagramTheme?.roleStyles ?? {};

  const nodes: DiagramNodeMark[] = sized.map((s) => {
    const placement = placements.get(s.node.id)!;
    const role = s.node.role;
    const roleStyle = role ? roleStyles[role] : undefined;
    const own = s.node.style;

    const fill =
      (own?.fill && paintToCss(theme, own.fill)) ??
      (roleStyle?.fill && paintToCss(theme, roleStyle.fill)) ??
      defaultFill;
    const strokeSource = own?.stroke ?? roleStyle?.stroke ?? diagramTheme?.nodeStroke;

    return {
      id: s.node.id,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      radius: Number(own?.cornerRadius ?? roleStyle?.cornerRadius ?? nodeRadius),
      fill,
      stroke:
        (strokeSource && paintToCss(theme, strokeSource.paint)) ?? defaultStrokeColor,
      strokeWidth: strokeSource?.width ?? defaultStrokeWidth,
      dash: strokeSource?.dash?.join(" "),
      label: s.node.label,
      sublabel: s.node.sublabel,
      labelColor,
      labelSize,
      sublabelSize,
      role,
    };
  });

  const vertical = direction === "TB" || direction === "BT";

  const edges: DiagramEdgeMark[] = element.edges.flatMap((edge) => {
    const from = placements.get(edge.from);
    const to = placements.get(edge.to);

    if (!from || !to) {
      // A dangling edge is a document error the validator reports; drawing it to
      // nowhere would be worse than omitting it, but it must not be silent.
      warnings.push(`Edge ${edge.id} points at a node that is not in this diagram.`);
      return [];
    }

    const selfEdge = edge.from === edge.to;
    const start = selfEdge ? { x: 0, y: 0 } : anchorOn(from, to);
    const end = selfEdge ? { x: 0, y: 0 } : anchorOn(to, from);

    const d = selfEdge ? selfLoop(from) : edgePath(start, end, vertical);
    const direction_ = edge.direction ?? "forward";

    const dash =
      edge.kind === "dashed" ? "8 6" : edge.kind === "dotted" ? "2 6" : edgeStroke?.dash?.join(" ");

    return [
      {
        id: edge.id,
        d,
        stroke: (edge.style?.stroke && paintToCss(theme, edge.style.stroke.paint)) ?? edgeColor,
        strokeWidth: edge.style?.stroke?.width ?? (edge.weight ? Math.max(1, edge.weight) : edgeWidth),
        dash,
        markerStart: direction_ === "reverse" || direction_ === "both",
        markerEnd: direction_ === "forward" || direction_ === "both",
        label: edge.label
          ? {
              text: edge.label,
              x: round(selfEdge ? from.x + from.width + 26 : (start.x + end.x) / 2),
              y: round(selfEdge ? from.y - 8 : (start.y + end.y) / 2 - 8),
              size: sublabelSize,
              color: edgeLabelColor,
            }
          : undefined,
      },
    ];
  });

  const boundaryStyle = diagramTheme?.boundaryStyle;
  const groups: DiagramGroupMark[] = (element.groups ?? []).flatMap((group) => {
    const members = group.nodeIds
      .map((id) => placements.get(id))
      .filter((placement): placement is Placement => placement !== undefined);

    if (members.length === 0) return [];

    const minX = Math.min(...members.map((m) => m.x)) - GROUP_PADDING;
    const minY = Math.min(...members.map((m) => m.y)) - GROUP_PADDING - GROUP_LABEL_SPACE;
    const maxX = Math.max(...members.map((m) => m.x + m.width)) + GROUP_PADDING;
    const maxY = Math.max(...members.map((m) => m.y + m.height)) + GROUP_PADDING;

    const stroke = group.style?.stroke ?? boundaryStyle?.stroke;

    return [
      {
        id: group.id,
        x: round(minX),
        y: round(minY),
        width: round(maxX - minX),
        height: round(maxY - minY),
        radius: Number(group.style?.cornerRadius ?? boundaryStyle?.cornerRadius ?? 14),
        fill:
          (group.style?.fill && paintToCss(theme, group.style.fill)) ??
          (boundaryStyle?.fill && paintToCss(theme, boundaryStyle.fill)) ??
          undefined,
        stroke: (stroke && paintToCss(theme, stroke.paint)) ?? defaultStrokeColor,
        strokeWidth: stroke?.width ?? 1,
        // A boundary is dashed by convention: it marks a region, not an object.
        dash: stroke?.dash?.join(" ") ?? (group.kind === "boundary" ? "10 8" : undefined),
        label: group.label
          ? {
              text: group.label,
              x: round(minX + GROUP_PADDING),
              y: round(minY + GROUP_LABEL_SPACE * 0.75),
              size: sublabelSize,
              color: edgeLabelColor,
            }
          : undefined,
      },
    ];
  });

  // Labels are resolved geometry, shared by editor and exports. Reserve node
  // and group-heading bounds, then choose the nearest clear candidate in
  // document order. Reciprocal edges must not paint their labels on each other.
  const overlaps = (a: Placement, b: Placement) =>
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
  const occupied: Placement[] = [...placements.values()];
  for (const group of groups) {
    if (group.label) occupied.push({
      x: group.label.x - 4, y: group.label.y - sublabelSize - 4,
      width: estimateLabelWidth(group.label.text, sublabelSize) + 8,
      height: sublabelSize * 1.3 + 8,
    });
  }
  for (const edge of edges) {
    const label = edge.label;
    if (!label) continue;
    const labelWidth = estimateLabelWidth(label.text, label.size) + 12;
    const labelHeight = label.size * 1.3 + 8;
    let found = false;
    // Search nearby horizontal offsets as well: a label wider than a narrow
    // inter-node gap should not jump above an unrelated edge to find room.
    const candidates: { x: number; y: number; distance: number }[] = [];
    // Document dimensions are user data. Cap work even for an enormous box.
    for (let lane = 0; lane <= Math.min(64, Math.ceil(height / labelHeight) * 2); lane++) {
      const dy = Math.ceil(lane / 2) * labelHeight * (lane % 2 ? -1 : 1);
      for (const dx of [0, labelWidth / 4, -labelWidth / 4, labelWidth / 2, -labelWidth / 2]) {
        candidates.push({ x: label.x + dx, y: label.y + dy, distance: dx * dx + dy * dy });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      const x = round(candidate.x);
      const y = round(candidate.y);
      const bounds = { x: x - labelWidth / 2, y: y - label.size - 4,
        width: labelWidth, height: labelHeight };
      if (bounds.x < 0 || bounds.x + bounds.width > width || bounds.y < 0 ||
          bounds.y + bounds.height > height || occupied.some(other => overlaps(bounds, other))) continue;
      label.x = round(x);
      label.y = y;
      occupied.push(bounds);
      found = true;
      break;
    }
    if (!found) warnings.push(`Edge ${edge.id} has no clear space for its label; enlarge or rearrange the diagram.`);
  }

  return {
    kind: "diagram",
    diagramType: element.diagramType,
    algorithm,
    nodes,
    edges,
    groups,
    typography: nodeTypography,
    warnings,
  };
}

export const DIAGRAM_INTERNALS = { assignRanks, seededRandom, anchorOn, sizeNode };
