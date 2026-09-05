/**
 * Accessibility (gap register doc 01 S2, WCAG 2.1 AA).
 *
 * Doc 01 §9.5 said "accessible" and named nothing, which is a requirement no
 * build can pass or fail. These are the criteria the gap register's fix puts in
 * scope, checked against the real seed decks — because a rule that only holds
 * for a hand-made fixture is a rule the product does not follow.
 */

import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import {
  CONTRAST_LARGE,
  CONTRAST_NORMAL,
  LARGE_TEXT_PX,
  accessibilityReport,
  checkAccessibility,
} from "../src/accessibility";
import { buildDocumentScene } from "../src/scene";
import type { SceneNode, SlideScene } from "../src/scene";

// ------------------------------------------------------------------ fixtures

function node(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: "el_a",
    type: "text",
    worldTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    localTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    bounds: { x: 0, y: 0, width: 400, height: 100 },
    localBounds: { x: 0, y: 0, width: 400, height: 100 },
    resolvedStyle: { opacity: 1 },
    layer: "content" as SceneNode["layer"],
    zPath: [0],
    renderPayload: { kind: "placeholder", label: "", reason: "" },
    a11y: { role: "text", order: 0 },
    flags: {} as SceneNode["flags"],
    ...overrides,
  };
}

function textNode(overrides: {
  id?: string;
  color?: string;
  fill?: string;
  fontSize?: number;
  fontWeight?: number;
  order?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}): SceneNode {
  return node({
    id: overrides.id ?? "el_text",
    bounds: overrides.bounds ?? { x: 0, y: 0, width: 400, height: 100 },
    resolvedStyle: { opacity: 1, ...(overrides.fill ? { fill: overrides.fill } : {}) },
    a11y: { role: "text", order: overrides.order ?? 0 },
    renderPayload: {
      kind: "text",
      blocks: [],
      metrics: {
        appliedFontSize: overrides.fontSize ?? 18,
        lineCount: 1,
        width: 100,
        height: 20,
        estimated: false,
      } as never,
      typography: {
        color: overrides.color ?? "#FFFFFF",
        fontWeight: overrides.fontWeight ?? 400,
      } as never,
    },
  });
}

function scene(nodes: SceneNode[], background = "#000000"): SlideScene {
  return {
    slideId: "sld_1",
    index: 0,
    width: 1920,
    height: 1080,
    nodes,
    paintOrder: nodes.map((one) => one.id),
    theme: {} as SlideScene["theme"],
    background: { color: background },
    fonts: [],
  };
}

// ------------------------------------------------------------------- 1.1.1

describe("alternative text", () => {
  it("an image with no description is an error", () => {
    // A screen reader announces nothing at all, which is the difference between
    // a slide that is hard to use and one that is missing content.
    const image = node({
      id: "el_img",
      renderPayload: { kind: "image", assetId: "ast_1", objectFit: "cover", objectPosition: "50% 50%" },
      a11y: { role: "img", order: 0 },
    });

    const [issue] = checkAccessibility(scene([image]));
    expect(issue?.code).toBe("A101");
    expect(issue?.severity).toBe("error");
    expect(issue?.criterion).toContain("1.1.1");
  });

  it("an image marked decorative needs none", () => {
    // A legitimate answer, not an escape hatch: describing a background texture
    // makes a screen reader worse, not better.
    const decorative = node({
      id: "el_bg",
      semanticRole: "decoration",
      renderPayload: { kind: "image", assetId: "ast_1", objectFit: "cover", objectPosition: "50% 50%" },
      a11y: { role: "presentation", order: 0 },
    });
    expect(checkAccessibility(scene([decorative]))).toEqual([]);
  });

  it("a chart and a diagram need a description too", () => {
    // The failure this catches: a deck whose only numbers live in a chart, read
    // aloud as nothing at all.
    const chart = node({
      id: "el_chart",
      renderPayload: { kind: "chart" } as never,
      a11y: { role: "img", order: 0 },
    });
    const [issue] = checkAccessibility(scene([chart]));
    expect(issue?.code).toBe("A101");
    // Names the finding, not the shape — "a bar chart" tells a listener nothing.
    expect(issue?.suggestedFix).toContain("the finding");
  });

  it("a described image passes", () => {
    const described = node({
      id: "el_img",
      renderPayload: { kind: "image", assetId: "ast_1", objectFit: "cover", objectPosition: "50% 50%" },
      a11y: { role: "img", order: 0, label: "Latency fell after the migration" },
    });
    expect(checkAccessibility(scene([described]))).toEqual([]);
  });
});

