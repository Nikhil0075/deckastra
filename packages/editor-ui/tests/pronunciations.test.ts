import { describe, expect, it } from "vitest";

import { formatPronunciations, parsePronunciations, storedPronunciations } from "../src/lib/pronunciations";

describe("say names as", () => {
  it("reads one pair a line and skips what is half-typed", () => {
    expect(parsePronunciations("Deckastra = Deck astra\nGCP=G C P\nhalf-typed\n= nothing\nempty =\n")).toEqual([
      { term: "Deckastra", say: "Deck astra" },
      { term: "GCP", say: "G C P" },
    ]);
  });

  it("keeps the first spelling of a term, whatever its case", () => {
    expect(parsePronunciations("AI = A I\nai = eye")).toEqual([{ term: "AI", say: "A I" }]);
  });

  it("round-trips through the stored preference, and ignores a malformed one", () => {
    const list = parsePronunciations("Deckastra = Deck astra");
    expect(parsePronunciations(formatPronunciations(list))).toEqual(list);
    expect(storedPronunciations({ list })).toEqual(list);
    expect(storedPronunciations({ list: [{ term: 3 }] })).toEqual([]);
    expect(storedPronunciations("nonsense")).toEqual([]);
  });
});
