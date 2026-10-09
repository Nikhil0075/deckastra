import { describe, expect, it } from "vitest";
import { localeTextHash, sayAsFingerprint } from "@deckastra/presentation-schema";

import { takeIsDue } from "../src/lib/narration-due";

const text = "Deckastra has four stages.";
const voiced = (sayAs?: string, voice = "hi-IN-Chirp3-HD-Kore") => ({
  text,
  takes: { en: { assetId: "ast_01JB8Z9K2QW4RN7F3X00000001", durationMs: 1200, textHash: localeTextHash(text), voice, ...(sayAs ? { sayAs } : {}) } },
});
const list = [{ term: "Deckastra", say: "Deck astra" }];

describe("a line is due for voicing", () => {
  it("when it has no take, or its take says older words", () => {
    expect(takeIsDue({ text, takes: {} }, "en", [])).toBe(true);
    expect(takeIsDue({ ...voiced(), text: "Deckastra has five stages." }, "en", [])).toBe(true);
    expect(takeIsDue(voiced(), "en", [])).toBe(false);
  });

  it("when a name it says is now said differently, and not otherwise", () => {
    expect(takeIsDue(voiced(), "en", list)).toBe(true);
    expect(takeIsDue(voiced(sayAsFingerprint(text, list)), "en", list)).toBe(false);
    expect(takeIsDue(voiced(sayAsFingerprint(text, list)), "en", [{ term: "Deckastra", say: "Decka-stra" }])).toBe(true);
    // Removing the name makes the voiced take due again: it says the old way.
    expect(takeIsDue(voiced(sayAsFingerprint(text, list)), "en", [])).toBe(true);
    // A name the line never says changes nothing.
    expect(takeIsDue(voiced(), "en", [{ term: "GCP", say: "G C P" }])).toBe(false);
  });

  it("never for a recording or an uploaded file", () => {
    expect(takeIsDue(voiced(undefined, "recorded"), "en", list)).toBe(false);
    expect(takeIsDue(voiced(undefined, "file"), "en", list)).toBe(false);
  });

  it("when this line is recast with another synthesized speaker", () => {
    expect(takeIsDue({ ...voiced(), voice: "en-US-Chirp3-HD-Aoede" }, "en", [])).toBe(true);
    expect(takeIsDue({ ...voiced(), voice: "hi-IN-Chirp3-HD-Kore" }, "en", [])).toBe(false);
    expect(takeIsDue({ ...voiced(undefined, "stub"), voice: "development-choice" }, "en", [])).toBe(false);
  });
});

describe("the speaking rate", () => {
  it("makes a voiced take due when it changes, and back again when it returns", () => {
    expect(takeIsDue(voiced(), "en", [], 1.2)).toBe(true);
    expect(takeIsDue(voiced(sayAsFingerprint(text, [], 1.2)), "en", [], 1.2)).toBe(false);
    expect(takeIsDue(voiced(sayAsFingerprint(text, [], 1.2)), "en", [], 1)).toBe(true);
    expect(takeIsDue(voiced(undefined, "recorded"), "en", [], 1.2)).toBe(false);
  });
});
