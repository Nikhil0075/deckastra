import type { Insets, Point, Rect } from "@deckastra/presentation-schema";

/**
 * Snapping and guides (doc 04 §14).
 *
 * Thresholds are divided by zoom throughout, so snapping feels the same at 25%
 * and 400%. A fixed world-space threshold snaps from a mile away when zoomed out
 * and is unusable when zoomed in.
 */

/** Constant 8px on screen (doc 04 §14.2). */
export const SNAP_THRESHOLD = 8;
/** How far around the dragged element to look for neighbours (doc 04 §14.1). */
export const SNAP_SEARCH = 200;
/** Candidate cap, so a dense slide cannot make dragging quadratic. */
export const MAX_NEIGHBOURS = 40;
/** Never show more than this many guides at once (doc 04 §14.4). */
export const MAX_GUIDES = 4;

export type SnapAxis = "x" | "y";

/**
 * Priority on ties (doc 04 §14.2): slide centre > safe area > neighbour edge >
 * neighbour centre > grid. Lower sorts first.
 */
export const SNAP_PRIORITY = {
  slideCenter: 0,
  slideEdge: 1,
  safeArea: 2,
  neighbourEdge: 3,
  neighbourCenter: 4,
  grid: 5,
} as const;

export type SnapKind = keyof typeof SNAP_PRIORITY;

export interface SnapLine {
  axis: SnapAxis;
  /** World coordinate of the line. */
  position: number;
  kind: SnapKind;
  /** The element that produced it, for drawing the guide's extent. */
  sourceId?: string;
  /** Extent along the other axis, so a guide is drawn only as far as it means. */
  from?: number;
  to?: number;
}

export interface SnapCandidateSource {
  slide: Rect;
  safeArea?: Insets;
  gridUnit?: number;
  gridEnabled?: boolean;
  /** Neighbours to snap against. The dragged element must not be in here — it
   *  would snap to itself and never move. */
  neighbours: { id: string; bounds: Rect }[];
}

export function collectSnapLines(source: SnapCandidateSource): SnapLine[] {
  const lines: SnapLine[] = [];
  const { slide } = source;

  lines.push(
    { axis: "x", position: slide.x, kind: "slideEdge" },
    { axis: "x", position: slide.x + slide.width / 2, kind: "slideCenter" },
    { axis: "x", position: slide.x + slide.width, kind: "slideEdge" },
    { axis: "y", position: slide.y, kind: "slideEdge" },
    { axis: "y", position: slide.y + slide.height / 2, kind: "slideCenter" },
    { axis: "y", position: slide.y + slide.height, kind: "slideEdge" },
  );

  if (source.safeArea) {
    const s = source.safeArea;
    lines.push(
      { axis: "x", position: slide.x + s.left, kind: "safeArea" },
      { axis: "x", position: slide.x + slide.width - s.right, kind: "safeArea" },
      { axis: "y", position: slide.y + s.top, kind: "safeArea" },
      { axis: "y", position: slide.y + slide.height - s.bottom, kind: "safeArea" },
    );
  }

  for (const neighbour of source.neighbours.slice(0, MAX_NEIGHBOURS)) {
    const b = neighbour.bounds;
    lines.push(
      { axis: "x", position: b.x, kind: "neighbourEdge", sourceId: neighbour.id, from: b.y, to: b.y + b.height },
      { axis: "x", position: b.x + b.width / 2, kind: "neighbourCenter", sourceId: neighbour.id, from: b.y, to: b.y + b.height },
      { axis: "x", position: b.x + b.width, kind: "neighbourEdge", sourceId: neighbour.id, from: b.y, to: b.y + b.height },
      { axis: "y", position: b.y, kind: "neighbourEdge", sourceId: neighbour.id, from: b.x, to: b.x + b.width },
      { axis: "y", position: b.y + b.height / 2, kind: "neighbourCenter", sourceId: neighbour.id, from: b.x, to: b.x + b.width },
      { axis: "y", position: b.y + b.height, kind: "neighbourEdge", sourceId: neighbour.id, from: b.x, to: b.x + b.width },
    );
  }

  return lines;
}

export interface SnapResult {
  delta: Point;
  /** Guides to draw. Empty when nothing snapped. */
  guides: SnapLine[];
}

export interface SnapOptions {
  zoom: number;
  /** Cmd/Ctrl: disable snapping entirely (doc 04 §14.5). */
  disabled?: boolean;
  gridUnit?: number;
  gridEnabled?: boolean;
}

/**
 * Snap a dragged rectangle to the nearest candidate on each axis.
 *
 * One candidate per axis, never two (doc 04 §14.2): applying two on the same axis
 * means the second overrides the first and the element lands somewhere neither
 * guide showed.
 */
