import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PresentationDocumentSchema,
  SCHEMA_VERSION,
  validateDocument,
  walkElements,
  type PresentationDocument,
} from "../src/index";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".mydeck.json"));

function load(file: string): PresentationDocument {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as PresentationDocument;
}

describe("seed fixtures", () => {
  it("there are three of them", () => {
    expect(fixtureFiles.sort()).toEqual([
      "animation-test.mydeck.json",
      "repository-context.mydeck.json",
      "technical-deck.mydeck.json",
    ]);
  });

  for (const file of fixtureFiles) {
    describe(file, () => {
      const doc = load(file);

      it("validates with no errors", () => {
        const report = validateDocument(doc);
        expect(report.errors).toEqual([]);
        expect(report.valid).toBe(true);
      });

      it("declares the current schema version", () => {
        expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
      });

      /**
       * Serialization must be a pure round-trip. If parsing rewrites the document
       * — applying a default, dropping an unknown key, reordering — then two
       * clients saving the same untouched deck produce different bytes, and every
       * version diff becomes noise.
       */
      it("round-trips without loss", () => {
        const parsed = PresentationDocumentSchema.parse(doc);
        expect(JSON.parse(JSON.stringify(parsed))).toEqual(doc);
      });

      it("carries no editor state", () => {
        const json = JSON.stringify(doc);
        for (const forbidden of ["\"camera\"", "\"selection\"", "\"hover\"", "\"undoStack\""]) {
          expect(json).not.toContain(forbidden);
        }
      });

      /** A .mydeck file must be safe to email (doc 02 §29.1, §28.1). */
      it("carries no signed URLs or credentials", () => {
        const json = JSON.stringify(doc);
        expect(json).not.toMatch(/X-Amz-Signature|\?Signature=|Bearer\s/i);
        expect(json).not.toMatch(/"(apiKey|token|secret|password|connectionString)"/i);
      });

      it("has unique ids throughout", () => {
        const seen = new Set<string>();
        const claim = (id: string) => {
          expect(seen.has(id), `duplicate id ${id}`).toBe(false);
          seen.add(id);
        };
        claim(doc.id);
        claim(doc.theme.id);
        for (const slide of doc.slides) {
          claim(slide.id);
          for (const { element } of walkElements(slide.elements)) claim(element.id);
        }
      });
    });
  }
});

describe("technical deck specifics", () => {
  const doc = load("technical-deck.mydeck.json");

  it("emits repeated content as a container, not absolute boxes", () => {
    const kpiRow = doc.slides
      .flatMap((s) => [...walkElements(s.elements)])
      .map(({ element }) => element)
      .find((el) => el.type === "group" && (el as { groupRole?: string }).groupRole === "kpiRow");

    expect(kpiRow).toBeDefined();
    // The whole point of §16.2: four cards in a horizontal container survive a
    // longer label; the same four as absolute boxes overlap.
    expect((kpiRow as { containerLayout?: { type: string } }).containerLayout?.type).toBe(
      "horizontal",
    );
  });

  it("gives every slide a keyMessage", () => {
    for (const slide of doc.slides) {
      expect(slide.keyMessage, `slide ${slide.name} has no keyMessage`).toBeTruthy();
    }
  });

  it("has at most one headline per slide", () => {
    for (const slide of doc.slides) {
      const headlines = [...walkElements(slide.elements)].filter(
        ({ element }) => element.semanticRole === "headline",
      );
      expect(headlines.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("repository fixture", () => {
  const doc = load("repository-context.mydeck.json");

  it("grounds its claims: every provenance record points at a real element", () => {
    const elementIds = new Set(
      doc.slides.flatMap((s) => [...walkElements(s.elements)].map(({ element }) => element.id)),
    );
    expect(doc.provenance?.length).toBeGreaterThan(0);
    for (const record of doc.provenance ?? []) {
      expect(elementIds.has(record.targetId), `orphan provenance ${record.id}`).toBe(true);
    }
  });
});

describe("animation fixture", () => {
  const doc = load("animation-test.mydeck.json");

  /**
   * An element animating in from nothing must start at opacity 0, never
   * visible:false — a hidden element is excluded from layout and export, so the
   * fade would break both (doc 02 §8.2).
   */
  it("uses opacity 0 rather than visible:false for fade-in start states", () => {
    for (const slide of doc.slides) {
      const animatedIds = new Set((slide.animations ?? []).map((t) => t.targetId));
      for (const { element } of walkElements(slide.elements)) {
        if (!animatedIds.has(element.id)) continue;
        expect(element.visible, `${element.id} is hidden but animated`).not.toBe(false);
      }
    }
  });

  it("keeps every entrance within the theme's slide duration budget", () => {
    const budget = doc.theme.motion?.maxSlideDurationMs ?? 2500;
    for (const slide of doc.slides) {
      let end = 0;
      for (const track of slide.animations ?? []) {
        for (const clip of track.clips) {
          end = Math.max(end, clip.startMs + (clip.delayMs ?? 0) + clip.durationMs);
        }
      }
      expect(end).toBeLessThanOrEqual(budget);
    }
  });

  it("declares a reduced-motion path for every clip", () => {
    for (const slide of doc.slides) {
      for (const track of slide.animations ?? []) {
        for (const clip of track.clips) {
          const hasFallback = clip.reducedMotionPreset ?? clip.reducedMotionBehavior;
          expect(hasFallback, `clip ${clip.id} has no reduced-motion path`).toBeTruthy();
        }
      }
    }
  });
});
