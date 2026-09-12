import { describe, expect, it } from "vitest";
import type { PresentationElement } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  altTextProperty,
  auditAccessibility,
  contrastRatio,
  readingOrder,
} from "../src/lib/accessibility";

describe("authoring accessibility audit", () => {
  it("finds a meaningful visual without alt text and ignores decoration", () => {
    const document = structuredClone(loadFixture("technical"));
    const diagram = document.slides.flatMap((slide) => slide.elements)
      .find((element) => element.type === "diagram")!;
    diagram.name = "System architecture";
    diagram.metadata = { ...diagram.metadata, altText: "" };

    let issues = auditAccessibility(document);
    expect(issues).toContainEqual(expect.objectContaining({
      code: "missing-alt-text", elementId: diagram.id, message: expect.stringContaining("System architecture"),
    }));

    diagram.semanticRole = "decoration";
    issues = auditAccessibility(document);
    expect(issues.some((issue) => issue.elementId === diagram.id)).toBe(false);
  });

  it("checks declared theme pairs using WCAG contrast math", () => {
    const document = structuredClone(loadFixture("technical"));
    document.theme.colors.foreground = "#777777";
    document.theme.colors.background = "#777777";
    const issues = auditAccessibility(document);
    expect(issues).toContainEqual(expect.objectContaining({ code: "low-theme-contrast" }));
    expect(contrastRatio(
      { r: 255, g: 255, b: 255, a: 1 },
      { r: 0, g: 0, b: 0, a: 1 },
    )).toBeCloseTo(21, 5);
  });

  it("derives reading order from document order and excludes hidden structure", () => {
    const elements = [
      { id: "el_a", type: "image", transform: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "el_b", type: "line", transform: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "el_c", type: "chart", visible: false, transform: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "el_d", type: "diagram", transform: { x: 0, y: 0, width: 10, height: 10 } },
    ] as PresentationElement[];
    expect(readingOrder(elements).map((element) => element.id)).toEqual(["el_a", "el_d"]);
    expect(altTextProperty(elements[0]!)).toBe("altText");
    expect(altTextProperty(elements[3]!)).toBe("metadata.altText");
  });
});
