import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { moveElement, resolveElementById } from "@deckastra/presentation-core";

/**
 * Stacking order (doc 02 §8.4): array position is the authority, so bringing
 * something forward is a move within its own parent. `zIndex` pins and is not
 * touched here.
 *
 * The parent is named on the move. `moveElement` without a group moves to slide
 * level, so reordering an object inside a group used to lift it out of the
 * group (2026-10-13).
 */
export type ReorderDirection = "forward" | "backward" | "front" | "back";

export function reorderOperations(document: PresentationDocument, elementId: string, direction: ReorderDirection): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found) return [];
  const parent = found.ancestors[found.ancestors.length - 1] as { id: string; children?: unknown[] } | undefined;
  const count = parent ? (parent.children?.length ?? 0) : found.slide.elements.length;
  const last = count - 1;
  const target =
    direction === "forward"
      ? Math.min(found.index + 1, last)
      : direction === "backward"
        ? Math.max(found.index - 1, 0)
        : direction === "front"
          ? last
          : 0;
  if (target === found.index) return [];
  return moveElement(document, {
    elementId,
    toSlideId: found.slide.id,
    ...(parent ? { toGroupId: parent.id } : {}),
    toIndex: target,
  });
}

/** Whether a move in `direction` would change anything, for disabling a button. */
export function canReorder(document: PresentationDocument, elementId: string, direction: ReorderDirection): boolean {
  return reorderOperations(document, elementId, direction).length > 0;
}
