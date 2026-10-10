/**
 * Presenter ink: pen, highlighter, eraser and laser over a slide being presented
 * (UI audit 2026-10-10, unit 6).
 *
 * Ink is session state, never the document's (doc 02 §4.1): it belongs to this
 * run of this talk, the way the elapsed time does. The one way it reaches a deck
 * is "Save annotated copy", which writes a *copy* (`inkAnnotationOperations`).
 *
 * Two windows draw on one talk, so the rules that keep them agreeing live here,
 * where they can be tested without a channel or a React tree:
 *
 * - **The audience window is the authority**, as it already is for the slide and
 *   the reveal. It applies every command in arrival order (`InkSession`) and
 *   answers with a snapshot of the slide on screen. A presenter window never
 *   applies a command itself; it shows its own strokes optimistically until the
 *   authority has acknowledged them (`InkMirror`).
 * - **Commands are idempotent.** A stroke is named by an id its author minted, so
 *   a repeated `add` is nothing, an `erase` of a stroke that has gone is nothing,
 *   and a command whose sequence number the authority has already seen from that
 *   sender is nothing. A replay after a reconnect cannot draw a stroke twice.
 * - **Undo is resolved by the authority**, per slide. Two windows each replaying
 *   their own undo would undo two different things.
 * - **Coordinates are 0–1 of the slide**, not of a window. The two windows show the
 *   slide at different sizes and letterboxes; a stroke made at the corner of the
 *   slide on a laptop lands at the corner of the slide on a projector.
 * - **Everything that arrives is checked** (`sanitizeStroke`, `sanitizeInkOp`):
 *   the channel is a page's, and a message is data, not a drawing instruction.
 */

export type InkTool = "pen" | "highlighter" | "eraser" | "laser";
export type InkKind = "pen" | "highlighter";
export type InkPoint = [number, number];

export interface InkStroke {
  id: string;
  slideId: string;
  tool: InkKind;
  color: string;
  /** Logical presentation pixels, like every length in a deck. */
  width: number;
  /** 0–1 of the slide, x then y. */
  points: InkPoint[];
}

/**
 * The colours a stroke may have. An allowlist: the value reaches an SVG
 * attribute in another window, and a colour is all it needs to be.
 */
export const INK_COLORS = ["#FF3B30", "#FFCC00", "#0A84FF", "#30D158", "#FFFFFF", "#111111"] as const;
export const INK_COLOR_NAMES: Record<(typeof INK_COLORS)[number], string> = {
  "#FF3B30": "Red",
  "#FFCC00": "Yellow",
  "#0A84FF": "Blue",
  "#30D158": "Green",
  "#FFFFFF": "White",
  "#111111": "Black",
};
export const INK_WIDTH = { pen: 6, highlighter: 28 } as const;
export const MAX_POINTS = 2000;
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 48;

export type InkOp =
  | { op: "add"; stroke: InkStroke }
  | { op: "erase"; slideId: string; strokeId: string }
  | { op: "undo"; slideId: string }
  | { op: "redo"; slideId: string }
  | { op: "clear-slide"; slideId: string }
  | { op: "clear-all" };

/** A command as it travels: who sent it, in what order, and what it asks. */
export interface InkCommand {
  sender: string;
  seq: number;
  op: InkOp;
}

/** What the authority says after every change, about the slide on screen. */
export interface InkSnapshot {
  rev: number;
  slideId: string;
  strokes: InkStroke[];
  canUndo: boolean;
  canRedo: boolean;
  /** The last sequence number applied from each sender. */
  acks: Record<string, number>;
}

/** One undoable change, kept so it can be reversed exactly. */
type Change =
  | { kind: "add"; slideId: string; stroke: InkStroke }
  | { kind: "erase"; slideId: string; stroke: InkStroke; index: number }
  | { kind: "clear"; slideId: string; strokes: InkStroke[] };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLIDE_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const COLORS = new Set<string>(INK_COLORS);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A stroke from another window, or null when it is not one. Coordinates are clamped, never trusted. */
