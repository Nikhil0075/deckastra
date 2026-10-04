import { describe, expect, it } from "vitest";

import { findPronunciations, sayAsFingerprint, type Pronunciation } from "../src/pronunciation";

/**
 * Fixed vectors, shared word for word with
 * `apps/api/tests/test_google_providers.py::test_say_as_fingerprints_match_the_editors`.
 * The panel counts what is due with this function and the service decides what
 * to voice with its Python twin; a change to either fails here until both agree.
 */
const LIST: Pronunciation[] = [
  { term: "Deckastra", say: "Deck astra" },
  { term: "AI", say: "A I" },
  { term: "gcp", say: "G C P" },
  { term: "डेक", say: "डेक़" },
  { term: "AI", say: "eye" },
];
const VECTORS: [string, string][] = [
  ["Deckastra has four stages.", "fnv1a64:99a537db4aeea714"],
  ["The AI said hello to GCP and deckastra.", "fnv1a64:81de9de5d79a72c8"],
  ["Nothing to rename here.", ""],
  ["डेकास्ट्रा Deckastra में", "fnv1a64:99a537db4aeea714"],
  ["एक डेक, हर भाषा", "fnv1a64:720a01830a2343da"],
  ["AIs and AI_x and xAI", ""],
];

describe("say-as fingerprints", () => {
  it.each(VECTORS)("%s", (text, expected) => {
    expect(sayAsFingerprint(text, LIST)).toBe(expected);
  });

  it("treats a vowel sign as part of the word, so a name is not found inside a longer one", () => {
    expect(findPronunciations("डेकास्ट्रा", LIST)).toEqual([]);
    expect(findPronunciations("एक डेक", LIST).map((hit) => hit.item.term)).toEqual(["डेक"]);
  });
});

describe("delivery", () => {
  it("counts the speaking rate, with the same value the service writes", () => {
    // Shared with test_google_providers.py::test_rate_enters_the_fingerprint.
    expect(sayAsFingerprint("Plain line.", [], 1.15)).toBe("fnv1a64:17fb203370813577");
    expect(sayAsFingerprint("Plain line.", [], 1)).toBe("");
  });

  it("reads pauses as the service does, and hides them from a reader", async () => {
    const { pauseMsIn, scriptForDisplay, pauseMarker } = await import("../src/pronunciation");
    const text = "Deckastra runs on GCP. [pause 1.5s] Then [pause] it speaks [PAUSE 800ms].";
    expect(pauseMsIn(text)).toBe(1500 + 500 + 800);
    expect(scriptForDisplay(text)).toBe("Deckastra runs on GCP. Then it speaks.");
    expect(pauseMsIn("[pause 99s]")).toBe(10_000);
    expect([pauseMarker(500), pauseMarker(1000), pauseMarker(750)]).toEqual(["[pause]", "[pause 1s]", "[pause 750ms]"]);
  });
});
