/**
 * Slide management and speaker notes (Phase 2). Every action is a patch through
 * the one mutation path, so each test applies it with the real applier and
 * checks the document — and that the patch undoes to the original bytes.
 */

import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  serializeDocument,
  validateDocument,
  type PatchOperation,
  type PresentationDocument,
} from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import {
  deleteSlideAction,
  duplicateSlideAction,
  duplicateSlideWithMagicMoveAction,
  moveSlideAction,
  slotForPointer,
  speakingEstimate,
  targetIndexForSlot,
} from "../src/lib/slide-actions";

const deck = loadFixture("animation");
const ids = (document: PresentationDocument) => document.slides.map((slide) => slide.id);

function roundTrips(document: PresentationDocument, operations: PatchOperation[]) {
  const { document: after, inverse } = applyPatch(document, operations);
  expect(serializeDocument(applyPatch(after, inverse).document)).toBe(serializeDocument(document));
  return after;
}

describe("drop position", () => {
  it("maps a gap to the index the slide lands at", () => {
    // Four slides; dragging slide 1.
    expect(targetIndexForSlot(1, 0)).toBe(0); // before the first
    expect(targetIndexForSlot(1, 1)).toBe(1); // the gap above itself: no move
    expect(targetIndexForSlot(1, 2)).toBe(1); // the gap below itself: no move
    expect(targetIndexForSlot(1, 3)).toBe(2);
    expect(targetIndexForSlot(1, 4)).toBe(3); // after the last
  });

  it("chooses the gap above in a thumbnail's top half and below in its bottom half", () => {
    expect(slotForPointer(2, 10, 80)).toBe(2);
    expect(slotForPointer(2, 70, 80)).toBe(3);
  });
});

describe("moveSlideAction", () => {
  it("is one undoable move, and the current slide follows the moved one", () => {
    const action = moveSlideAction(deck, 0, 2)!;
    expect(action.operations).toHaveLength(1);
    const after = roundTrips(deck, action.operations);
    expect(ids(after)[2]).toBe(deck.slides[0]!.id);
    expect(action.index).toBe(2);
  });

  it("does nothing when the slide would land where it is", () => {
    expect(moveSlideAction(deck, 1, 1)).toBeNull();
  });

  it("says so when a move separates a morph's two halves", () => {
    const morph = deck.slides.findIndex((slide) => (slide.transition?.sharedElements?.length ?? 0) > 0);
    const action = moveSlideAction(deck, morph, 0)!;
    expect(action.notice).toMatch(/morph pair/);
  });

  it("says nothing extra for an ordinary move", () => {
    expect(moveSlideAction(deck, 0, 1)!.notice).toBeUndefined();
  });
});

describe("duplicateSlideAction", () => {
  it("puts a fresh-id copy directly after the slide and shows it", () => {
    const action = duplicateSlideAction(deck, 1)!;
    const after = roundTrips(deck, action.operations);
    expect(after.slides).toHaveLength(deck.slides.length + 1);
    expect(action.index).toBe(2);
    expect(after.slides[2]!.id).not.toBe(deck.slides[1]!.id);
    expect(validateDocument(after).valid).toBe(true);
  });
});

describe("duplicateSlideWithMagicMoveAction", () => {
  it("adds one fresh-id slide with explicit leaf pairs and one undoable operation", () => {
    const action = duplicateSlideWithMagicMoveAction(deck, 0)!;
    expect(action.operations).toHaveLength(1);
    const after = roundTrips(deck, action.operations);
    const source = deck.slides[0]!;
    const copy = after.slides[1]!;
    expect(copy.id).not.toBe(source.id);
    expect(copy.transition?.type).toBe("morph");
    expect(copy.transition?.durationMs).toBe(600);
    expect(copy.transition?.sharedElements?.length).toBeGreaterThan(0);
    expect(new Set(copy.transition?.sharedElements?.map((pair) => pair.sourceElementId)).size).toBe(copy.transition?.sharedElements?.length);
    expect(validateDocument(after).valid).toBe(true);
  });
});

describe("deleteSlideAction", () => {
  it("refuses to delete the only slide", () => {
    const single = { ...deck, slides: [deck.slides[0]!] };
    expect(deleteSlideAction(single, 0)).toBeNull();
  });

  it("deletes in one patch, keeps position, and stays valid", () => {
    const action = deleteSlideAction(deck, 1)!;
    const after = roundTrips(deck, action.operations);
    expect(ids(after)).toEqual(ids(deck).filter((_, i) => i !== 1));
    expect(action.index).toBe(1);
    expect(validateDocument(after).valid).toBe(true);
  });

  it("keeps the slide on screen when a different one is deleted", () => {
    // On slide 2, delete slide 0: slide 2 is now at index 1.
    expect(deleteSlideAction(deck, 0, 2)!.index).toBe(1);
    // On slide 0, delete slide 2: still slide 0.
    expect(deleteSlideAction(deck, 2, 0)!.index).toBe(0);
  });

  it("shows the new last slide when the last one goes", () => {
    expect(deleteSlideAction(deck, deck.slides.length - 1)!.index).toBe(deck.slides.length - 2);
  });

  it("tells the user when deleting also removed references into the slide", () => {
    const morph = deck.slides.findIndex((slide) => (slide.transition?.sharedElements?.length ?? 0) > 0);
    const action = deleteSlideAction(deck, morph - 1)!;
    expect(action.notice).toMatch(/reference/);
    expect(validateDocument(roundTrips(deck, action.operations)).valid).toBe(true);
  });
});

describe("speaker notes", () => {
  it("estimates speaking time at a steady pace", () => {
    expect(speakingEstimate("")).toBe("no notes yet");
    expect(speakingEstimate(Array(98).fill("word").join(" "))).toBe("about 45 seconds");
    expect(speakingEstimate(Array(260).fill("word").join(" "))).toBe("about 2 minutes");
  });
});
