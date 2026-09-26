/**
 * Deleting and reordering slides without leaving the deck broken.
 *
 * `removeSlide` on its own is correct about the slide and wrong about the deck:
 * the next slide's morph pairs, a link on another slide, an animation elsewhere
 * can all point into it. Each is a validation error, so these tests assert the
 * whole document validates after a deletion — not just that the slide is gone.
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
  deleteSlideOperations,
  misplacedMorphPairs,
  moveSlide,
  removeSlide,
  setSlideProperty,
  validateReferences,
} from "../src/index";

function apply(document: PresentationDocument, operations: PatchOperation[]) {
  return applyPatch(document, operations);
}

const errors = (document: PresentationDocument) =>
  validateReferences(document).filter((problem) => problem.severity === "error");

/** The animation fixture ends on a morph: its last slide pairs with the one before. */
const animated = loadFixture("animation");
const morphIndex = animated.slides.findIndex((slide) => (slide.transition?.sharedElements?.length ?? 0) > 0);

describe("deleteSlideOperations", () => {
  it("has a fixture with a morph to test against", () => {
    expect(morphIndex).toBeGreaterThan(0);
  });

  it("drops the morph pairs that named the deleted slide, where removeSlide alone leaves E104", () => {
    const source = animated.slides[morphIndex - 1]!;

    // The failure being fixed, shown first: this is what the old delete did.
    const naive = apply(animated, removeSlide(animated, source.id)).document;
    expect(errors(naive).map((problem) => problem.code)).toContain("E104");

    const after = apply(animated, deleteSlideOperations(animated, source.id)).document;
    expect(after.slides.some((slide) => slide.id === source.id)).toBe(false);
    expect(errors(after)).toEqual([]);
    expect(validateDocument(after).valid).toBe(true);
  });

  it("removes links on other slides that jumped to the deleted slide", () => {
    const [first, second] = animated.slides;
    const withLink = apply(
      animated,
      setSlideProperty(animated, first!.id, "interactions", [
        {
          id: "int_01JZZZZZZZZZZZZZZZZZZZZZZZ",
          trigger: { type: "key", key: "g" },
          action: { type: "goToSlide", slideId: second!.id },
        },
      ]),
    ).document;

    const naive = apply(withLink, removeSlide(withLink, second!.id)).document;
    expect(errors(naive).map((problem) => problem.code)).toContain("E105");

    const after = apply(withLink, deleteSlideOperations(withLink, second!.id)).document;
    expect(errors(after)).toEqual([]);
    expect(after.slides[0]!.interactions ?? []).toEqual([]);
  });

  it("is one patch that undoes to the exact original bytes", () => {
    const source = animated.slides[morphIndex - 1]!;
    const { document: after, inverse } = apply(animated, deleteSlideOperations(animated, source.id));
    const restored = apply(after, inverse).document;
    expect(serializeDocument(restored)).toBe(serializeDocument(animated));
  });

  it("does not separately remove the deleted slide's own animations", () => {
    const own = `/slides/id:${animated.slides[0]!.id}/`;
    const operations = deleteSlideOperations(animated, animated.slides[0]!.id);
    expect(operations.filter((operation) => operation.path.startsWith(own))).toEqual([]);
    expect(operations.at(-1)).toEqual({ op: "remove", path: `/slides/id:${animated.slides[0]!.id}` });
  });

  it("refuses a slide that is not in the document", () => {
    expect(() => deleteSlideOperations(animated, "sld_missing")).toThrow(/No slide/);
  });
});

describe("misplacedMorphPairs", () => {
  it("finds nothing in a deck whose morphs sit where they were authored", () => {
    expect(misplacedMorphPairs(animated)).toEqual([]);
  });

  it("names the pairs a reorder separated, though every reference still resolves", () => {
    const morph = animated.slides[morphIndex]!;
    const moved = apply(animated, moveSlide(animated, morph.id, 0)).document;

    // No reference broke — both elements still exist — which is why nothing
    // refuses the move and why this check has to exist.
    expect(errors(moved)).toEqual([]);
    const misplaced = misplacedMorphPairs(moved);
    expect(misplaced.length).toBe(morph.transition!.sharedElements!.length);
    expect(misplaced.every((pair) => pair.slideId === morph.id)).toBe(true);
  });
});
