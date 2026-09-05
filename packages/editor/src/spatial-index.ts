import type { Point, Rect } from "@deckastra/presentation-schema";

/**
 * Spatial index (doc 04 §11.2).
 *
 * Native pointer events answer single-point queries for free; this exists for the
 * rectangle queries the DOM cannot answer — marquee selection, snap candidate
 * search, and pairwise collision detection.
 *
 * A uniform grid rather than an R-tree. Slides hold tens to hundreds of objects
 * inside a fixed 1920×1080 space, which is exactly the shape a grid handles best:
 * O(1) insert, no rebalancing, and no dependency. An R-tree earns its keep on
 * unbounded coordinate spaces with millions of entries, which this is not.
 */

/** Below this many objects a linear scan beats maintaining the index
 *  (doc 04 §11.2). */
export const INDEX_THRESHOLD = 40;

const DEFAULT_CELL = 160;

export interface IndexEntry {
  id: string;
  bounds: Rect;
}

export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, Rect>();
  private readonly excluded = new Set<string>();

  constructor(private readonly cellSize: number = DEFAULT_CELL) {}

  get size(): number {
    return this.entries.size - this.excluded.size;
  }

  rebuild(items: readonly IndexEntry[]): void {
    this.cells.clear();
    this.entries.clear();
    for (const item of items) this.insert(item.id, item.bounds);
  }

  insert(id: string, bounds: Rect): void {
    this.remove(id);
    this.entries.set(id, bounds);
    for (const key of this.keysFor(bounds)) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(id);
    }
  }

  update(id: string, bounds: Rect): void {
    this.insert(id, bounds);
  }

  remove(id: string): void {
    const existing = this.entries.get(id);
    if (!existing) return;

    for (const key of this.keysFor(existing)) {
      const cell = this.cells.get(key);
      cell?.delete(id);
      if (cell && cell.size === 0) this.cells.delete(key);
    }
    this.entries.delete(id);
  }

  /**
   * Temporarily hide an entry from queries.
   *
   * The dragged element is excluded during a drag so it cannot snap to itself —
   * which it would do, at zero distance, on every axis, and therefore never move
   * (doc 04 §11.2).
   */
  exclude(id: string): void {
    this.excluded.add(id);
  }

  include(id: string): void {
    this.excluded.delete(id);
  }

  clearExclusions(): void {
    this.excluded.clear();
  }

  search(rect: Rect): string[] {
    const found = new Set<string>();

    for (const key of this.keysFor(rect)) {
      for (const id of this.cells.get(key) ?? []) {
        if (this.excluded.has(id)) continue;
        const bounds = this.entries.get(id);
        // Cell membership is a broad phase; a real intersection test still runs.
        if (bounds && intersects(bounds, rect)) found.add(id);
      }
    }

    // Sorted so a query returns the same order every time — an unstable order
    // makes snapping pick different candidates between identical frames.
    return [...found].sort();
  }

  nearest(point: Point, radius: number): string[] {
    const rect: Rect = {
      x: point.x - radius,
      y: point.y - radius,
      width: radius * 2,
      height: radius * 2,
    };

    return this.search(rect)
      .map((id) => ({ id, distance: distanceToRect(point, this.entries.get(id)!) }))
      .filter((hit) => hit.distance <= radius)
      .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
      .map((hit) => hit.id);
  }

  boundsOf(id: string): Rect | undefined {
    return this.entries.get(id);
  }

  private *keysFor(rect: Rect): Generator<string> {
    const minX = Math.floor(rect.x / this.cellSize);
    const maxX = Math.floor((rect.x + rect.width) / this.cellSize);
    const minY = Math.floor(rect.y / this.cellSize);
    const maxY = Math.floor((rect.y + rect.height) / this.cellSize);

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) yield `${x}:${y}`;
    }
  }
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function distanceToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/**
 * Hit tolerance in world units (doc 04 §11.4).
 *
 * Constant on screen regardless of zoom. Applied to strokes, connectors and empty
 * text boxes — never to filled shapes, where it makes overlapping stacks feel
 * imprecise.
 */
export function hitTolerance(zoom: number): number {
  return 6 / Math.max(zoom, 0.01);
}

export function pointInRect(point: Point, rect: Rect, tolerance = 0): boolean {
  return (
    point.x >= rect.x - tolerance &&
    point.x <= rect.x + rect.width + tolerance &&
    point.y >= rect.y - tolerance &&
    point.y <= rect.y + rect.height + tolerance
  );
}

/** Point-in-ellipse, in the element's own space. */
export function pointInEllipse(point: Point, rect: Rect): boolean {
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  if (rx <= 0 || ry <= 0) return false;

  const nx = (point.x - (rect.x + rx)) / rx;
  const ny = (point.y - (rect.y + ry)) / ry;
  return nx * nx + ny * ny <= 1;
}

/** Distance from a point to a polyline, for connectors (doc 04 §11.3). */
export function distanceToPolyline(point: Point, points: readonly Point[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);

  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(best, distanceToSegment(point, points[i]!, points[i + 1]!));
  }
  return best;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );

  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
