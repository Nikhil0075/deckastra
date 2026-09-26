import {
  isGroup,
  newId,
  type PatchOperation,
  type PresentationDocument,
  type PresentationElement,
  type Transform,
} from "@deckastra/presentation-schema";

import { containerPath, resolveElementById } from "./find";
import { OperationError } from "./operations";

/**
 * Ungroup (manual-authoring review MA-06).
 *
 * The inverse of `groupElements`, and the one a generated deck needs most: an
 * agent emits cards as groups, and a person who wants to move one word out of a
 * card should not need JSON to do it.
 *
 * Three properties, each one a way this goes wrong quietly:
 *
 * - **Nothing moves on screen.** A child's transform is local to its group
 *   (doc 02 §10.3), so each child is re-expressed in the group's parent space by
 *   composing the group's matrix — rotation and uniform scale included — the
 *   same composition the renderer performs. Inside a container layout the
 *   child's own `x`/`y` are advisory (doc 02 §16.2), so the caller passes the
 *   laid-out boxes and those are what the child keeps.
 * - **A card keeps its card.** A group paints its own fill, stroke and radius
 *   (the renderer's `positionStyle`); dissolving it would delete the background
 *   a styled card is made of. That paint becomes a rectangle behind the
 *   children, so the slide looks the same after as before.
 * - **One patch, so one Undo regroups exactly.** The group's removal, its
 *   children's insertion and the removal of anything that pointed at the group
 *   itself — an animation, an interaction, a morph pairing — go together. The
 *   children keep their ids, so their own animations and pairings still resolve.
 */

export interface UngroupOptions {
  /**
   * Where a container layout actually put each child, in the group's local
   * space. Omitted for a free group, whose children's own coordinates are
   * authoritative.
   */
  placements?: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>;
}

export interface UngroupResult {
  operations: PatchOperation[];
  /** The children, now siblings of where the group was, in their old order. */
  elementIds: string[];
  /**
   * A group scaled non-uniformly while a child is rotated cannot be expressed
   * as a child transform (a rotated box stretched along another axis is a
   * shear). The child then keeps its position and rotation with the scale
   * applied per axis, and this names it, so the caller can say so.
   */
  approximated: string[];
}

export function ungroupElements(
  document: PresentationDocument,
  groupId: string,
  options: UngroupOptions = {},
): UngroupResult {
  const found = resolveElementById(document, groupId);
  if (!found) throw new OperationError(`No element with id "${groupId}".`);
  const group = found.element;
  if (!isGroup(group)) {
    throw new OperationError(`Element "${groupId}" is a ${group.type}, not a group.`, "E303");
  }
  if (group.locked === true) {
    throw new OperationError("This group is locked. Unlock it before ungrouping.", "E303");
  }

  const groupMatrix = matrixOf(group.transform);
  const groupScale = uniformScale(group.transform);
  const approximated: string[] = [];

  const children = group.children.map((child) => {
    const placed = options.placements?.get(child.id);
    const own: Transform = placed ? { ...child.transform, ...placed } : child.transform;
    const next = structuredClone(child) as PresentationElement;
    next.transform = compose(group.transform, groupMatrix, groupScale, own);
    if (groupScale === undefined && (own.rotation ?? 0) % 360 !== 0) approximated.push(child.id);
    // A hidden group hid its children; they stay hidden rather than appearing.
    if (group.visible === false) next.visible = false;
    return next;
  });

  const background = backgroundFor(group);
  const inserted = background ? [background, ...children] : children;

  const parentPath = containerPath(found.slide.id, found.ancestors);
  const operations: PatchOperation[] = [
    ...referenceCleanup(document, groupId),
    { op: "remove", path: found.path },
    // Inserted at the group's own index, in order, so z-order is unchanged:
    // the group's band becomes the children's band.
    ...inserted.map((element, offset) => ({
      op: "add" as const,
      path: `${parentPath}/${found.index + offset}`,
      value: element,
    })),
  ];

  return { operations, elementIds: children.map((child) => child.id), approximated };
}

// ------------------------------------------------------------------ geometry

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

/** The renderer's `localMatrix`, restated: presentation-core does not depend on the renderer. */
function matrixOf(transform: Transform): Matrix {
  const { x, y, width, height, rotation = 0, scaleX = 1, scaleY = 1, originX = 0.5, originY = 0.5 } = transform;
  const ox = width * originX;
  const oy = height * originY;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;
  return { a, b, c, d, e: x + ox - (a * ox + c * oy), f: y + oy - (b * ox + d * oy) };
}

