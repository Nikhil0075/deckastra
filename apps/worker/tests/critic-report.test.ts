import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { buildCriticReport } from "../src/critic-report";

describe("render critic report", () => {
  it("reports deterministic facts from the resolved scene", () => {
    const document = loadFixture("technical");
    const report = buildCriticReport(buildDocumentScene(document));

    expect(report).toMatchObject({
      version: 1,
      documentId: document.id,
      slides: expect.any(Array),
      totals: {
        overflow: expect.any(Number),
        overlaps: expect.any(Number),
        outOfBounds: expect.any(Number),
        lowContrast: expect.any(Number),
        accessibilityErrors: expect.any(Number),
        missingFonts: expect.any(Number),
      },
    });
    expect(report.slides).toHaveLength(document.slides.length);
    expect(report.slides[0]!.density.occupiedAreaRatio).toBeGreaterThan(0);
  });

  it("detects a real collision without counting a filled container behind content", () => {
    const document = structuredClone(loadFixture("technical"));
    const slide = document.slides[0]!;
    const first = slide.elements[0]!;
    const second = slide.elements[1]!;
    second.transform = { ...second.transform, ...first.transform };

    const report = buildCriticReport(buildDocumentScene(document));
    expect(report.slides[0]!.layout.overlappingPairs).toContainEqual([first.id, second.id]);
    expect(report.totals.overlaps).toBeGreaterThan(0);
  });

  it("keeps font fallback evidence attributable through the digest", () => {
    const document = loadFixture("technical");
    const report = buildCriticReport(
      buildDocumentScene(document, { fonts: { available: new Set(["Arial"]), unknown: false } }),
    );

    expect(report.fontDigest).toContain("->");
    expect(report.totals.missingFonts).toBeGreaterThan(0);
  });
});
