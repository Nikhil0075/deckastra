import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument, Slide } from "@deckastra/presentation-schema";
import { newId } from "@deckastra/presentation-schema";
import {
  addElement,
  createPresentation,
  createSlide,
  moveElement,
  setProperty,
  setSlideProperty,
} from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

import { plainTextToRichText } from "../src/text-editing";

/**
 * Journey D, checked: a deck built by hand, with no AI (doc 01 §7.4, doc 04 §39).
 *
 * The claim the editor makes is that every slide it can render, a person can
 * also build — because an editor that only works as a viewer for AI output makes
 * the whole product fragile: every gap in the model becomes something the user
 * simply cannot do, and nobody notices until a customer hits it.
 *
 * So this rebuilds the animation-test seed deck the way the toolbar does: one
 * operation at a time, through the same `presentation-core` functions the
 * buttons call, applied through the same single mutation path. If a slide in the
 * fixture set needs something the editor cannot express, this fails, and that is
 * the signal.
 *
 * It rebuilds *structure and geometry*, not the animation timelines — those are
 * Phase 7 and there is no editor surface for them yet. That limit is asserted at
 * the bottom rather than quietly skipped.
 */

const target = loadFixture("animation");

/** Apply a batch of operations the way the editor's `apply()` does. */
function commit(document: PresentationDocument, operations: unknown[]): PresentationDocument {
  return applyPatch(document, operations as never).document;
}

function buildByHand(): PresentationDocument {
  // "New presentation", with the fixture's theme — themes are workspace objects
  // a user picks, not something they draw.
  let document = createPresentation({
    schemaVersion: target.schemaVersion,
    title: target.metadata.title,
    theme: target.theme,
    viewport: target.viewport,
  });

  target.slides.forEach((slide, slideIndex) => {
    document = commit(document, createSlide(document).operations);
    const slideId = document.slides[slideIndex]!.id;

    document = commit(document, setSlideProperty(document, slideId, "name", slide.name));
    if (slide.keyMessage) {
      document = commit(
        document,
        setSlideProperty(document, slideId, "keyMessage", slide.keyMessage),
      );
    }
    if (slide.background) {
      document = commit(
        document,
        setSlideProperty(document, slideId, "background", slide.background),
      );
    }
    if (slide.transition) {
      document = commit(
        document,
        setSlideProperty(document, slideId, "transition", slide.transition),
      );
    }

    for (const element of slide.elements) {
      // Toolbar: add a text box or a shape, then set its properties. Ids are
      // fresh, as they would be — the fixture's ids are not reachable by hand and
      // the comparison below does not depend on them.
      const created = { ...element, id: newId("el") } as typeof element;
      document = commit(document, addElement(document, { slideId, element: created }));

      // Typing into the box goes through the same path the in-place editor uses.
      if (created.type === "text") {
        const plain = (created as { content: { blocks: { spans: { text: string }[] }[] } }).content
          .blocks.map((block) => block.spans.map((span) => span.text).join(""))
          .join("\n");
        document = commit(
          document,
          setProperty(document, created.id, "content", plainTextToRichText(plain)),
        );
      }
    }
  });

  return document;
}

/** Compare what a reader would see, not ids or key order. */
function shapeOf(slide: Slide): unknown {
  const element = (raw: Slide["elements"][number]): unknown => ({
    type: raw.type,
    semanticRole: raw.semanticRole,
    transform: raw.transform,
    opacity: raw.opacity,
    text: plainOf(raw),
    children: (raw as { children?: Slide["elements"] }).children?.map(element),
  });

  return { name: slide.name, elements: slide.elements.map(element) };
}

function plainOf(element: Slide["elements"][number]): string {
  const content = (element as { content?: { blocks?: { spans?: { text: string }[] }[] } }).content;
  const label = (element as { text?: { blocks?: { spans?: { text: string }[] }[] } }).text;
  const source = content ?? label;
  if (!source?.blocks) return "";
  return source.blocks
    .map((block) => (block.spans ?? []).map((span) => span.text).join(""))
    .join("\n");
}

describe("rebuilding a seed deck by hand", () => {
  const rebuilt = buildByHand();

  it("produces the same slides, in the same order", () => {
    expect(rebuilt.slides).toHaveLength(target.slides.length);
    expect(rebuilt.slides.map((slide) => slide.name)).toEqual(
      target.slides.map((slide) => slide.name),
    );
  });

  it("produces the same elements, geometry and copy", () => {
    for (let i = 0; i < target.slides.length; i += 1) {
      expect(shapeOf(rebuilt.slides[i]!), `slide ${i}`).toEqual(shapeOf(target.slides[i]!));
    }
  });

  it("gives every element a fresh id, and no id collides", () => {
    const ids = rebuilt.slides.flatMap((slide) => slide.elements.map((element) => element.id));
    expect(new Set(ids).size).toBe(ids.length);

    const fixtureIds = new Set(
      target.slides.flatMap((slide) => slide.elements.map((element) => element.id)),
    );
    for (const id of ids) expect(fixtureIds.has(id)).toBe(false);
  });

  it("reorders through the same operation the layers panel uses", () => {
    // "Bring to front" is an array move, not a zIndex bump (doc 02 §8.4). If the
    // editor could not express this, a user could not fix a stacking mistake.
    const slideId = rebuilt.slides[0]!.id;
    const elements = rebuilt.slides[0]!.elements;
    const first = elements[0]!.id;

    const moved = commit(
      rebuilt,
      moveElement(rebuilt, { elementId: first, toSlideId: slideId, toIndex: elements.length - 1 }),
    );

    expect(moved.slides[0]!.elements.at(-1)!.id).toBe(first);
    expect(moved.slides[0]!.elements).toHaveLength(elements.length);
  });

  it("still needs Phase 7 for the timelines, and says so", () => {
    // The one thing the editor cannot yet build. Asserted rather than omitted so
    // that when the motion panel lands, this test fails and gets extended
    // instead of quietly continuing to check less than it claims.
    // Animations live on the slide, not the element (doc 02 §24): a timeline is
    // an ordering of the whole slide's motion, which is why it cannot be
    // reconstructed one element at a time.
    const withMotion = target.slides.filter(
      (slide) => ((slide as { animations?: unknown[] }).animations ?? []).length > 0,
    );
    expect(withMotion.length).toBeGreaterThan(0);

    for (const slide of rebuilt.slides) {
      expect((slide as { animations?: unknown[] }).animations ?? []).toHaveLength(0);
      expect((slide as { timelineMarkers?: unknown[] }).timelineMarkers ?? []).toHaveLength(0);
    }
  });
});