function apply(m: Matrix, point: { x: number; y: number }): { x: number; y: number } {
  return { x: m.a * point.x + m.c * point.y + m.e, y: m.b * point.x + m.d * point.y + m.f };
}

/** The group's scale when it is the same on both axes, else undefined. */
function uniformScale(transform: Transform): number | undefined {
  const sx = transform.scaleX ?? 1;
  const sy = transform.scaleY ?? 1;
  return sx === sy ? sx : undefined;
}

/**
 * The child's transform in the group's parent space.
 *
 * For a group matrix G and a child pivoting about its origin point o, the
 * child's world matrix is T(G·(x + o)) · L_G · R_c · S_c · T(−o). When L_G is a
 * rotation times a uniform scale s, that is exactly a transform pivoting about
 * the same o, at G·(x + o) − o, rotated by both angles and scaled by s.
 */
function compose(groupTransform: Transform, groupMatrix: Matrix, scale: number | undefined, child: Transform): Transform {
  const ox = child.width * (child.originX ?? 0.5);
  const oy = child.height * (child.originY ?? 0.5);
  const pivot = apply(groupMatrix, { x: child.x + ox, y: child.y + oy });
  const rotation = normaliseDegrees((child.rotation ?? 0) + (groupTransform.rotation ?? 0));
  const sx = (child.scaleX ?? 1) * (scale ?? groupTransform.scaleX ?? 1);
  const sy = (child.scaleY ?? 1) * (scale ?? groupTransform.scaleY ?? 1);

  const next: Transform = { ...child, x: round(pivot.x - ox), y: round(pivot.y - oy) };
  if (rotation === 0) delete next.rotation;
  else next.rotation = rotation;
  if (sx === 1) delete next.scaleX;
  else next.scaleX = round(sx);
  if (sy === 1) delete next.scaleY;
  else next.scaleY = round(sy);
  return next;
}

function normaliseDegrees(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return round(wrapped);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ----------------------------------------------------------------- the card

function backgroundFor(group: PresentationElement): PresentationElement | undefined {
  const style = group.style;
  const paints = style?.fill && style.fill.type !== "none";
  const strokes = style?.stroke && style.stroke.paint.type !== "none" && (style.stroke.width ?? 1) > 0;
  if (!paints && !strokes && !(style?.shadow && style.shadow.length > 0)) return undefined;

  return {
    id: newId("el"),
    type: "shape",
    shape: "rectangle",
    name: group.name ? `${group.name} background` : "Group background",
    transform: { ...group.transform },
    style: structuredClone(style),
    ...(group.opacity !== undefined ? { opacity: group.opacity } : {}),
    ...(group.visible === false ? { visible: false } : {}),
    ...(group.semanticRole ? { semanticRole: "decoration" } : {}),
  } as unknown as PresentationElement;
}

// ---------------------------------------------------------------- references

/**
 * Remove whatever pointed at the group itself. Unlike deleting it, its
 * children survive, so nothing that names *them* is touched.
 */
function referenceCleanup(document: PresentationDocument, groupId: string): PatchOperation[] {
  const operations: PatchOperation[] = [];
  for (const slide of document.slides) {
    const base = `/slides/id:${slide.id}`;
    for (const track of slide.animations ?? []) {
      if (track.targetId === groupId) operations.push({ op: "remove", path: `${base}/animations/id:${track.id}` });
    }
    for (const interaction of slide.interactions ?? []) {
      const trigger = interaction.trigger as { targetId?: string };
      const action = interaction.action as { targetId?: string };
      if (trigger.targetId === groupId || action.targetId === groupId) {
        operations.push({ op: "remove", path: `${base}/interactions/id:${interaction.id}` });
      }
    }
    const mappings = slide.transition?.sharedElements;
    if (mappings?.some((m) => m.sourceElementId === groupId || m.destinationElementId === groupId)) {
      operations.push({
        op: "replace",
        path: `${base}/transition/sharedElements`,
        value: mappings.filter((m) => m.sourceElementId !== groupId && m.destinationElementId !== groupId),
      });
    }
  }
  return operations;
}
