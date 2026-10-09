import { describe, expect, it } from "vitest";
import { validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { applyPatch } from "@deckastra/transactions";
import { buildDocumentScene } from "@deckastra/renderer";

import {
  EDITABLE_KINDS,
  addPair,
  pairCandidates,
  pairRows,
  removePair,
  setTransitionDirection,
  setTransitionDuration,
  setTransitionKind,
  transitionState,
} from "../src/lib/transition-editing";
import { budgetLine, carryableRoles, measurePlan, planFingerprint, slideRoles } from "../src/lib/motion-plan";

/**
 * The transition editor and the plan-by-roles preview (editor Phase 7), against
 * the animation fixture: its slides enter by fade, slide, zoom and a morph with
 * two explicit pairs.
 */

const deck = () => loadFixture("animation") as PresentationDocument;
const apply = (document: PresentationDocument, operations: Parameters<typeof applyPatch>[1]) =>
  applyPatch(document, operations).document;
const errors = (document: PresentationDocument) => validateDocument(document).errors;

describe("editing a transition", () => {
  it("reads what the slide has, and treats no transition as a cut", () => {
    const document = deck();
    expect(transitionState(document.slides[0]!).kind).toBe("fade");
    expect(transitionState(document.slides[3]!).kind).toBe("morph");
    const bare = { ...document.slides[0]!, transition: undefined };
    expect(transitionState(bare).kind).toBe("cut");
    const push = { ...document.slides[0]!, transition: { type: "push", durationMs: 300 } };
    expect(transitionState(push)).toMatchObject({ kind: "push", foreign: null });
  });

  it("changes kind as one patch, keeping duration and easing", () => {
    const document = deck();
    const zoomSlide = document.slides[2]!;
    const change = setTransitionKind(document, zoomSlide.id, "fade");
    const after = apply(document, change.operations);
    expect(after.slides[2]!.transition).toMatchObject({ type: "fade", durationMs: 500, easing: "emphasized" });
    expect(errors(after)).toEqual([]);
  });

  it("a cut removes the transition, and says when that took a morph's pairs with it", () => {
    const document = deck();
    const morph = document.slides[3]!;
    const change = setTransitionKind(document, morph.id, "cut");
    expect(change.operations).toEqual([{ op: "remove", path: `/slides/id:${morph.id}/transition` }]);
    expect(change.notice).toMatch(/2 shared-element pairs were removed/);
    expect(apply(document, change.operations).slides[3]!.transition).toBeUndefined();
  });

  it("leaving a morph drops its pairs and says so; a slide gets a direction", () => {
    const document = deck();
    const morph = document.slides[3]!;
    const change = setTransitionKind(document, morph.id, "slide");
    const next = apply(document, change.operations).slides[3]!.transition!;
    expect(next).toMatchObject({ type: "slide", direction: "left", durationMs: 600 });
    expect(next.sharedElements).toBeUndefined();
    expect(change.notice).toBeTruthy();
  });

  it("a slide with no transition gets the kind's own duration", () => {
    const document = apply(deck(), [{ op: "remove", path: `/slides/id:${deck().slides[1]!.id}/transition` }]);
    const change = setTransitionKind(document, document.slides[1]!.id, "morph");
    expect(apply(document, change.operations).slides[1]!.transition).toEqual({ type: "morph", durationMs: 600 });
  });

  it("clamps a duration, and offers nothing to a cut", () => {
    const document = deck();
    const id = document.slides[0]!.id;
    expect(apply(document, setTransitionDuration(document, id, 99_999).operations).slides[0]!.transition!.durationMs).toBe(3000);
    const cut = apply(document, setTransitionKind(document, id, "cut").operations);
    expect(setTransitionDuration(cut, id, 400).operations).toEqual([]);
    expect(setTransitionDirection(cut, id, "up").operations).toEqual([]);
  });

  it("an unchanged value writes nothing", () => {
    const document = deck();
    expect(setTransitionKind(document, document.slides[0]!.id, "fade").operations).toEqual([]);
  });

  it("can author every transition the engine advertises", () => {
    const document = deck();
    const id = document.slides[1]!.id;
    for (const kind of EDITABLE_KINDS) {
      const change = setTransitionKind(document, id, kind);
      const after = apply(document, change.operations);
      expect(transitionState(after.slides[1]!).kind).toBe(kind);
      expect(errors(after), kind).toEqual([]);
    }
  });
});

describe("shared-element pairs", () => {
  it("lists the document's pairs as manual, by name", () => {
    const document = deck();
    const rows = pairRows(document, document.slides[3]!.id);
    expect(rows.map((row) => row.origin)).toEqual(["manual", "manual"]);
    expect(rows.every((row) => !row.missing && row.sourceLabel && row.destinationLabel)).toBe(true);
    // An unnamed shape is called by its role, so two shape pairs can be told apart.
    expect(rows[1]).toMatchObject({ sourceLabel: "decoration (shape)", destinationLabel: "decoration (shape)" });
  });

  it("suggests, but never writes, an auto pair", () => {
    const document = deck();
    const morph = document.slides[3]!;
    // With the explicit pairs gone, the engine is free to suggest.
    const bare = apply(document, removePair(document, morph.id, 1).operations);
    const unpaired = apply(bare, removePair(bare, morph.id, 0).operations);
    expect(unpaired.slides[3]!.transition!.sharedElements).toBeUndefined();
    const scene = buildDocumentScene(unpaired);
    const rows = pairRows(unpaired, morph.id, { from: scene.slides[2], to: scene.slides[3] });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.origin === "auto" && row.reason && row.confidence! > 0)).toBe(true);
    // The document still has none: a suggestion is only written when kept.
    expect(unpaired.slides[3]!.transition!.sharedElements).toBeUndefined();

    const kept = addPair(unpaired, morph.id, rows[0]!.sourceId, rows[0]!.destinationId);
    const after = apply(unpaired, kept.operations);
    expect(after.slides[3]!.transition!.sharedElements).toEqual([
      { sourceElementId: rows[0]!.sourceId, destinationElementId: rows[0]!.destinationId },
    ]);
    expect(errors(after)).toEqual([]);
  });

  it("an object is in one pair at most, and only a morph pairs", () => {
    const document = deck();
    const morph = document.slides[3]!;
    const [first] = morph.transition!.sharedElements!;
    expect(addPair(document, morph.id, first!.sourceElementId, "el_other").operations).toEqual([]);
    expect(addPair(document, document.slides[2]!.id, "a", "b").notice).toMatch(/Only a morph/);
    // Candidates exclude what is already paired.
    const { sources, destinations } = pairCandidates(document, morph.id);
    expect(sources.some((choice) => choice.id === first!.sourceElementId)).toBe(false);
    expect(destinations.some((choice) => choice.id === first!.destinationElementId)).toBe(false);
  });
});

