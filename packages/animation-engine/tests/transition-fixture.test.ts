/**
 * The conformance deck's morph, compiled from the fixture (D4.1).
 *
 * Every other test in this module builds its slides out of object literals,
 * which is right for a pure function and proves nothing about whether the
 * product's own deck exercises the path. Until the fixture carried a morph,
 * nothing in the repository did — a transition type the schema has had since v1
 * had no coverage anywhere, in either direction.
 *
 * So this one goes the whole way: the committed fixture, through the real scene
 * build, through the adapter, into the compiler. If any link stops carrying
 * `sharedElements` — the scene build silently dropped them once already — this
 * is what notices.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildDocumentScene } from "@deckastra/renderer";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { compileTransition, transitionSlideFromScene } from "../src/transition";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "presentation-schema",
  "fixtures",
  "animation-test.mydeck.json",
);

function morphPair() {
  const document = JSON.parse(readFileSync(FIXTURE, "utf8")) as PresentationDocument;
  const scene = buildDocumentScene(document);
  const to = scene.slides.find((slide) => slide.transition?.type === "morph")!;
  const from = scene.slides[to.index - 1]!;
  return { from, to };
}

describe("the fixture's shared-element morph", () => {
  it("survives the scene build with its pairings", () => {
    const { to } = morphPair();

    // The scene used to narrow a transition to type, duration and easing, which
    // dropped exactly this. A fact the scene does not carry is one the engine
    // cannot act on, and the symptom was a crossfade with no explanation.
    expect(to.transition?.sharedElements).toHaveLength(2);
    expect(to.transition?.sharedElements?.[1]?.matchMode).toBe("position");
  });

  it("compiles to real movement for both paired elements", () => {
    const { from, to } = morphPair();

    const compiled = compileTransition(
      to.transition,
      transitionSlideFromScene(from),
      transitionSlideFromScene(to),
    );

    expect(compiled.type).toBe("morph");
    expect(compiled.warnings).toEqual([]);
    expect(compiled.pairing.pairs).toHaveLength(2);
    // Author-declared, so nothing here depends on the scoring heuristic.
    expect(compiled.pairing.pairs.every((pair) => pair.origin === "explicit")).toBe(true);

    const paired = compiled.tracks.filter((track) => track.kind === "paired");
    expect(paired).toHaveLength(2);
    // Both actually travel: a pair that does not move emits no track, so two
    // tracks is the fixture proving it exercises the delta path rather than
    // merely declaring a mapping.
    for (const track of paired) {
      const start = track.keyframes[0]!.properties;
      expect(`${start.translateX} ${start.translateY}`).not.toBe("0px 0px");
    }
  });

  it("scales the headline and refuses to scale the badge", () => {
    const { from, to } = morphPair();
    const compiled = compileTransition(
      to.transition,
      transitionSlideFromScene(from),
      transitionSlideFromScene(to),
    );

    const byTarget = new Map(
      compiled.tracks.filter((track) => track.kind === "paired").map((track) => [track.targetId, track]),
    );
    const headline = to.nodes.find((node) => node.semanticRole === "headline")!;
    const badge = to.nodes.find((node) => node.semanticRole === "decoration")!;

    // `positionAndScale`: the box grew, so the element starts smaller.
    expect(Number(byTarget.get(headline.id)!.keyframes[0]!.properties.scaleX)).toBeLessThan(1);
    // `position`: the author said these two sizes differ for a reason, and that
    // is a permission rather than a hint.
    expect(byTarget.get(badge.id)!.keyframes[0]!.properties.scaleX).toBe(1);
  });

  it("still cuts under reduced motion", () => {
    const { from, to } = morphPair();
    const compiled = compileTransition(
      to.transition,
      transitionSlideFromScene(from),
      transitionSlideFromScene(to),
      { motion: "reduced" },
    );

    expect(compiled.type).toBe("cut");
    expect(compiled.tracks).toEqual([]);
  });
});