export function sanitizeStroke(raw: unknown): InkStroke | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID.test(value.id)) return null;
  if (typeof value.slideId !== "string" || !SLIDE_ID.test(value.slideId)) return null;
  if (value.tool !== "pen" && value.tool !== "highlighter") return null;
  if (typeof value.color !== "string" || !COLORS.has(value.color)) return null;
  if (typeof value.width !== "number" || !Number.isFinite(value.width)) return null;
  if (!Array.isArray(value.points) || value.points.length === 0 || value.points.length > MAX_POINTS) return null;
  const points: InkPoint[] = [];
  for (const point of value.points) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [x, y] = point as unknown[];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push([clamp01(x), clamp01(y)]);
  }
  return {
    id: value.id,
    slideId: value.slideId,
    tool: value.tool,
    color: value.color,
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value.width)),
    points,
  };
}

/** An operation from another window, or null. Unknown operations are ignored, not guessed at. */
export function sanitizeInkOp(raw: unknown): InkOp | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const slideId = typeof value.slideId === "string" && SLIDE_ID.test(value.slideId) ? value.slideId : null;
  switch (value.op) {
    case "add": {
      const stroke = sanitizeStroke(value.stroke);
      return stroke ? { op: "add", stroke } : null;
    }
    case "erase":
      return slideId && typeof value.strokeId === "string" && ID.test(value.strokeId)
        ? { op: "erase", slideId, strokeId: value.strokeId }
        : null;
    case "undo":
    case "redo":
    case "clear-slide":
      return slideId ? { op: value.op, slideId } : null;
    case "clear-all":
      return { op: "clear-all" };
    default:
      return null;
  }
}

export function sanitizeInkCommand(raw: unknown): InkCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.sender !== "string" || !ID.test(value.sender)) return null;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return null;
  const op = sanitizeInkOp(value.op);
  return op ? { sender: value.sender, seq: value.seq, op } : null;
}

export function sanitizeInkSnapshot(raw: unknown): InkSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.rev !== "number" || !Number.isInteger(value.rev) || value.rev < 0) return null;
  if (typeof value.slideId !== "string" || !SLIDE_ID.test(value.slideId)) return null;
  if (!Array.isArray(value.strokes) || value.strokes.length > 1000) return null;
  const strokes: InkStroke[] = [];
  for (const one of value.strokes) {
    const stroke = sanitizeStroke(one);
    if (stroke && stroke.slideId === value.slideId) strokes.push(stroke);
  }
  const acks: Record<string, number> = {};
  if (value.acks && typeof value.acks === "object") {
    for (const [sender, seq] of Object.entries(value.acks as Record<string, unknown>)) {
      if (ID.test(sender) && typeof seq === "number" && Number.isInteger(seq) && seq >= 0) acks[sender] = seq;
    }
  }
  return { rev: value.rev, slideId: value.slideId, strokes, canUndo: value.canUndo === true, canRedo: value.canRedo === true, acks };
}

/**
 * The authority's copy of the session's ink.
 *
 * Mutable on purpose: it lives in a ref in the audience window, every change
 * bumps `rev`, and the component re-renders from `rev`. An immutable copy per
 * point would be a copy of every stroke on every slide for each command.
 */
export class InkSession {
  rev = 0;
  private readonly bySlide = new Map<string, InkStroke[]>();
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private readonly lastSeq = new Map<string, number>();

  strokes(slideId: string): InkStroke[] {
    return this.bySlide.get(slideId) ?? [];
  }

  /** Every slide that has ink, for saving an annotated copy. */
  all(): Map<string, InkStroke[]> {
    return new Map([...this.bySlide].filter(([, strokes]) => strokes.length > 0));
  }

  count(): number {
    let total = 0;
    for (const strokes of this.bySlide.values()) total += strokes.length;
    return total;
  }

  canUndo(slideId: string): boolean {
    return this.undoStack.some((change) => change.slideId === slideId);
  }

  canRedo(slideId: string): boolean {
    return this.redoStack.some((change) => change.slideId === slideId);
  }

  /**
   * A command from a window. Applied once per sender and sequence number, in
   * arrival order; a stale or repeated one is acknowledged and does nothing.
   */
  accept(command: InkCommand): boolean {
    const seen = this.lastSeq.get(command.sender) ?? 0;
    if (command.seq <= seen) return false;
    this.lastSeq.set(command.sender, command.seq);
    return this.apply(command.op);
  }

  /** Apply one operation. Returns whether anything changed. */
  apply(op: InkOp): boolean {
    const changed = this.applyInner(op);
    if (changed) this.rev += 1;
    return changed;
  }

