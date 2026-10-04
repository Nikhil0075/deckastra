import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PresentationDocumentSchema,
  computeRiskTier,
  isLocalizablePath,
  localeDirection,
  localeEntryPath,
  localeScript,
  localeSlots,
  localeTextHash,
  plainText,
  slotOfEntryPath,
  splitPath,
  validateDocument,
  type PresentationDocument,
} from "../src/index";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (file: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as PresentationDocument;
const multilingual = () => load("multilingual-narrated.mydeck.json");
const codes = (doc: unknown) => {
  const report = validateDocument(doc);
  return [...report.errors, ...report.warnings].map((issue) => issue.code);
};

describe("locale overlays", () => {
  it("the multilingual fixture validates clean and round-trips", () => {
    const doc = multilingual();
    const report = validateDocument(doc);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(JSON.parse(JSON.stringify(PresentationDocumentSchema.parse(doc)))).toEqual(doc);
  });

  it("finds every kind of text slot, id-addressed", () => {
    const paths = localeSlots(multilingual()).map((slot) => slot.path);
    expect(paths).toContain("/metadata/title");
    expect(paths.some((path) => path.endsWith("/speakerNotes"))).toBe(true);
    expect(paths.some((path) => /\/narration\/cues\/id:nar_[^/]+\/text$/.test(path))).toBe(true);
    expect(paths.some((path) => /\/columns\/id:col_[^/]+\/label$/.test(path))).toBe(true);
    expect(paths.some((path) => /\/rows\/id:row_[^/]+\/cells\/1\/content$/.test(path))).toBe(true);
    // Every enumerated slot is on the allowlist the validator enforces.
    for (const path of paths) expect(isLocalizablePath(path), path).toBe(true);
  });

  it("keeps an entry whose element was deleted, and says so (W320)", () => {
    const doc = multilingual();
    const slide = doc.slides[0]!;
    slide.elements = slide.elements.slice(0, 1); // the subtitle is gone
    const report = validateDocument(doc);
    expect(report.valid).toBe(true);
    expect(report.warnings.map((issue) => issue.code)).toContain("W320");
    expect(Object.keys(doc.locales!["hi-IN"]!.entries).some((path) => path.includes(slide.id))).toBe(true);
  });

  it("refuses an entry that is not a text slot (E320)", () => {
    const doc = multilingual();
    const slide = doc.slides[0]!;
    const element = slide.elements[0]!;
    doc.locales!["hi-IN"]!.entries[`/slides/id:${slide.id}/elements/id:${element.id}/transform/x`] = {
      value: "120",
      sourceHash: localeTextHash("120"),
      origin: "human",
    };
    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain("E320");
  });

  it("refuses rich text in a string slot and a string in a rich slot (E321)", () => {
    const doc = multilingual();
    const titleSlot = localeSlots(doc).find((slot) => slot.path.endsWith("/content"))!;
    doc.locales!["hi-IN"]!.entries[titleSlot.path] = { value: "plain", sourceHash: localeTextHash(titleSlot.value), origin: "human" };
    doc.locales!["hi-IN"]!.entries["/metadata/title"] = { value: plainText("rich", "blk_01JB8Z9K2QW4RN7F3XZZZZZZZZ"), sourceHash: "x", origin: "human" };
    expect(codes(doc).filter((code) => code === "E321")).toHaveLength(2);
  });

  it("reports an outdated entry when the source text changes (W321), not when only its formatting does", () => {
    const doc = multilingual();
    const element = doc.slides[0]!.elements[0] as unknown as { content: { blocks: { spans: { text: string; bold?: boolean }[] }[] } };
    element.content.blocks[0]!.spans[0]!.bold = true;
    expect(codes(doc)).not.toContain("W321");
    element.content.blocks[0]!.spans[0]!.text = "One deck, many languages";
    expect(codes(doc)).toContain("W321");
  });

  it("refuses an overlay filed under the wrong key (E322) and warns about one for the source language (W326)", () => {
    const doc = multilingual();
    doc.locales!["fr"] = { ...doc.locales!["ar"]!, locale: "ar" };
    doc.locales!["en"] = { locale: "en", status: "draft", entries: {} };
    const found = codes(doc);
    expect(found).toContain("E322");
    expect(found).toContain("W326");
  });

  it("escapes slot paths into one entry segment and back", () => {
    const slot = "/slides/id:sld_A/elements/id:el_B/content";
    const path = localeEntryPath("hi-IN", slot);
    expect(splitPath(path)).toEqual(["locales", "hi-IN", "entries", slot]);
    expect(slotOfEntryPath(path)).toEqual({ locale: "hi-IN", slotPath: slot });
  });

  it("hashes plain text, so the same words in rich text hash the same", () => {
    expect(localeTextHash(plainText("Hello", "blk_01JB8Z9K2QW4RN7F3XZZZZZZZZ"))).toBe(localeTextHash("Hello"));
    expect(localeTextHash("Hello")).not.toBe(localeTextHash("Hello!"));
    expect(localeTextHash("")).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("knows which way a language is written and in which script", () => {
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("ur-PK")).toBe("rtl");
    expect(localeDirection("hi-IN")).toBe("ltr");
    expect(localeScript("hi-IN")).toBe("devanagari");
    expect(localeScript("pa-Arab")).toBe("arabic");
    expect(localeScript("ja")).toBe("japanese");
    expect(localeScript("fr")).toBe("latin");
  });
});

describe("narration and sound", () => {
  it("marks a take stale when the script it says changes (W322)", () => {
    const doc = multilingual();
    const cue = doc.slides[1]!.narration!.cues[0]!;
    cue.text = "A different opening line.";
    const report = validateDocument(doc);
    const stale = report.warnings.filter((issue) => issue.code === "W322");
    // The English take says the old words. The Hindi one says its own script,
    // which an overlay still holds, so it is not stale.
    expect(stale).toHaveLength(1);
    expect(stale[0]!.path).toContain("/takes/en");
  });

  it("refuses a take or a sound whose audio is not in the manifest (E111)", () => {
    const doc = multilingual();
    doc.assets = doc.assets.slice(1);
    const sound = doc.slides[1]!.soundCues![0]!;
    sound.source = { assetId: "ast_01JB8Z9K2QW4RN7F3XZZZZZZZZ" };
    const errors = validateDocument(doc).errors.map((issue) => issue.code);
    expect(errors.filter((code) => code === "E111")).toHaveLength(2);
  });

  it("keeps a library sound it does not know and warns (W324)", () => {
    const doc = multilingual();
    doc.slides[1]!.soundCues![0]!.source = { library: "theremin-solo" };
    const report = validateDocument(doc);
    expect(report.valid).toBe(true);
    expect(report.warnings.map((issue) => issue.code)).toContain("W324");
  });

  it("refuses a duplicate cue id like any other id (E001)", () => {
    const doc = multilingual();
    const cues = doc.slides[1]!.narration!.cues;
    cues[1]!.id = cues[0]!.id;
    expect(validateDocument(doc).errors.map((issue) => issue.code)).toContain("E001");
  });
});

describe("the risk of a translation", () => {
  const entry = (slide: string) => ({
    op: "add" as const,
    path: localeEntryPath("hi-IN", `/slides/id:${slide}/speakerNotes`),
    value: { value: "x", sourceHash: "h", origin: "machine" },
  });

  it("counts the slides whose words an overlay replaces", () => {
    expect(computeRiskTier([entry("sld_A")]).tier).toBe("low");
    expect(computeRiskTier(["sld_A", "sld_B", "sld_C", "sld_D"].map(entry)).tier).toBe("high");
  });

  it("finds entries inside a whole overlay added at once", () => {
    const entries = Object.fromEntries(["sld_A", "sld_B", "sld_C", "sld_D"].map((slide) => [`/slides/id:${slide}/speakerNotes`, { value: "x" }]));
    expect(computeRiskTier([{ op: "add", path: "/locales", value: { "hi-IN": { locale: "hi-IN", status: "draft", entries } } }]).tier).toBe("high");
    expect(computeRiskTier([{ op: "add", path: "/locales/hi-IN", value: { locale: "hi-IN", status: "draft", entries } }]).tier).toBe("high");
  });
});
