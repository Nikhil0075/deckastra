import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PresentationDocumentSchema,
  isKnownElementType,
  isReadableSchemaVersion,
  newId,
  serializeDocument,
  validateDocument,
  walkElements,
  type PresentationDocument,
} from "../src/index";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function baseDoc(): PresentationDocument {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "technical-deck.mydeck.json"), "utf8"),
  ) as PresentationDocument;
}

/**
 * The forward-compatibility rule (doc 02 §0.8) is what allows a newer client to
 * add a property, an older client to open and save the same deck, and the newer
 * client to still find its property intact.
 *
 * Every test here is really the same test: an older reader must never silently
 * delete something it does not understand.
 */
describe("forward compatibility", () => {
  it("preserves unknown properties on an element", () => {
    const doc = baseDoc();
    const slide = doc.slides[0]!;
    (slide.elements[0] as Record<string, unknown>).futureGlow = {
      intensity: 0.7,
      color: "#ff00ff",
    };

    const round = JSON.parse(JSON.stringify(PresentationDocumentSchema.parse(doc)));
    expect(round.slides[0].elements[0].futureGlow).toEqual({ intensity: 0.7, color: "#ff00ff" });
  });

  it("preserves unknown properties on the document, slide and theme", () => {
    const doc = baseDoc();
    (doc as Record<string, unknown>).futureTopLevel = "keep me";
    (doc.slides[0] as Record<string, unknown>).futureSlideProp = 42;
    (doc.theme as Record<string, unknown>).futureThemeToken = { elevation: 3 };

    const round = JSON.parse(JSON.stringify(PresentationDocumentSchema.parse(doc)));
    expect(round.futureTopLevel).toBe("keep me");
    expect(round.slides[0].futureSlideProp).toBe(42);
    expect(round.theme.futureThemeToken).toEqual({ elevation: 3 });
  });

  it("preserves an element of an unknown type rather than dropping it", () => {
    const doc = baseDoc();
    const slide = doc.slides[0]!;
    slide.elements.push({
      id: newId("el"),
      type: "hologram",
      transform: { x: 10, y: 10, width: 100, height: 100 },
      density: 0.4,
    } as never);

    const round = JSON.parse(JSON.stringify(PresentationDocumentSchema.parse(doc)));
    const survivor = round.slides[0].elements.at(-1);

    expect(survivor.type).toBe("hologram");
    expect(survivor.density).toBe(0.4);
    expect(isKnownElementType(survivor.type)).toBe(false);
  });

  it("treats an unknown element type as a warning, not an error", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements.push({
      id: newId("el"),
      type: "hologram",
      transform: { x: 10, y: 10, width: 100, height: 100 },
    } as never);

    const report = validateDocument(doc);
    // The renderer draws a labelled placeholder and agents refuse to edit it, but
    // the document is still valid — refusing it would delete the user's content.
    expect(report.valid).toBe(true);
    expect(report.warnings.some((w) => w.message.includes("hologram"))).toBe(true);
  });

  it("preserves unknown enum values", () => {
    const doc = baseDoc();
    const slide = doc.slides[0]!;
    slide.transition = { type: "kaleidoscope", durationMs: 400 } as never;

    const round = JSON.parse(JSON.stringify(PresentationDocumentSchema.parse(doc)));
    // Unknown transition types round-trip; the renderer falls back to a cut.
    expect(round.slides[0].transition.type).toBe("kaleidoscope");
  });

  it("refuses a newer major version outright", () => {
    // Forward-compatible reading is not forward-compatible editing. Opening a v2
    // document with v1 rules and saving it would corrupt whatever v2 added.
    expect(isReadableSchemaVersion("2.0.0")).toBe(false);
    expect(isReadableSchemaVersion("1.9.3")).toBe(true);

    const doc = baseDoc();
    doc.schemaVersion = "2.0.0";
    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.code === "E004")).toBe(true);
  });

  it("survives a full older-reader simulation: open, walk, save", () => {
    const doc = baseDoc();
    (doc.slides[0]!.elements[0] as Record<string, unknown>).v2Only = { a: [1, 2, 3] };
    const original = serializeDocument(doc);

    // An older reader opens the deck, walks every element (rendering what it
    // knows), and saves. Nothing it did not understand may have moved or vanished.
    //
    // Note the save path: the document is serialized, NOT the Zod parse output.
    // Parsing reconstructs the object in schema-declaration order, so persisting
    // that result would reorder keys on every open-and-save and turn each version
    // diff into noise. Parse validates; serializeDocument writes.
    const reopened = JSON.parse(original) as PresentationDocument;
    PresentationDocumentSchema.parse(reopened);
    for (const slide of reopened.slides) {
      for (const { element } of walkElements(slide.elements)) void element.type;
    }

    expect(serializeDocument(reopened)).toBe(original);
  });
});