  private applyInner(op: InkOp): boolean {
    switch (op.op) {
      case "add": {
        const list = this.list(op.stroke.slideId);
        if (list.some((stroke) => stroke.id === op.stroke.id)) return false;
        list.push(op.stroke);
        this.record({ kind: "add", slideId: op.stroke.slideId, stroke: op.stroke });
        return true;
      }
      case "erase": {
        const list = this.list(op.slideId);
        const index = list.findIndex((stroke) => stroke.id === op.strokeId);
        if (index < 0) return false;
        const [stroke] = list.splice(index, 1);
        this.record({ kind: "erase", slideId: op.slideId, stroke: stroke!, index });
        return true;
      }
      case "clear-slide": {
        const list = this.list(op.slideId);
        if (list.length === 0) return false;
        const strokes = list.splice(0, list.length);
        this.record({ kind: "clear", slideId: op.slideId, strokes });
        return true;
      }
      case "clear-all": {
        if (this.count() === 0 && this.undoStack.length === 0 && this.redoStack.length === 0) return false;
        // Not undoable: it is "start again", and an undo that brought back the
        // whole talk's ink one slide at a time would be a surprise in front of a room.
        this.bySlide.clear();
        this.undoStack = [];
        this.redoStack = [];
        return true;
      }
      case "undo": {
        const at = lastIndexWhere(this.undoStack, (change) => change.slideId === op.slideId);
        if (at < 0) return false;
        const [change] = this.undoStack.splice(at, 1);
        this.reverse(change!);
        this.redoStack.push(change!);
        return true;
      }
      case "redo": {
        const at = lastIndexWhere(this.redoStack, (change) => change.slideId === op.slideId);
        if (at < 0) return false;
        const [change] = this.redoStack.splice(at, 1);
        this.replay(change!);
        this.undoStack.push(change!);
        return true;
      }
    }
  }

  /** A new change on a slide ends that slide's redo history, and no other slide's. */
  private record(change: Change): void {
    this.undoStack.push(change);
    this.redoStack = this.redoStack.filter((one) => one.slideId !== change.slideId);
  }

  private reverse(change: Change): void {
    const list = this.list(change.slideId);
    if (change.kind === "add") {
      const index = list.findIndex((stroke) => stroke.id === change.stroke.id);
      if (index >= 0) list.splice(index, 1);
    } else if (change.kind === "erase") {
      list.splice(Math.min(change.index, list.length), 0, change.stroke);
    } else {
      list.push(...change.strokes);
    }
  }

  private replay(change: Change): void {
    const list = this.list(change.slideId);
    if (change.kind === "add") list.push(change.stroke);
    else if (change.kind === "erase") {
      const index = list.findIndex((stroke) => stroke.id === change.stroke.id);
      if (index >= 0) list.splice(index, 1);
    } else {
      const ids = new Set(change.strokes.map((stroke) => stroke.id));
      const kept = list.filter((stroke) => !ids.has(stroke.id));
      list.splice(0, list.length, ...kept);
    }
  }

  private list(slideId: string): InkStroke[] {
    let list = this.bySlide.get(slideId);
    if (!list) {
      list = [];
      this.bySlide.set(slideId, list);
    }
    return list;
  }

  snapshot(slideId: string): InkSnapshot {
    return {
      rev: this.rev,
      slideId,
      strokes: this.strokes(slideId).map((stroke) => ({ ...stroke })),
      canUndo: this.canUndo(slideId),
      canRedo: this.canRedo(slideId),
      acks: Object.fromEntries(this.lastSeq),
    };
  }
}

function lastIndexWhere<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i]!)) return i;
  return -1;
}

/**
 * A presenter window's view of the ink: the authority's last snapshot, plus the
 * strokes this window has drawn that the authority has not yet acknowledged.
 *
 * A snapshot older than the last one seen is ignored — a reordered or late
 * message must never take back a newer state. A pending stroke is dropped once
 * the authority acknowledges its sequence number, whether or not the stroke
 * survived: if the authority applied an undo after it, the snapshot is right.
 */
export class InkMirror {
  private snapshotValue: InkSnapshot | null = null;
  private pending: Array<{ seq: number; op: InkOp }> = [];
  private nextSeq = 1;

  constructor(readonly sender: string) {}

  /** Number this window's next command. */
  command(op: InkOp): InkCommand {
    const command = { sender: this.sender, seq: this.nextSeq, op };
    this.nextSeq += 1;
    this.pending.push({ seq: command.seq, op });
    return command;
  }

