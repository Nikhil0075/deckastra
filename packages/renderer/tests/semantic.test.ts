import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { REQUIRES_RENDER_CONTEXT, RULES } from "@deckastra/presentation-schema";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene } from "../src/scene";
import {
  checkBrandRules,
  checkContrastPairs,
  contrastRatio,
  parseColor,
  validateScene,
} from "../src/semantic";
import { resolveTheme } from "../src/theme";

const technical = loadFixture("technical");

function withTheme(mutate: (theme: PresentationDocument["theme"]) => void): PresentationDocument {
  const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
  mutate(doc.theme);
  return doc;
}

describe("colour measurement", () => {
  it("measures the forms the renderer actually emits", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#0b0f14")).toEqual({ r: 11, g: 15, b: 20 });
    expect(parseColor("rgba(20, 30, 40, 0.5)")).toEqual({ r: 20, g: 30, b: 40 });
  });

  it("returns nothing rather than guessing at a gradient or a named colour", () => {
    // A contrast failure reported against a colour nobody measured is worse than
    // no report at all.
    expect(parseColor("linear-gradient(180deg, #000, #fff)")).toBeUndefined();
    expect(parseColor("rebeccapurple")).toBeUndefined();
    expect(parseColor(undefined)).toBeUndefined();
  });

  it("computes WCAG contrast to the published anchors", () => {
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 })).toBe(21);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 })).toBe(1);
  });
});

describe("contrast pairs", () => {
  it("passes a theme whose declared pairs meet their minimum", () => {
    const theme = resolveTheme(technical.theme);
    expect(checkContrastPairs(theme)).toEqual([]);
  });

  it("reports the pair, the measured ratio and the required one", () => {
    const doc = withTheme((theme) => {
      theme.colors.foregroundMuted = "#3a3f46";
      theme.contrastPairs = [
        { foreground: "colors.foregroundMuted", background: "colors.background", minimumRatio: 4.5 },
      ];
    });

    const issues = checkContrastPairs(resolveTheme(doc.theme));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("W210");
    expect(issues[0]!.message).toMatch(/is \d+(\.\d+)?:1, below the theme's required 4\.5:1/);
    // Mechanically fixable rules must say how to fix them (doc 02 §42.6).
    expect(issues[0]!.suggestedFix).toBeTruthy();
  });

  it("says a pair could not be measured rather than passing it silently", () => {
    const doc = withTheme((theme) => {
      theme.contrastPairs = [
        { foreground: "colors.nope", background: "colors.background", minimumRatio: 4.5 },
      ];
    });
    expect(checkContrastPairs(resolveTheme(doc.theme))[0]!.message).toContain("could not be measured");
  });
});

describe("brand rules", () => {
  const scene = buildDocumentScene(technical);

  it("ignores a rule with no check", () => {
    // A prose rule is prompt context for the Creative Director. Inventing an
    // interpretation of it here would produce confident nonsense.
    const issues = checkBrandRules(
      scene.slides[0]!,
      [{ id: "r1", kind: "must", scope: "typography", statement: "Keep it calm." }],
      technical.theme,
    );
    expect(issues).toEqual([]);
  });

  it("counts the font sizes a slide actually renders at", () => {
    const issues = checkBrandRules(
      scene.slides[0]!,
      [
        {
          id: "r2",
          kind: "must",
          scope: "typography",
          statement: "At most two sizes per slide.",
          check: { type: "maxFontSizesPerSlide", value: 2 },
        },
      ],
      technical.theme,
    );
    expect(issues[0]?.code).toBe("W211");
    expect(issues[0]?.message).toContain("font sizes");
  });

  it("flags a family outside the allowed set and names the replacement", () => {
    const issues = checkBrandRules(
      scene.slides[0]!,
      [
        {
          id: "r3",
          kind: "must",
          scope: "typography",
          statement: "Only Comic Sans.",
          check: { type: "allowedFontFamilies", value: ["Comic Sans MS"] },
        },
      ],
      technical.theme,
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.code).toBe("W212");
    expect(issues[0]!.suggestedFix).toContain("Comic Sans MS");
    // The scene carries a full stack; the report must name the requested family.
    expect(issues[0]!.message).not.toContain(",");
  });

  it("reports a missing required role", () => {
    const issues = checkBrandRules(
      scene.slides[0]!,
      [
        {
          id: "r4",
          kind: "must",
          scope: "layout",
          statement: "Every slide carries a footer.",
          check: { type: "requiredElements", value: ["footer"] },
        },
      ],
      technical.theme,
    );
    expect(issues[0]!.code).toBe("W214");
    expect(issues[0]!.message).toContain("footer");
  });

  it("downgrades a should-rule to info", () => {
    const issues = checkBrandRules(
      scene.slides[0]!,
      [
        {
          id: "r5",
          kind: "should",
          scope: "content",
          statement: "Keep slides light.",
          check: { type: "maxTextDensity", value: 1 },
        },
      ],
      technical.theme,
    );
    expect(issues[0]!.severity).toBe("info");
  });
});

describe("the render pass", () => {
  it("only emits codes the shared catalog declares", () => {
    // The editor, the Critic and an export report all reference these codes; a
    // code invented in the renderer cannot be referenced by any of them.
    const doc = withTheme((theme) => {
      theme.brandRules = [
        {
          id: "r6",
          kind: "must",
          scope: "typography",
          statement: "One size only.",
          check: { type: "maxFontSizesPerSlide", value: 1 },
        },
        {
          id: "r7",
          kind: "must",
          scope: "layout",
          statement: "Footer required.",
          check: { type: "requiredElements", value: ["footer"] },
        },
      ];
    });

    const issues = validateScene(buildDocumentScene(doc));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(RULES[issue.code]).toBeDefined();
  });

  it("owns every rule the catalog marks as needing a render", () => {
    // If a code is declared render-context but nothing here can produce it, the
    // catalog is lying about what gets checked.
    const implemented = new Set(["W102", "W103", "W104", "W110", "W111", "W210", "W211", "W212", "W213", "W214", "W215", "W250"]);
    for (const code of REQUIRES_RENDER_CONTEXT) expect(implemented.has(code)).toBe(true);
  });

  it("reports a font substitution once for the deck, not once per element", () => {
    const issues = validateScene(
      buildDocumentScene(technical, { fonts: { available: new Set(["Arial"]), unknown: false } }),
    );
    const fontIssues = issues.filter((issue) => issue.code === "W250");
    expect(fontIssues.length).toBeGreaterThan(0);
    expect(new Set(fontIssues.map((issue) => issue.message)).size).toBe(fontIssues.length);
    expect(fontIssues[0]!.message).toContain("metrics will differ");
  });

  it("finds nothing to complain about in a clean deck", () => {
    const issues = validateScene(buildDocumentScene(technical, { fonts: { available: new Set(), unknown: true } }));
    // Overflow is the one thing the seed decks can legitimately trip, and it is
    // reported per element rather than for the deck.
    for (const issue of issues) expect(["W103", "W104"]).toContain(issue.code);
  });
});

describe("the theme gallery's contrast", () => {
  it("every preset meets every contrast pair it declares", async () => {
    const { THEME_PRESETS } = await import("@deckastra/presentation-schema");
    for (const preset of THEME_PRESETS) {
      expect(checkContrastPairs(resolveTheme(preset.theme)), preset.key).toEqual([]);
    }
  });
});