// ------------------------------------------------------------------- 1.4.3

describe("contrast", () => {
  it("fails body text below 4.5:1", () => {
    const faint = textNode({ color: "#555555", fontSize: 18 });
    const [issue] = checkAccessibility(scene([faint]));

    expect(issue?.code).toBe("A102");
    expect(issue?.message).toContain(`${CONTRAST_NORMAL}:1`);
  });

  it("allows 3:1 for large text", () => {
    // WCAG 1.4.3's relaxation, and it matters on slides — a headline at 88px is
    // legible at a ratio a caption would not be.
    const heading = textNode({ color: "#767676", fontSize: LARGE_TEXT_PX + 10 });
    const issues = checkAccessibility(scene([heading]));

    if (issues.length > 0) {
      expect(issues[0]!.message).toContain(`${CONTRAST_LARGE}:1`);
    }
  });

  it("measures against what is actually behind the text, not the theme", () => {
    // The failure this catches: white text on a white card over a dark slide.
    // Checking against the theme's nominal background would pass it.
    const onCard = textNode({ color: "#FFFFFF", fill: "#F5F5F5", fontSize: 18 });
    const [issue] = checkAccessibility(scene([onCard], "#000000"));
    expect(issue?.code).toBe("A102");
  });

  it("passes text that is legible", () => {
    expect(checkAccessibility(scene([textNode({ color: "#FFFFFF" })]))).toEqual([]);
  });
});

// ------------------------------------------------------------------- 1.3.1

describe("reading order", () => {
  it("flags a slide read in a different order from the one it is laid out in", () => {
    // The two audiences get different slides: a caption before its chart, a
    // footnote before the claim it qualifies.
    const lower = textNode({ id: "el_lower", bounds: { x: 0, y: 600, width: 400, height: 80 }, order: 0 });
    const upper = textNode({ id: "el_upper", bounds: { x: 0, y: 100, width: 400, height: 80 }, order: 1 });

    const issues = checkAccessibility(scene([lower, upper]));
    const order = issues.find((issue) => issue.code === "A103");

    expect(order).toBeDefined();
    expect(order?.criterion).toContain("1.3.1");
  });

  it("reads a two-column slide across before down", () => {
    // Elements whose tops are within a line of each other are one row. Without
    // that tolerance every side-by-side layout looks like a violation.
    const left = textNode({ id: "el_left", bounds: { x: 0, y: 100, width: 400, height: 80 }, order: 0 });
    const right = textNode({ id: "el_right", bounds: { x: 900, y: 112, width: 400, height: 80 }, order: 1 });

    expect(checkAccessibility(scene([left, right])).filter((i) => i.code === "A103")).toEqual([]);
  });

  it("says nothing about a slide with one element", () => {
    expect(checkAccessibility(scene([textNode({})])).filter((i) => i.code === "A103")).toEqual([]);
  });
});

// ---------------------------------------------------------------- the decks

describe("the seed decks", () => {
  it("pass every criterion in scope", () => {
    // The decks the whole product is demonstrated with. If they fail, the
    // product's own examples are inaccessible — which is not a rule anyone can
    // be asked to follow.
    for (const name of ["technical", "repository", "animation"] as const) {
      const built = buildDocumentScene(loadFixture(name));
      const report = accessibilityReport(built.slides);

      expect(
        report.errors,
        `${name}: ${report.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.code} ${issue.message}`)
          .join("; ")}`,
      ).toBe(0);
    }
  });

  it("reports warnings and errors separately", () => {
    // A warning competing for attention with an error is a warning that hides
    // one. The counts are separate so a build can gate on errors alone.
    const built = buildDocumentScene(loadFixture("technical"));
    const report = accessibilityReport(built.slides);

    expect(report.errors + report.warnings).toBe(report.issues.length);
    expect(report.passesScopedCriteria).toBe(report.errors === 0);
  });
});
