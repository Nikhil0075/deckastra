import { describe, expect, it } from "vitest";

import {
  DECK_PRESETS,
  MOTION_STYLES,
  PATTERN_DEFINITIONS,
  PURPOSE_GROUPS,
  SLIDE_PATTERNS,
  renderContactSheet,
  runNegativeControls,
  validateDeckPresets,
} from "../src/index";

const themeKeys = new Set(DECK_PRESETS.map((preset) => preset.themeKey));

describe("preset quality gate", () => {
  it("meets the reviewed launch catalog targets", () => {
    expect(SLIDE_PATTERNS).toHaveLength(60);
    expect(Object.keys(MOTION_STYLES)).toHaveLength(7);
    expect(MOTION_STYLES.playful.entrance).toBe("wordCascade");
    expect(DECK_PRESETS).toHaveLength(24);
    expect(DECK_PRESETS.every((preset) => preset.reviewed)).toBe(true);
    for (const purpose of PURPOSE_GROUPS) {
      expect(DECK_PRESETS.filter((preset) => preset.purpose === purpose), purpose).toHaveLength(4);
    }
  });

  it("accepts the reviewed catalog", () => {
    expect(validateDeckPresets(DECK_PRESETS, { themeKeys })).toEqual([]);
  });

  it("has a named slot schema and example for every pattern", () => {
    expect(Object.keys(PATTERN_DEFINITIONS)).toEqual(SLIDE_PATTERNS);
    for (const pattern of SLIDE_PATTERNS) {
      const definition = PATTERN_DEFINITIONS[pattern];
      expect(definition.slots.headline?.required).toBe(true);
      expect(definition.exampleSlots.headline).toBeTruthy();
    }
  });

  it("detects every deliberate broken-preset control", () => {
    const controls = runNegativeControls(DECK_PRESETS, themeKeys);
    expect(controls.length).toBeGreaterThanOrEqual(10);
    for (const control of controls) {
      expect(control.actual, control.name).toContain(control.expected);
    }
  });

  it("renders every pattern in each review theme and escapes content", () => {
    const themes = [
      { key: "light", name: "Light & <clear>", colors: { background: "#fff", foreground: "#111", accent: "#06c", surface: "#eee", border: "#bbb" } },
      { key: "dark", name: "Dark", colors: { background: "#111", foreground: "#fff", accent: "#8bf", surface: "#222", border: "#555" } },
      { key: "warm", name: "Warm", colors: { background: "#fff8ef", foreground: "#321", accent: "#c40", surface: "#fff", border: "#dba" } },
    ];
    const html = renderContactSheet(themes);
    expect(html.match(/<figure /g)).toHaveLength(SLIDE_PATTERNS.length * themes.length);
    expect(html).toContain("Light &amp; &lt;clear&gt;");
    expect(html).not.toContain("Light & <clear>");
  });
});
