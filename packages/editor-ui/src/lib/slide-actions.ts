/**
 * Slide management and speaker notes, as pure functions (Phase 2, Figma frame
 * "speaker notes editing").
 *
 * Each action returns operations for `editor.apply` — the one mutation path —
 * plus the slide index the editor should show afterwards, so the component that
 * calls it only gestures. Pure, so it is tested directly: nothing renders the
 * shell in jsdom.
 */

import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { cloneSlide, deleteSlideOperations, misplacedMorphPairs, moveSlide } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

export interface SlideAction {
  operations: PatchOperation[];
  label: string;
  /** The slide to show once applied. */
  index: number;
  /**
   * Something the user should be told, beyond the edit itself — said at the
   * moment of the change rather than discovered on a projector later.
   */
  notice?: string;
}

// ----------------------------------------------------------------- duplicate

/** Duplicate the slide at `index` directly after it, and show the copy. */
export function duplicateSlideAction(document: PresentationDocument, index: number): SlideAction | null {
  const slide = document.slides[index];
  if (!slide) return null;
  const { operations } = cloneSlide(document, slide.id, { atIndex: index + 1 });
  return { operations, label: "Duplicate slide", index: index + 1 };
}

/** Duplicate and create exact shared-element pairs without heuristic matching. */
export function duplicateSlideWithMagicMoveAction(document: PresentationDocument, index: number): SlideAction | null {
  const source = document.slides[index];
  if (!source) return null;
  const cloned = cloneSlide(document, source.id, { atIndex: index + 1 });
  const leaves = (elements: PresentationElement[]): PresentationElement[] =>
    elements.flatMap((element) => {
      const children = element.type === "group"
        ? (element as PresentationElement & { children?: PresentationElement[] }).children
        : undefined;
      return children?.length ? leaves(children) : [element];
    });
  const sharedElements = leaves(source.elements).flatMap((element) => {
    const destinationElementId = cloned.idMap.get(element.id);
    return destinationElementId ? [{ sourceElementId: element.id, destinationElementId }] : [];
  });
  cloned.slide.transition = {
    type: "morph",
    durationMs: 600,
    easing: "easeInOut",
    sharedElements,
  };
  return {
    operations: cloned.operations,
    label: "Duplicate and Magic Move",
    index: index + 1,
  };
}

// -------------------------------------------------------------------- delete

/**
 * Delete the slide at `index`, and everything elsewhere that pointed into it,
 * in one patch (`deleteSlideOperations`). The last slide cannot be deleted: a
 * deck with no slides is a state the editor can only apologise for, and one
 * undo away is not a good enough reason to allow it.
 */
export function deleteSlideAction(
  document: PresentationDocument,
  index: number,
  /** The slide on screen. Deleting a different one must not change what is shown. */
  current: number = index,
): SlideAction | null {
  const slide = document.slides[index];
  if (!slide || document.slides.length <= 1) return null;

  const operations = deleteSlideOperations(document, slide.id) as PatchOperation[];
  const cleaned = operations.length - 1;
  return {
    operations,
    label: "Delete slide",
    // Deleting the slide on screen shows the one that moved up into its place
    // (or the new last slide). Deleting another keeps the same slide on screen,
    // one position earlier if the deleted slide was above it.
    index:
      index === current
        ? Math.min(index, document.slides.length - 2)
        : current > index
          ? current - 1
          : current,
    ...(cleaned > 0
      ? {
          // "Reference", not "link": what goes may be a morph pair or an
          // animation as well as a jump-to-slide.
          notice: `Deleted slide ${index + 1}. ${cleaned} reference${cleaned === 1 ? "" : "s"} elsewhere in the deck pointed into it and ${cleaned === 1 ? "was" : "were"} removed with it — undo restores everything.`,
        }
      : {}),
  };
}

// ------------------------------------------------------------------- reorder

/**
 * Where a slide dragged from `from` lands when dropped in gap `slot`, where gap
 * `k` is the space *before* slide `k` and gap `n` is after the last. Dropping
 * into either gap beside the slide itself is no move at all.
 */
export function targetIndexForSlot(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/**
 * The gap a pointer at `offsetY` within a thumbnail of `height` px, at list
 * index `index`, is closest to: the gap above it in the top half, below it in
 * the bottom half.
 */
export function slotForPointer(index: number, offsetY: number, height: number): number {
  return offsetY < height / 2 ? index : index + 1;
}

/**
 * Move the slide at `from` to index `to` (a single `move` operation, so it
 * undoes as one step). The current slide follows the one that moved.
 *
 * A reorder can break a morph without breaking any reference: the pair's two
 * elements still exist, just no longer on adjacent slides. Nothing refuses
 * that, and the transition engine only drops the pair when the deck is played —
 * so the action compares `misplacedMorphPairs` before and after and says so now.
 */
export function moveSlideAction(document: PresentationDocument, from: number, to: number): SlideAction | null {
  const slide = document.slides[from];
  if (!slide) return null;
  const clamped = Math.max(0, Math.min(to, document.slides.length - 1));
  const operations = moveSlide(document, slide.id, clamped);
  if (operations.length === 0) return null;

  const before = misplacedMorphPairs(document).length;
  const after = misplacedMorphPairs(applyPatch(document, operations).document).length;
  const separated = after - before;

  return {
    operations,
    label: "Move slide",
    index: clamped,
    ...(separated > 0
      ? {
          notice: `Moved. ${separated} morph pair${separated === 1 ? " is" : "s are"} no longer on neighbouring slides, so ${separated === 1 ? "it" : "they"} will not morph — move it back or re-pair in Motion.`,
        }
      : {}),
  };
}

// --------------------------------------------------------------- speaker notes
// Editing notes is `notes-rich.ts`; the speaking estimate stays here.

/** Speaking pace used for the estimate, in words per minute. */
export const SPEAKING_WPM = 130;

/** "about 45 seconds" — rounded to 5 seconds under a minute, whole minutes after. */
export function speakingEstimate(text: string): string {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (words === 0) return "no notes yet";
  const seconds = (words / SPEAKING_WPM) * 60;
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
