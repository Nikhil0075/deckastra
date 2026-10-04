import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { localeSlots, plainText, textContent, validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import {
  addLocaleOperations,
  addNarrationCuesOperations,
  addSoundCueOperations,
  cuesFromNotes,
  localeOperations,
  localeProgress,
  removeLocaleOperations,
  removeNarrationCueOperations,
  setLocaleEntriesOperations,
  setNarrationTakeOperations,
  setPlaybackOperations,
} from "../src/index";

const deck = () => loadFixture("multilingual");
const localize = (doc: PresentationDocument, locale: string) => applyPatch(doc, localeOperations(doc, locale)).document;

describe("showing a deck in a language", () => {
  it("replaces the words, names the language, and moves nothing", () => {
    const doc = deck();
    const hindi = localize(doc, "hi-IN");
    expect(hindi.metadata.title).toBe("बहुभाषी वर्णित डेक");
    expect(hindi.metadata.language).toBe("hi-IN");
    const before = doc.slides[0]!.elements[0]!;
    const after = hindi.slides[0]!.elements[0]!;
    expect(textContent((after as unknown as { content: never }).content)).toBe("एक डेक, हर भाषा");
    expect(after.transform).toEqual(before.transform);
    // The saved deck is untouched by viewing it.
    expect(doc.metadata.title).toBe("Multilingual Narrated Deck");
    expect(validateDocument(hindi).errors).toEqual([]);
  });

  it("is no patch at all in the source language, so the document comes back exactly", () => {
    const doc = deck();
    expect(localeOperations(doc, "en")).toEqual([]);
    expect(localize(doc, "en")).toEqual(doc);
    // Applying a language and then taking its inverse is the source again.
    const applied = applyPatch(doc, localeOperations(doc, "hi-IN"));
    expect(applyPatch(applied.document, applied.inverse).document).toEqual(doc);
  });

  it("leaves untranslated slots in the source language", () => {
    const arabic = localize(deck(), "ar");
    expect(arabic.metadata.title).toBe("عرض متعدد اللغات");
    expect(textContent((arabic.slides[0]!.elements[1] as unknown as { content: never }).content)).toBe("Translated words, the same layout");
  });

  it("skips an entry whose element has gone instead of failing", () => {
    const doc = deck();
    doc.slides[0]!.elements = doc.slides[0]!.elements.slice(0, 1);
    expect(() => localize(doc, "hi-IN")).not.toThrow();
  });
});

describe("writing translations", () => {
  it("adds a language, translates a slot, and stamps the source hash", () => {
    let doc = deck();
    doc = applyPatch(doc, addLocaleOperations(doc, "fr")).document;
    const slot = localeSlots(doc).find((candidate) => candidate.path === "/metadata/title")!;
    doc = applyPatch(doc, setLocaleEntriesOperations(doc, "fr", [{ slotPath: slot.path, value: "Deck multilingue", origin: "human" }])).document;
    expect(localize(doc, "fr").metadata.title).toBe("Deck multilingue");
    expect(validateDocument(doc).errors).toEqual([]);
    expect(localeProgress(doc, "fr").translated).toBe(1);
  });

  it("creates the language on first write, and refuses the source language", () => {
    const doc = deck();
    const operations = setLocaleEntriesOperations(doc, "de", [{ slotPath: "/metadata/title", value: "Mehrsprachig", origin: "machine" }]);
    expect(localize(applyPatch(doc, operations).document, "de").metadata.title).toBe("Mehrsprachig");
    expect(() => setLocaleEntriesOperations(doc, "en", [])).toThrow(/own language/);
    expect(() => addLocaleOperations(doc, "hi-IN")).toThrow(/already/);
  });

  it("counts translated, outdated and missing, and names them", () => {
    const doc = deck();
    const before = localeProgress(doc, "hi-IN");
    expect(before.outdated).toBe(0);
    expect(before.missing).toBeGreaterThan(0); // "Arabic", "Reviewed", "Draft" cells
    const element = doc.slides[0]!.elements[1] as unknown as { content: ReturnType<typeof plainText> };
    element.content = plainText("Translated words, one layout", element.content.blocks[0]!.id);
    const after = localeProgress(doc, "hi-IN");
    expect(after.outdated).toBe(1);
    expect(after.outdatedPaths[0]).toContain(doc.slides[0]!.elements[1]!.id);
  });

  it("removes a language, and the last one removes the map", () => {
    let doc = deck();
    doc = applyPatch(doc, removeLocaleOperations(doc, "ar")).document;
    expect(Object.keys(doc.locales!)).toEqual(["hi-IN"]);
    doc = applyPatch(doc, removeLocaleOperations(doc, "hi-IN")).document;
    expect(doc.locales).toBeUndefined();
  });
});

describe("narration and sound operations", () => {
  it("adds cues in step order and removes the last one with its container", () => {
    let doc = deck();
    const slide = doc.slides[0]!;
    let made = addNarrationCuesOperations(doc, slide.id, [{ step: 1, text: "B" }, { step: 0, text: "A" }]);
    doc = applyPatch(doc, made.operations).document;
    expect(doc.slides[0]!.narration!.cues.map((cue) => cue.text)).toEqual(["A", "B"]);
    made = addNarrationCuesOperations(doc, slide.id, [{ step: 0, text: "A2" }]);
    doc = applyPatch(doc, made.operations).document;
    expect(doc.slides[0]!.narration!.cues.map((cue) => cue.text)).toEqual(["A", "A2", "B"]);
    for (const cue of [...doc.slides[0]!.narration!.cues]) {
      doc = applyPatch(doc, removeNarrationCueOperations(doc, slide.id, cue.id)).document;
    }
    expect(doc.slides[0]!.narration).toBeUndefined();
  });

  it("attaches a take and its audio file in one patch, hashed against the script in that language", () => {
    let doc = deck();
    const slide = doc.slides[0]!;
    const made = addNarrationCuesOperations(doc, slide.id, [{ step: 0, text: "Hello" }]);
    doc = applyPatch(doc, made.operations).document;
    const asset = { id: "ast_01JB8Z9K2QW4RN7F3XZZZZZZZ1", type: "audio" as const, storageKey: "k", mimeType: "audio/wav", durationMs: 900 };
    doc = applyPatch(doc, setNarrationTakeOperations(doc, slide.id, made.ids[0]!, "en", { assetId: asset.id, durationMs: 900 }, asset)).document;
    expect(validateDocument(doc).errors).toEqual([]);
    expect(validateDocument(doc).warnings.map((issue) => issue.code)).not.toContain("W312");
    expect(doc.assets.some((entry) => entry.id === asset.id)).toBe(true);
  });

  it("splits notes into one cue per step, folding extra paragraphs into the last", () => {
    expect(cuesFromNotes("One\nTwo\nThree\nFour", 2)).toEqual([
      { step: 0, text: "One" },
      { step: 1, text: "Two" },
      { step: 2, text: "Three Four" },
    ]);
    expect(cuesFromNotes(undefined, 3)).toEqual([]);
    expect(cuesFromNotes("Only one", 3)).toEqual([{ step: 0, text: "Only one" }]);
  });

  it("adds a library sound on a click and sets playback", () => {
    let doc = deck();
    const slide = doc.slides[0]!;
    doc = applyPatch(doc, addSoundCueOperations(doc, slide.id, { source: { library: "chime" }, trigger: { type: "slideEnter" } }).operations).document;
    expect(doc.slides[0]!.soundCues).toHaveLength(1);
    doc = applyPatch(doc, setPlaybackOperations(doc, { mode: "manual" })).document;
    expect(doc.playback).toEqual({ mode: "manual" });
    expect(validateDocument(doc).errors).toEqual([]);
  });
});