export function snapRect(
  rect: Rect,
  lines: readonly SnapLine[],
  options: SnapOptions,
): SnapResult {
  if (options.disabled) return { delta: { x: 0, y: 0 }, guides: [] };

  const threshold = SNAP_THRESHOLD / Math.max(options.zoom, 0.01);

  const edgesX = [
    { offset: 0, value: rect.x },
    { offset: rect.width / 2, value: rect.x + rect.width / 2 },
    { offset: rect.width, value: rect.x + rect.width },
  ];
  const edgesY = [
    { offset: 0, value: rect.y },
    { offset: rect.height / 2, value: rect.y + rect.height / 2 },
    { offset: rect.height, value: rect.y + rect.height },
  ];

  const best = {
    x: pickBest(edgesX, lines.filter((line) => line.axis === "x"), threshold),
    y: pickBest(edgesY, lines.filter((line) => line.axis === "y"), threshold),
  };

  const guides: SnapLine[] = [];
  if (best.x) guides.push(best.x.line);
  if (best.y) guides.push(best.y.line);

  const delta = { x: best.x?.delta ?? 0, y: best.y?.delta ?? 0 };

  // Grid is the last resort: only when nothing better claimed the axis.
  if (options.gridEnabled && options.gridUnit) {
    const unit = options.gridUnit;
    if (!best.x) {
      const snapped = Math.round(rect.x / unit) * unit;
      if (Math.abs(snapped - rect.x) <= threshold) {
        delta.x = snapped - rect.x;
        guides.push({ axis: "x", position: snapped, kind: "grid" });
      }
    }
    if (!best.y) {
      const snapped = Math.round(rect.y / unit) * unit;
      if (Math.abs(snapped - rect.y) <= threshold) {
        delta.y = snapped - rect.y;
        guides.push({ axis: "y", position: snapped, kind: "grid" });
      }
    }
  }

  return { delta, guides: guides.slice(0, MAX_GUIDES) };
}

function pickBest(
  edges: readonly { offset: number; value: number }[],
  lines: readonly SnapLine[],
  threshold: number,
): { delta: number; line: SnapLine } | undefined {
  let best: { delta: number; line: SnapLine; distance: number; priority: number } | undefined;

  for (const line of lines) {
    for (const edge of edges) {
      const distance = Math.abs(line.position - edge.value);
      if (distance > threshold) continue;

      const priority = SNAP_PRIORITY[line.kind];
      const better =
        !best ||
        distance < best.distance - 0.001 ||
        // Equal distance falls back to priority, so a slide centre beats a
        // neighbour edge that happens to sit on the same line.
        (Math.abs(distance - best.distance) <= 0.001 && priority < best.priority);

      if (better) {
        best = { delta: line.position - edge.value, line, distance, priority };
      }
    }
  }

  return best ? { delta: best.delta, line: best.line } : undefined;
}

export interface SpacingGuide {
  axis: SnapAxis;
  gap: number;
  /** Rects between which the equal gaps were found, for drawing the indicators. */
  between: Rect[];
}

/**
 * Equal-spacing detection (doc 04 §14.3).
 *
 * When the dragged element sits among aligned neighbours, offer a position that
 * equalizes the gaps. This is the guide people actually rely on when laying out a
 * row of cards, and it is why "nudge until it looks right" stops being necessary.
 */
export function findEqualSpacing(
  dragged: Rect,
  neighbours: readonly Rect[],
  axis: SnapAxis,
  threshold: number,
): { delta: number; guide: SpacingGuide } | undefined {
  const start = (rect: Rect) => (axis === "x" ? rect.x : rect.y);
  const size = (rect: Rect) => (axis === "x" ? rect.width : rect.height);
  const crossStart = (rect: Rect) => (axis === "x" ? rect.y : rect.x);
  const crossSize = (rect: Rect) => (axis === "x" ? rect.height : rect.width);

  // Only neighbours that overlap on the cross axis are in the same row or column;
  // otherwise "equal spacing" would relate elements that are nowhere near each
  // other.
  const aligned = neighbours.filter(
    (rect) =>
      crossStart(rect) < crossStart(dragged) + crossSize(dragged) &&
      crossStart(dragged) < crossStart(rect) + crossSize(rect),
  );

  if (aligned.length < 2) return undefined;

  const sorted = [...aligned].sort((a, b) => start(a) - start(b));

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i]!;
    const right = sorted[i + 1]!;

    const gapBefore = start(dragged) - (start(left) + size(left));
    const gapAfter = start(right) - (start(dragged) + size(dragged));

    const target = (start(right) - (start(left) + size(left)) - size(dragged)) / 2;
    const desiredStart = start(left) + size(left) + target;
    const delta = desiredStart - start(dragged);

    if (Math.abs(delta) <= threshold && Math.abs(gapBefore - gapAfter) <= threshold * 2) {
      return {
        delta,
        guide: { axis, gap: Math.round(target * 100) / 100, between: [left, dragged, right] },
      };
    }
  }

  return undefined;
}

/**
 * Constrain a drag to the axis of greatest movement (Shift, doc 04 §14.5).
 *
 * Measured from the whole gesture, not the last frame — using the frame delta
 * makes the axis flip whenever the pointer wobbles.
 */
export function constrainToAxis(totalDelta: Point): Point {
  return Math.abs(totalDelta.x) >= Math.abs(totalDelta.y)
    ? { x: totalDelta.x, y: 0 }
    : { x: 0, y: totalDelta.y };
}

/** Arrow key nudges (doc 04 §14.5). */
export function nudgeDistance(shift: boolean, gridUnit = 8): number {
  return shift ? gridUnit : 1;
}
