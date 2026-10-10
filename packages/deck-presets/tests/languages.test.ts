import { describe, expect, it } from "vitest";

import {
  DECK_PRESETS,
  DESIGN_LANGUAGE_IDS,
  DESIGN_LANGUAGES,
  TEMPLATE_LANGUAGE,
  type DesignLanguageId,
  PILOT_SOURCES,
  isDesignLanguage,
  resolvePreset,
  validatePresetSources,
  type PresetSource,
} from "../src/index";

const source = (overrides: Partial<PresetSource> = {}): PresetSource => ({
  id: "probe",
  name: "Probe",
  summary: "A probe.",
  purpose: "business",
  tags: [],
  designLanguage: "swiss-signal",
  slides: [{ pattern: "title", purpose: "Open", eyebrow: "01", headline: "Focus wins" }],
  ...overrides,
});

describe("design languages (UI audit unit 5)", () => {
  it("every template names a language the catalog defines", () => {
    for (const preset of DECK_PRESETS) expect(isDesignLanguage(preset.designLanguage), preset.id).toBe(true);
  });

  it("the pilots are clean: known languages, no redundant override, headlines within the language's limit", () => {
    expect(validatePresetSources(PILOT_SOURCES)).toEqual([]);
    expect(PILOT_SOURCES.map((pilot) => pilot.designLanguage).sort()).toEqual(["cinema-noir", "cinema-noir", "swiss-signal", "swiss-signal"]);
  });

  it("a template's style comes from its language, and an override wins", () => {
    const plain = resolvePreset(source());
    expect(plain.themeKey).toBe(DESIGN_LANGUAGES["swiss-signal"].defaults.themeKey);
    expect(plain.transitionStyle).toBe("cut");
    const changed = resolvePreset(source({ overrides: { motionStyle: "technical" } }));
    expect(changed.motionStyle).toBe("technical");
    expect(changed.themeKey).toBe("swiss-signal");
  });

  it("refuses an override equal to the language default, because it is the copy that drifts", () => {
    const issues = validatePresetSources([source({ overrides: { themeKey: "swiss-signal" } })]);
    expect(issues.map((issue) => issue.code)).toEqual(["E_PRESET_OVERRIDE_REDUNDANT"]);
  });

  it("refuses an unknown language and a headline the language does not allow", () => {
    expect(validatePresetSources([source({ designLanguage: "vaporwave" as never })]).map((issue) => issue.code)).toEqual(["E_PRESET_LANGUAGE"]);
    const long = source({ slides: [{ pattern: "title", purpose: "Open", eyebrow: "01", headline: "Far too many words for a Swiss headline" }] });
    expect(validatePresetSources([long]).map((issue) => issue.code)).toEqual(["E_PRESET_HEADLINE_LONG"]);
  });

  it("puts every original template in a language, three to each (unit 7a)", () => {
    const counts = new Map<string, number>();
    for (const preset of DECK_PRESETS) counts.set(preset.designLanguage, (counts.get(preset.designLanguage) ?? 0) + 1);
    expect(counts.get("neutral") ?? 0).toBe(0);
    for (const id of DESIGN_LANGUAGE_IDS.filter((one) => one !== "neutral")) expect(counts.get(id) ?? 0, id).toBeGreaterThanOrEqual(3);
    expect(Object.keys(TEMPLATE_LANGUAGE)).toHaveLength(24);
  });

  it("takes a template's theme, motion and transition from its language", () => {
    for (const preset of DECK_PRESETS) {
      const defaults = DESIGN_LANGUAGES[preset.designLanguage as DesignLanguageId].defaults;
      if (PILOT_SOURCES.some((pilot) => pilot.id === preset.id)) continue;
      expect([preset.themeKey, preset.motionStyle, preset.transitionStyle], preset.id).toEqual([defaults.themeKey, defaults.motionStyle, defaults.transitionStyle]);
    }
  });

  it("swaps a pattern for the language's rhythm but keeps the slide's key", () => {
    const quarterly = DECK_PRESETS.find((preset) => preset.id === "quarterly-review")!;
    const market = quarterly.slides.find((slide) => slide.key === "market-5")!;
    expect(market.pattern).toBe("big-number");
    // The founding templates keep the sequence they were written with.
    expect(DECK_PRESETS.find((preset) => preset.id === "business-pitch")!.slides.map((slide) => slide.key)[0]).toBe("opening");
  });

  it("keeps every template's headlines within its language's limit", () => {
    for (const preset of DECK_PRESETS) {
      const limit = DESIGN_LANGUAGES[preset.designLanguage as DesignLanguageId].density.maxHeadlineWords;
      for (const slide of preset.slides) {
        const words = String(slide.slots.headline ?? "").trim().split(/\s+/).filter(Boolean).length;
        expect(words, `${preset.id}/${slide.key}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("states its rules and forbidden combinations in words an agent can follow", () => {
    for (const language of Object.values(DESIGN_LANGUAGES)) {
      expect(language.rules.length).toBeGreaterThan(0);
      expect(language.version).toBeGreaterThanOrEqual(1);
    }
    expect(DESIGN_LANGUAGES["swiss-signal"].forbid).toContain("centred text");
    expect(DESIGN_LANGUAGES["cinema-noir"].forbid).toContain("light backgrounds");
  });
});
