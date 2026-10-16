import { describe, expect, it } from "vitest";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { changedSince, placeWords } from "../src/lib/proposal-stale";

const deck = (title: string, words: string) =>
  ({
    metadata: { title },
    slides: [
      { id: "sld_a", elements: [{ id: "el_t", content: words }] },
      { id: "sld_b", elements: [] },
    ],
  }) as unknown as PresentationDocument;

describe("a pending change against newer edits", () => {
  it("is stale exactly where it would write over something that moved", () => {
    const base = deck("Old", "Agent read this");
    const head = deck("Old", "Person retyped this");
    const ops = [
      { op: "replace", path: "/slides/id:sld_a/elements/id:el_t/content", value: "Agent words" },
      { op: "replace", path: "/metadata/title", value: "Agent title" },
      { op: "add", path: "/slides/id:sld_b/elements/-", value: { id: "el_new" } },
    ] as const;
    expect(changedSince(base, head, ops as never)).toEqual(["/slides/id:sld_a/elements/id:el_t/content"]);
    expect(placeWords(["/slides/id:sld_a/elements/id:el_t/content"], head)).toBe("slide 1");
    expect(placeWords(["/metadata/title"], head)).toBe("the deck title");
  });

  it("is not stale when the edits were elsewhere", () => {
    expect(changedSince(deck("Old", "same"), deck("New title", "same"), [
      { op: "replace", path: "/slides/id:sld_a/elements/id:el_t/content", value: "x" },
    ] as never)).toEqual([]);
  });
});
