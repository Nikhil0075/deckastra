import type { Point, Transform } from "@deckastra/presentation-schema";

/**
 * Transform manipulation (doc 04 §12, §13).
 *
 * The document stores logical properties — x, y, width, height, rotation, scale
 * (doc 02 §10). Everything here reads and writes those, never a composed matrix:
 * storing cascading transform strings as source data is what makes geometry
 * impossible to reason about six months later.
 */

export type HandleId =
  | "nw" | "n" | "ne"
  | "w"  |       "e"
  | "sw" | "s" | "se";

export const HANDLES: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Minimum sizes by element type (doc 04 §13.1). Below these a handle stops
 *  rather than inverting. */
export const MIN_SIZE: Record<string, number> = {
  default: 8,
  text: 24,
  chart: 120,
  diagram: 160,
  table: 120,
};

export function minSizeFor(type: string): number {
  return MIN_SIZE[type] ?? MIN_SIZE.default!;
}

/** Types where dragging past the opposite edge flips instead of stopping
 *  (doc 04 §13.1, §12.6). Text is excluded — mirrored glyphs are never wanted. */
const FLIPPABLE = new Set(["shape", "image"]);

export function canFlip(type: string): boolean {
  return FLIPPABLE.has(type);
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Rotate a vector by -angle: world delta into element space. */
function toLocal(delta: Point, rotation: number): Point {
  const r = radians(-rotation);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // Coerce a missing axis to 0. A single NaN here propagates into width, then
  // into the matrix, and blanks the element — far from where it started.
  const dx = delta.x || 0;
  const dy = delta.y || 0;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function toWorld(delta: Point, rotation: number): Point {
  const r = radians(rotation);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: delta.x * cos - delta.y * sin, y: delta.x * sin + delta.y * cos };
}

/** World position of a named corner or edge midpoint of a transform. */
export function anchorPoint(transform: Transform, handle: HandleId): Point {
  const { x, y, width, height, rotation = 0, originX = 0.5, originY = 0.5 } = transform;

  const local = handleOffset(handle, width, height);
  const ox = width * originX;
  const oy = height * originY;

  const rotated = toWorld({ x: local.x - ox, y: local.y - oy }, rotation);
  return { x: x + ox + rotated.x, y: y + oy + rotated.y };
}

function handleOffset(handle: HandleId, width: number, height: number): Point {
  const left = 0;
  const right = width;
  const top = 0;
  const bottom = height;
  const cx = width / 2;
  const cy = height / 2;

  switch (handle) {
    case "nw": return { x: left, y: top };
    case "n":  return { x: cx, y: top };
    case "ne": return { x: right, y: top };
    case "e":  return { x: right, y: cy };
    case "se": return { x: right, y: bottom };
    case "s":  return { x: cx, y: bottom };
    case "sw": return { x: left, y: bottom };
    case "w":  return { x: left, y: cy };
  }
}

export function oppositeHandle(handle: HandleId): HandleId {
  const map: Record<HandleId, HandleId> = {
    nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e",
  };
  return map[handle];
}

export interface ResizeOptions {
  /** Shift: keep the aspect ratio. */
  uniform?: boolean;
  /** Alt: resize about the centre instead of the opposite corner. */
  fromCenter?: boolean;
  elementType?: string;
  /** Side handles on a text box change width only; height follows from fit. */
  widthOnly?: boolean;
}

/**
 * Resize by dragging a handle.
 *
 * The whole difficulty is rotation. A naive `width += dx` moves the element as it
 * grows, because x/y describe the *unrotated* top-left and rotation happens about
 * the centre — so changing the size moves the centre, which moves everything.
 *
 * The fix (doc 04 §12.3): convert the drag into element space, do plain size
 * math, then translate so the opposite anchor lands back where it was in world
 * space.
 */
export function resize(
  transform: Transform,
  handle: HandleId,
  worldDelta: Point,
  options: ResizeOptions = {},
): Transform {
  const rotation = transform.rotation ?? 0;
  const local = toLocal(worldDelta, rotation);
  const minimum = minSizeFor(options.elementType ?? "default");

  let { width, height } = transform;
  let dx = 0;
  let dy = 0;

  const affectsLeft = handle === "nw" || handle === "w" || handle === "sw";
  const affectsRight = handle === "ne" || handle === "e" || handle === "se";
  const affectsTop = handle === "nw" || handle === "n" || handle === "ne";
  const affectsBottom = handle === "sw" || handle === "s" || handle === "se";

  if (affectsRight) width += local.x;
  if (affectsLeft) {
    width -= local.x;
    dx = local.x;
  }

  if (!options.widthOnly) {
    if (affectsBottom) height += local.y;
    if (affectsTop) {
      height -= local.y;
      dy = local.y;
    }
  }

  if (options.uniform && !options.widthOnly) {
    // Drive both axes from whichever moved more, so the ratio holds and the drag
    // still feels like it is following the cursor.
    const ratio = transform.width / transform.height;
    if (Math.abs(local.x) > Math.abs(local.y)) height = width / ratio;
    else width = height * ratio;
  }

  const flippable = canFlip(options.elementType ?? "");

  let scaleX = transform.scaleX ?? 1;
  let scaleY = transform.scaleY ?? 1;

  if (width < minimum) {
    if (flippable && width < 0) {
      // Dragging past the opposite edge is a flip, expressed as negative scale
      // (doc 04 §12.6) rather than a separate property.
      scaleX = -scaleX;
      width = Math.abs(width);
    } else {
      // Stop rather than invert: the handle refuses to go further.
      if (affectsLeft) dx -= minimum - width;
      width = minimum;
    }
  }

  if (height < minimum) {
    if (flippable && height < 0) {
      scaleY = -scaleY;
      height = Math.abs(height);
    } else {
      if (affectsTop) dy -= minimum - height;
      height = minimum;
    }
  }

  const next: Transform = { ...transform, width, height, scaleX, scaleY };

  if (options.fromCenter) {
    // Grow symmetrically about the centre: the centre stays put, so only the
    // origin offset changes.
    const centre = anchorPointFromSize(transform, "centre");
    const nextCentre = anchorPointFromSize(next, "centre");
    return {
      ...next,
      x: transform.x + (centre.x - nextCentre.x),
      y: transform.y + (centre.y - nextCentre.y),
    };
  }

  // Move the box by the local delta, then correct so the opposite anchor is
  // unmoved in world space. Without the correction a rotated element drifts.
  const shifted: Transform = {
    ...next,
    x: transform.x + dx,
    y: transform.y + dy,
  };

  const opposite = oppositeHandle(handle);
  const before = anchorPoint(transform, opposite);
  const after = anchorPoint(shifted, opposite);

  return {
    ...shifted,
    x: shifted.x + (before.x - after.x),
    y: shifted.y + (before.y - after.y),
  };
}

function anchorPointFromSize(transform: Transform, _which: "centre"): Point {
  const { x, y, width, height, originX = 0.5, originY = 0.5 } = transform;
  return { x: x + width * originX, y: y + height * originY };
}

export function move(transform: Transform, delta: Point): Transform {
  return { ...transform, x: transform.x + delta.x, y: transform.y + delta.y };
}

/** Rotation snaps to 15° while Shift is held (doc 04 §12.5). */
export const ROTATION_SNAP_DEGREES = 15;

export function rotate(
  transform: Transform,
  degrees: number,
  options: { snap?: boolean } = {},
): Transform {
  let next = (transform.rotation ?? 0) + degrees;
  if (options.snap) {
    next = Math.round(next / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES;
  }
  return { ...transform, rotation: normalizeAngle(next) };
}

/** Normalize to [0, 360) on commit (doc 02 §10.4). */
export function normalizeAngle(degrees: number): number {
  const wrapped = degrees % 360;
  return round(wrapped < 0 ? wrapped + 360 : wrapped);
}

/**
 * Rotate a multi-selection about the selection centre (doc 04 §12.5).
 *
 * Each element's own rotation *and* position change: rotating a set about a
 * shared point is not the same as rotating each element in place, and doing the
 * latter is what makes a group of objects appear to scatter.
 */
export function rotateAbout(
  transform: Transform,
  degrees: number,
  centre: Point,
): Transform {
  const { originX = 0.5, originY = 0.5 } = transform;
  const own = {
    x: transform.x + transform.width * originX,
    y: transform.y + transform.height * originY,
  };

  const moved = toWorld({ x: own.x - centre.x, y: own.y - centre.y }, degrees);

  return {
    ...transform,
    x: centre.x + moved.x - transform.width * originX,
    y: centre.y + moved.y - transform.height * originY,
    rotation: normalizeAngle((transform.rotation ?? 0) + degrees),
  };
}

export interface GroupResizeInput {
  group: Transform;
  next: { width: number; height: number };
  mode: "scaleChildren" | "resizeContainer";
  children: { id: string; transform: Transform; type: string; fontSize?: number }[];
}

export interface GroupResizeResult {
  group: Transform;
  children: { id: string; transform: Transform; fontSize?: number }[];
}

/**
 * Resize a group (doc 04 §12.4).
 *
 * `scaleChildren` multiplies child geometry and font sizes; `resizeContainer`
 * changes only the group box and lets the container re-lay out, so type sizes
 * hold.
 *
 * The non-uniform case is the subtle one: text scales by `min(sx, sy)` while its
 * box scales freely. Scaling text by both axes independently produces stretched
 * glyphs, which looks like a rendering bug rather than a resize.
 */
export function resizeGroup(input: GroupResizeInput): GroupResizeResult {
  const { group, next, mode, children } = input;

  const nextGroup: Transform = {
    ...group,
    width: round(Math.max(1, next.width)),
    height: round(Math.max(1, next.height)),
  };

  if (mode === "resizeContainer") {
    // The container re-runs its own layout; children are untouched here.
    return { group: nextGroup, children: children.map((c) => ({ id: c.id, transform: c.transform })) };
  }

  const sx = nextGroup.width / Math.max(group.width, 0.001);
  const sy = nextGroup.height / Math.max(group.height, 0.001);
  const typeScale = Math.min(Math.abs(sx), Math.abs(sy));

  return {
    group: nextGroup,
    children: children.map((child) => ({
      id: child.id,
      transform: {
        ...child.transform,
        x: round(child.transform.x * sx),
        y: round(child.transform.y * sy),
        width: round(Math.max(1, child.transform.width * sx)),
        height: round(Math.max(1, child.transform.height * sy)),
      },
      fontSize:
        child.fontSize !== undefined ? round(child.fontSize * typeScale) : undefined,
    })),
  };
}

/**
 * Round geometry for persistence (doc 04 §4.4).
 *
 * Called once, when a gesture commits — deliberately not inside `resize` or
 * `move`. Rounding every intermediate step of a drag accumulates error: a rotated
 * element resized across a hundred pointer events drifts visibly from the anchor
 * that was supposed to stay fixed. Full precision during the gesture, two
 * decimals in the document.
 */
export function commitTransform(transform: Transform): Transform {
  return {
    ...transform,
    x: round(transform.x),
    y: round(transform.y),
    width: round(transform.width),
    height: round(transform.height),
    ...(transform.rotation !== undefined ? { rotation: round(transform.rotation) } : {}),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Axis-aligned world bounds of a transform, accounting for rotation. */
export function worldBounds(transform: Transform): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const corners: HandleId[] = ["nw", "ne", "se", "sw"];
  const points = corners.map((handle) => anchorPoint(transform, handle));

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}
