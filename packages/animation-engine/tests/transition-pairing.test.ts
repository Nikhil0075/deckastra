/**
 * Which element becomes which (doc 02 §26).
 *
 * The schema's rule is the thing under test: explicit pairing wins, auto-pairing
 * is scored, and **two unrelated objects are never silently morphed**. The last
 * one is why these tests care about refusals as much as matches — a morph
 * between two things that are not the same thing is an object visibly turning
 * into an unrelated object in front of an audience, which is worse than a cut.
 */

import { describe, expect, it } from "vitest";

import { PAIR_THRESHOLD, resolvePairing, scorePair } from "../src/transition/pairing";
import type { TransitionNode, TransitionSlide } from "../src/transition/types";

function node(id: string, extra: Partial<TransitionNode> = {}): TransitionNode {
  return {
    id,
    type: "text",
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    ...extra,
  };
}

function slide(id: string, nodes: TransitionNode[]): TransitionSlide {
  return { id, nodes };
}

describe("scoring a candidate pair", () => {
  it("never pairs across element types, whatever else matches", () => {
    // The strongest possible signal short of identity — same role, same size,
    // same words — and it still must not pair, because a chart turning into a
    // heading is not a morph anyone meant.
    const { confidence, reason } = scorePair(
      node("a", { type: "chart", semanticRole: "evidence", text: "Revenue" }),
      node("b", { type: "text", semanticRole: "evidence", text: "Revenue" }),
    );

    expect(confidence).toBe(0);
    expect(reason).toContain("different element types");
  });

  it("treats the same id on both slides as identity", () => {
    expect(scorePair(node("el_1"), node("el_1")).confidence).toBe(1);
  });

  it("ranks the same words and the same image above a mere resemblance", () => {
    const sameWords = scorePair(node("a", { text: "Q4 revenue" }), node("b", { text: "q4   REVENUE " }));
    const sameImage = scorePair(
      node("a", { type: "image", assetKey: "ast_1" }),
      node("b", { type: "image", assetKey: "ast_1" }),
    );
    const justSimilar = scorePair(node("a"), node("b"));

    expect(sameWords.confidence).toBeGreaterThan(PAIR_THRESHOLD);
    expect(sameImage.confidence).toBeGreaterThan(PAIR_THRESHOLD);
    // Two same-sized boxes with no shared identity. This is the case the
    // threshold exists for: without it, every bullet morphs into every bullet.
    expect(justSimilar.confidence).toBeLessThan(PAIR_THRESHOLD);
    expect(justSimilar.reason).toContain("not identity");
  });
});

describe("resolving a pairing", () => {
  const from = slide("s1", [node("a", { text: "Revenue" }), node("b", { text: "Costs" })]);
  const to = slide("s2", [node("c", { text: "Costs" }), node("d", { text: "Revenue" })]);

  it("does not pair anything unless asked", () => {
    // A deck must not start morphing because someone reordered two slides that
    // happen to share a heading. Auto-pairing is a thing an author turns on.
    expect(resolvePairing({ from, to }).pairs).toEqual([]);
  });

  it("pairs by identity rather than by position when asked", () => {
    const { pairs } = resolvePairing({ from, to, auto: true });

    expect(pairs.map((pair) => [pair.sourceId, pair.destinationId])).toEqual([
      ["a", "d"],
      ["b", "c"],
    ]);
    expect(pairs.every((pair) => pair.origin === "auto")).toBe(true);
    expect(pairs[0]!.reason).toContain("the same text");
  });

  it("honours the author over the heuristic", () => {
    // Deliberately the pairing the scorer would not choose. An explicit mapping
    // is a decision, not a suggestion.
    const { pairs } = resolvePairing({
      from,
      to,
      auto: true,
      explicit: [{ sourceElementId: "a", destinationElementId: "c" }],
    });

    const explicit = pairs.find((pair) => pair.origin === "explicit")!;
    expect([explicit.sourceId, explicit.destinationId]).toEqual(["a", "c"]);
    expect(explicit.confidence).toBe(1);
    // And neither half is then available to the heuristic.
    expect(pairs.filter((pair) => pair.sourceId === "a")).toHaveLength(1);
    expect(pairs.filter((pair) => pair.destinationId === "c")).toHaveLength(1);
  });

  it("names a mapping whose element is gone instead of dropping it quietly", () => {
    const { pairs, warnings } = resolvePairing({
      from,
      to,
      explicit: [{ sourceElementId: "a", destinationElementId: "deleted" }],
    });

    expect(pairs).toEqual([]);
    expect(warnings[0]).toContain("deleted");
    expect(warnings[0]).toContain("not on its slide any more");
  });

  it("keeps the near misses it refused", () => {
    const plain = slide("s3", [node("x"), node("y")]);
    const { pairs, rejected } = resolvePairing({ from: plain, to: slide("s4", [node("z")]), auto: true });

    expect(pairs).toEqual([]);
    // Inspectable rather than invisible: an author wondering why nothing morphed
    // can be shown what was considered and how close it came.
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]!.confidence).toBeLessThan(PAIR_THRESHOLD);
  });

  it("pairs the same way every time", () => {
    // Document order is the tie-break, so the result cannot depend on Map
    // iteration or on which slide happened to be loaded first. A morph that
    // moved between opens would be the worst kind of bug to reproduce.
    const once = resolvePairing({ from, to, auto: true }).pairs;
    const twice = resolvePairing({ from, to, auto: true }).pairs;
    expect(once).toEqual(twice);
  });

  it("gives each element at most one partner", () => {
    const many = slide("s5", [node("t1", { text: "Same" }), node("t2", { text: "Same" })]);
    const one = slide("s6", [node("t3", { text: "Same" })]);

    const { pairs } = resolvePairing({ from: many, to: one, auto: true });

    expect(pairs).toHaveLength(1);
  });
});
