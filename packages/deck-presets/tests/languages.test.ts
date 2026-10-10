import { describe, expect, it } from "vitest";

import {
  DECK_PRESETS,
  DESIGN_LANGUAGES,
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

  it("keeps the neutral templates exactly as they were", () => {
    const neutral = DECK_PRESETS.filter((preset) => preset.designLanguage === "neutral");
    expect(neutral).toHaveLength(24);
    expect(neutral.find((preset) => preset.id === "business-pitch")).toMatchObject({ themeKey: "quiet-luxury", motionStyle: "restrained" });
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
