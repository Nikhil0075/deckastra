import type { PatchOperation, PresentationDocument, Rect } from "@deckastra/presentation-schema";
import { resolveElementById, setProperty } from "@deckastra/presentation-core";

/**
 * Align and distribute (manual-authoring review MA-16).
 *
 * Worked in **world space** and written back in each element's own parent
 * space, the same split the canvas keeps: two objects in different groups can
 * be aligned with each other, because what lines up is what the audience sees.
 * An element moves by the difference between where its visible box is and where
 * it should be, so a rotated object aligns by its visible edge rather than by
 * its unrotated corner.
 *
 * The rules, stated once so the buttons can say them:
 *
 * - **Relative to the selection** when two or more objects are selected: the
 *   selection's own edges (or centre) are the target. With one object selected
 *   there is nothing else to align to, so it aligns to the **slide**.
 * - **Locked objects do not move.** They still count toward the selection's
 *   edges, so a locked logo can be what everything else lines up against —
 *   which is the usual reason for locking it. They are reported, never silently
 *   skipped.
 * - **Distribute** needs three or more objects and makes the gaps between
 *   neighbours equal, keeping the two outermost where they are.
 */

export type AlignEdge = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

export interface Boxed {
  id: string;
  /** Visible, world-space, axis-aligned bounds. */
  bounds: Rect;
}

export interface ArrangeResult {
  operations: PatchOperation[];
  /** Selected but locked, and therefore left where they are. */
  locked: string[];
  relativeTo: "selection" | "slide";
}

export function alignOperations(
  document: PresentationDocument,
  selected: readonly Boxed[],
  edge: AlignEdge,
  slide: { width: number; height: number },
): ArrangeResult {
  const relativeTo = selected.length >= 2 ? "selection" : "slide";
  const frame: Rect = relativeTo === "slide" ? { x: 0, y: 0, width: slide.width, height: slide.height } : union(selected.map((s) => s.bounds));
  const operations: PatchOperation[] = [];
  const locked: string[] = [];

  for (const item of selected) {
    const b = item.bounds;
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left": dx = frame.x - b.x; break;
      case "centerX": dx = frame.x + frame.width / 2 - (b.x + b.width / 2); break;
      case "right": dx = frame.x + frame.width - (b.x + b.width); break;
      case "top": dy = frame.y - b.y; break;
      case "centerY": dy = frame.y + frame.height / 2 - (b.y + b.height / 2); break;
      case "bottom": dy = frame.y + frame.height - (b.y + b.height); break;
    }
    const moved = shift(document, item.id, dx, dy);
    if (moved === "locked") locked.push(item.id);
    else operations.push(...moved);
  }
  return { operations, locked, relativeTo };
}

export function distributeOperations(
  document: PresentationDocument,
  selected: readonly Boxed[],
  axis: "x" | "y",
): ArrangeResult | { refusal: string } {
  if (selected.length < 3) return { refusal: "Select three or more objects to space them evenly." };
  const start = (b: Rect) => (axis === "x" ? b.x : b.y);
  const size = (b: Rect) => (axis === "x" ? b.width : b.height);
  // Document order breaks ties, so the same selection always spaces the same way.
  const ordered = [...selected].sort((a, b) => start(a.bounds) - start(b.bounds));
  const first = ordered[0]!.bounds;
  const last = ordered.at(-1)!.bounds;
  const span = start(last) + size(last) - start(first);
  const occupied = ordered.reduce((sum, item) => sum + size(item.bounds), 0);
  const gap = (span - occupied) / (ordered.length - 1);

  const operations: PatchOperation[] = [];
  const locked: string[] = [];
  let cursor = start(first);
  for (const item of ordered) {
    const delta = cursor - start(item.bounds);
    cursor += size(item.bounds) + gap;
    const moved = shift(document, item.id, axis === "x" ? delta : 0, axis === "y" ? delta : 0);
    if (moved === "locked") locked.push(item.id);
    else operations.push(...moved);
  }
  return { operations, locked, relativeTo: "selection" };
}

function shift(document: PresentationDocument, id: string, dx: number, dy: number): PatchOperation[] | "locked" {
  const found = resolveElementById(document, id);
  if (!found) return [];
  if (found.element.locked === true) return Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005 ? [] : "locked";
  if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return [];
  const t = found.element.transform;
  return setProperty(document, id, "transform", { ...t, x: round(t.x + dx), y: round(t.y + dy) });
}

function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
