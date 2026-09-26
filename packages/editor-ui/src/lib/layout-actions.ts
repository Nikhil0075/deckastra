import type { ContainerLayout, PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { isGroup } from "@deckastra/presentation-schema";
import { groupElements, resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";
import { duplicate } from "@deckastra/editor";
import { resolveContainer } from "@deckastra/layout-engine";
import { applyPatch } from "@deckastra/transactions";

/**
 * Stacks, grids and container controls (design review, 2026-09-27).
 *
 * Align and Distribute move boxes once; nothing keeps a row of cards a row when
 * one of them grows. The schema has had container layouts all along
 * (`GroupElement.containerLayout`, laid out by the scene build), with nothing
 * in the editor to make one. These make one, and every action is one patch:
 * group, set the layout and size the box to hold what is in it.
 *
 * Padding goes on the layout, never into the children's coordinates, because
 * the container ignores those while it lays out (CLAUDE.md, container layout).
 */

export type StackKind = "horizontal" | "vertical" | "grid";

export interface StackOptions {
  gap?: number;
  columns?: number;
  padding?: number;
}

/** How close two tops must be to count as one row when reading a grid's order. */
const ROW_TOLERANCE = 24;

/** Group the selection into a stack or grid, in the order it reads on the slide. */
export function stackOperations(
  document: PresentationDocument,
  elementIds: readonly string[],
  kind: StackKind,
  options: StackOptions = {},
): { operations: PatchOperation[]; groupId?: string } {
  const elements = elementIds.flatMap((id) => {
    const element = resolveElementById(document, id)?.element;
    return element && element.locked !== true ? [element] : [];
  });
  if (elements.length < 2) return { operations: [] };

  const ordered = [...elements].sort((a, b) => {
    if (kind === "horizontal") return a.transform.x - b.transform.x || a.transform.y - b.transform.y;
    if (kind === "vertical") return a.transform.y - b.transform.y || a.transform.x - b.transform.x;
    const sameRow = Math.abs(a.transform.y - b.transform.y) <= ROW_TOLERANCE;
    return sameRow ? a.transform.x - b.transform.x : a.transform.y - b.transform.y;
  });

  const grouped = groupElements(document, ordered.map((element) => element.id), { name: kind === "grid" ? "Grid" : "Stack" });
  let working = applyPatch(document, grouped.operations).document;
  const operations = [...grouped.operations];

  const pad = options.padding ?? 0;
  const layout: ContainerLayout = {
    type: kind,
    gap: options.gap ?? defaultGap(document),
    align: "start",
    ...(pad ? { padding: { top: pad, right: pad, bottom: pad, left: pad } } : {}),
    ...(kind === "grid" ? { columns: options.columns ?? Math.min(ordered.length, Math.ceil(Math.sqrt(ordered.length))) } : {}),
  };
  const withLayout = setPropertyDeep(working, grouped.groupId, "containerLayout", layout);
  working = applyPatch(working, withLayout).document;
  operations.push(...withLayout, ...fitOperations(working, grouped.groupId));
  return { operations, groupId: grouped.groupId };
}

/** Change a container's layout, and size its box to what it now needs. */
export function updateLayoutOperations(document: PresentationDocument, groupId: string, change: Partial<ContainerLayout>): PatchOperation[] {
  const group = resolveElementById(document, groupId)?.element;
  if (!group || !isGroup(group) || !group.containerLayout) return [];
  const next = { ...group.containerLayout, ...change } as ContainerLayout;
  for (const key of Object.keys(next) as (keyof ContainerLayout)[]) if (next[key] === undefined) delete next[key];
  const first = setPropertyDeep(document, groupId, "containerLayout", next);
  const working = applyPatch(document, first).document;
  return [...first, ...fitOperations(working, groupId)];
}

/**
 * Stop laying out: write each child where the container had put it, and remove
 * the layout. Nothing moves on screen, which is the point — "remove" must not
 * mean "jump back to where these were before someone made a stack of them".
 */
export function removeLayoutOperations(document: PresentationDocument, groupId: string): PatchOperation[] {
  const group = resolveElementById(document, groupId)?.element;
  if (!group || !isGroup(group) || !group.containerLayout) return [];
  const placed = place(document, group, group.transform.width, group.transform.height);
  let working = document;
  const operations: PatchOperation[] = [];
  for (const box of placed.children) {
    for (const [key, value] of [["x", box.x], ["y", box.y], ["width", box.width], ["height", box.height]] as const) {
      const child = resolveElementById(working, box.id)?.element;
      if (!child || round(child.transform[key]) === round(value)) continue;
      const next = setPropertyDeep(working, box.id, `transform.${key}`, round(value));
      working = applyPatch(working, next).document;
      operations.push(...next);
    }
  }
  operations.push(...setPropertyDeep(working, groupId, "containerLayout", undefined));
  return operations;
}

/**
 * Size a group to what it holds. A container takes the size its layout needs;
 * a plain group shrinks or grows to the union of its children, with the
 * children re-expressed so nothing moves on the slide.
 */
export function fitOperations(document: PresentationDocument, groupId: string): PatchOperation[] {
  const group = resolveElementById(document, groupId)?.element;
  if (!group || !isGroup(group) || group.children.length === 0) return [];
  const layout = group.containerLayout;
  if (layout && layout.type !== "free") {
    // A grid divides its own width into equal columns, so its width has to be
    // decided first: enough for the widest child in every column.
    let width = group.transform.width;
    if (layout.type === "grid") {
      const columns = Math.max(1, layout.columns ?? Math.ceil(Math.sqrt(group.children.length)));
      const gap = layout.columnGap ?? layout.gap ?? (document.theme.spacing as { base?: number } | undefined)?.base ?? 8;
      const pad = (layout.padding?.left ?? 0) + (layout.padding?.right ?? 0);
      width = pad + columns * Math.max(...group.children.map((child) => child.transform.width)) + gap * (columns - 1);
    }
    const placed = place(document, group, width, group.transform.height);
    return sizeOperations(document, groupId, layout.type === "grid" ? width : placed.contentWidth, placed.contentHeight);
  }
  const boxes = group.children.map((child) => child.transform);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - minX;
  const height = Math.max(...boxes.map((b) => b.y + b.height)) - minY;
  let working = document;
  const operations: PatchOperation[] = [];
  const write = (id: string, property: string, value: number) => {
    const next = setPropertyDeep(working, id, property, round(value));
    working = applyPatch(working, next).document;
    operations.push(...next);
  };
  if (minX !== 0 || minY !== 0) {
    for (const child of group.children) {
      if (minX !== 0) write(child.id, "transform.x", child.transform.x - minX);
      if (minY !== 0) write(child.id, "transform.y", child.transform.y - minY);
    }
    if (minX !== 0) write(groupId, "transform.x", group.transform.x + minX);
    if (minY !== 0) write(groupId, "transform.y", group.transform.y + minY);
  }
  operations.push(...sizeOperations(working, groupId, width, height));
  return operations;
}

/** One object, repeated into a grid of columns × rows inside a grid container. */
export function repeatAsGridOperations(
  document: PresentationDocument,
  elementId: string,
  columns: number,
  rows: number,
  gap?: number,
): { operations: PatchOperation[]; groupId?: string } {
  const count = Math.max(1, Math.floor(columns)) * Math.max(1, Math.floor(rows));
  if (count < 2 || !resolveElementById(document, elementId)) return { operations: [] };
  let working = document;
  const operations: PatchOperation[] = [];
  const ids = [elementId];
  for (let index = 1; index < count; index += 1) {
    const copy = duplicate(working, [elementId]);
    if (!copy.operations.length) break;
    working = applyPatch(working, copy.operations).document;
    operations.push(...copy.operations);
    ids.push(...copy.elementIds);
  }
  // Grid order is document order: the original first, then the copies.
  const grouped = groupElements(working, ids, { name: "Grid" });
  working = applyPatch(working, grouped.operations).document;
  operations.push(...grouped.operations);
  const layout: ContainerLayout = { type: "grid", columns: Math.max(1, Math.floor(columns)), gap: gap ?? defaultGap(document), align: "start" };
  const withLayout = setPropertyDeep(working, grouped.groupId, "containerLayout", layout);
  working = applyPatch(working, withLayout).document;
  operations.push(...withLayout, ...fitOperations(working, grouped.groupId));
  return { operations, groupId: grouped.groupId };
}

/**
 * Space objects so the gaps between them are exactly `gap`, along an axis, in
 * the order they sit. The first stays put.
 */
export function distributeWithGapOperations(document: PresentationDocument, elementIds: readonly string[], axis: "x" | "y", gap: number): PatchOperation[] {
  const size = axis === "x" ? "width" : "height";
  const elements = elementIds
    .flatMap((id) => {
      const element = resolveElementById(document, id)?.element;
      return element && element.locked !== true ? [element] : [];
    })
    .sort((a, b) => a.transform[axis] - b.transform[axis]);
  if (elements.length < 2) return [];
  let working = document;
  const operations: PatchOperation[] = [];
  let cursor = elements[0]!.transform[axis] + elements[0]!.transform[size] + gap;
  for (const element of elements.slice(1)) {
    if (round(element.transform[axis]) !== round(cursor)) {
      const next = setPropertyDeep(working, element.id, `transform.${axis}`, round(cursor));
      working = applyPatch(working, next).document;
      operations.push(...next);
    }
    cursor += element.transform[size] + gap;
  }
  return operations;
}

// ------------------------------------------------------------------ helpers

function place(document: PresentationDocument, group: PresentationElement & { children: PresentationElement[]; containerLayout?: ContainerLayout }, width: number, height: number) {
  return resolveContainer({
    layout: group.containerLayout!,
    box: { width, height },
    children: group.children.map((child) => ({ id: child.id, width: child.transform.width, height: child.transform.height })),
    // The scene build's own default, so a layout with no gap is placed here
    // exactly where the canvas draws it.
    baseGap: (document.theme.spacing as { base?: number } | undefined)?.base,
  });
}

function sizeOperations(document: PresentationDocument, groupId: string, width: number, height: number): PatchOperation[] {
  const group = resolveElementById(document, groupId)?.element;
  if (!group) return [];
  let working = document;
  const operations: PatchOperation[] = [];
  for (const [key, value] of [["width", width], ["height", height]] as const) {
    if (round(group.transform[key]) === round(value) || value <= 0) continue;
    const next = setPropertyDeep(working, groupId, `transform.${key}`, round(value));
    working = applyPatch(working, next).document;
    operations.push(...next);
  }
  return operations;
}

function defaultGap(document: PresentationDocument): number {
  const base = (document.theme.spacing as { base?: number } | undefined)?.base;
  return typeof base === "number" && base > 0 ? base * 3 : 24;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