  /** A snapshot arrived. Returns whether it was newer than the one held. */
  receive(snapshot: InkSnapshot): boolean {
    const held = this.snapshotValue;
    if (held && snapshot.rev < held.rev) return false;
    if (held && snapshot.rev === held.rev && snapshot.slideId === held.slideId) {
      this.acknowledge(snapshot);
      return false;
    }
    this.snapshotValue = snapshot;
    this.acknowledge(snapshot);
    return true;
  }

  private acknowledge(snapshot: InkSnapshot): void {
    const acked = snapshot.acks[this.sender] ?? 0;
    this.pending = this.pending.filter((one) => one.seq > acked);
  }

  get snapshot(): InkSnapshot | null {
    return this.snapshotValue;
  }

  /** What to draw on `slideId`: the authority's strokes, then this window's own not yet acknowledged. */
  strokes(slideId: string): InkStroke[] {
    const base = this.snapshotValue?.slideId === slideId ? [...this.snapshotValue.strokes] : [];
    for (const { op } of this.pending) {
      if (op.op === "add" && op.stroke.slideId === slideId && !base.some((one) => one.id === op.stroke.id)) base.push(op.stroke);
      else if (op.op === "erase" && op.slideId === slideId) {
        const at = base.findIndex((one) => one.id === op.strokeId);
        if (at >= 0) base.splice(at, 1);
      } else if ((op.op === "clear-slide" && op.slideId === slideId) || op.op === "clear-all") base.length = 0;
    }
    return base;
  }

  canUndo(slideId: string): boolean {
    return (this.snapshotValue?.slideId === slideId && this.snapshotValue.canUndo) || this.pending.some((one) => one.op.op === "add" && one.op.stroke.slideId === slideId);
  }

  canRedo(slideId: string): boolean {
    return this.snapshotValue?.slideId === slideId && this.snapshotValue.canRedo;
  }
}

/** An id a stroke keeps across windows. Random, because two windows mint them independently. */
export function newInkId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `ink_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Add a point to a stroke being drawn, unless it is too close to the last to
 * matter. A pointer reports far more points than a line needs, and the cap is
 * on what crosses the channel.
 */
export function addPoint(points: InkPoint[], next: InkPoint, minDistance = 0.002): InkPoint[] {
  const point: InkPoint = [clamp01(next[0]), clamp01(next[1])];
  const last = points[points.length - 1];
  if (last && Math.hypot(last[0] - point[0], last[1] - point[1]) < minDistance) return points;
  if (points.length >= MAX_POINTS) return points;
  return [...points, point];
}

/** A pointer position as 0–1 of an element's box, which is the slide's box: the letterbox is outside it. */
export function toSlidePoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): InkPoint | null {
  if (box.width <= 0 || box.height <= 0) return null;
  return [(clientX - box.left) / box.width, (clientY - box.top) / box.height];
}

/**
 * The strokes an eraser at (x, y) touches. Distances are measured in slide
 * pixels rather than 0–1, because a 0–1 unit is longer across than down on a
 * wide slide and a circle there would be an ellipse.
 */
export function strokesAt(
  strokes: InkStroke[],
  point: InkPoint,
  viewport: { width: number; height: number },
  radius = 18,
): string[] {
  const px = point[0] * viewport.width;
  const py = point[1] * viewport.height;
  const hits: string[] = [];
  for (const stroke of strokes) {
    const reach = radius + stroke.width / 2;
    const points = stroke.points.map(([x, y]) => [x * viewport.width, y * viewport.height] as const);
    let hit = false;
    for (let i = 0; i < points.length && !hit; i += 1) {
      const a = points[i]!;
      const b = points[i + 1] ?? a;
      hit = distanceToSegment(px, py, a[0], a[1], b[0], b[1]) <= reach;
    }
    if (hit) hits.push(stroke.id);
  }
  return hits;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** An SVG path through a stroke's points, in slide pixels. A single point is a dot. */
export function strokePath(stroke: InkStroke, viewport: { width: number; height: number }): string {
  const scaled = stroke.points.map(([x, y]) => `${round(x * viewport.width)} ${round(y * viewport.height)}`);
  if (scaled.length === 1) return `M${scaled[0]} L${scaled[0]}`;
  return `M${scaled[0]} L${scaled.slice(1).join(" L")}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The highlighter's ink is see-through, so what it marks can still be read. */
export const HIGHLIGHTER_OPACITY = 0.35;