describe("planning by roles", () => {
  it("reads roles from the top level, and what a morph can carry", () => {
    const document = deck();
    expect(slideRoles(document.slides[0]!)).toEqual([
      { role: "headline", count: 1 },
      { role: "metric", count: 1 },
    ]);
    expect(carryableRoles(document.slides[2], document.slides[3])).toEqual(["headline", "decoration"]);
  });

  it("measures a plan with the timeline present mode plays", () => {
    const document = deck();
    const slide = document.slides[2]!;
    const plan = measurePlan(document, slide.id, [
      { op: "add", path: `/slides/id:${slide.id}/animations`, value: [] },
    ]);
    expect(plan.error).toBeNull();
    expect(plan.budget).toMatchObject({ entranceMs: 0, exceeded: false });
    expect(budgetLine(plan.budget)).toMatch(/first frame/);
    // A slide with real entrances measures a real total, with a line per track.
    const animated = document.slides[0]!;
    const replay = measurePlan(document, animated.id, [
      { op: "replace", path: `/slides/id:${animated.id}/animations`, value: animated.animations },
    ]);
    expect(replay.budget!.entranceMs).toBeGreaterThan(0);
    expect(replay.tracks).toHaveLength(animated.animations!.length);
    expect(replay.tracks.some((line) => line.startsWith("Motion reinforces order —"))).toBe(true);
    expect(budgetLine({ entranceMs: 2100, limitMs: 2500, exceeded: false })).toBe("Total 2.1s — within the 2.5s budget");
    expect(budgetLine({ entranceMs: 3000, limitMs: 2500, exceeded: true })).toBe("Total 3.0s — over the 2.5s budget");
  });

  it("a plan for a slide that changed since is stale; one for a slide that did not is not", () => {
    const document = deck();
    const slide = document.slides[3]!;
    const planned = planFingerprint(document, slide.id, "transition");
    // Changing the transition itself does not stale a transition plan.
    const retimed = apply(document, setTransitionDuration(document, slide.id, 900).operations);
    expect(planFingerprint(retimed, slide.id, "transition")).toBe(planned);
    // Moving an element on the slide before does: a morph pairs with it.
    const before = document.slides[2]!;
    const moved = apply(document, [
      { op: "replace", path: `/slides/id:${before.id}/elements/id:${before.elements[0]!.id}/transform/x`, value: 7 },
    ]);
    expect(planFingerprint(moved, slide.id, "transition")).not.toBe(planned);
    // An entrance plan does not care about the slide before.
    expect(planFingerprint(moved, slide.id, "animations")).toBe(planFingerprint(document, slide.id, "animations"));
  });
});
