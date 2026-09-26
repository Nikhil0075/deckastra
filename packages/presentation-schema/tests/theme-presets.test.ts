import { describe, expect, it } from "vitest";

import { ThemeDefinitionSchema, THEME_PRESETS, findPreset, IdSchema, CommonStyleSchema, BackgroundDefinitionSchema } from "../src/index";

describe("the theme gallery", () => {
  it("has the looks people ask for by name", () => {
    const names = THEME_PRESETS.map((preset) => preset.key);
    for (const key of ["flat", "neumorphism", "glassmorphism", "neo-brutalism", "bento", "skeuomorphic", "neo-technical"]) {
      expect(names).toContain(key);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(THEME_PRESETS.map((preset) => preset.theme.id)).size).toBe(names.length);
  });

  it("every preset is a valid theme with a valid id, and its style kit is valid style", () => {
    for (const preset of THEME_PRESETS) {
      const parsed = ThemeDefinitionSchema.safeParse(preset.theme);
      expect(parsed.success, `${preset.key}: ${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`).toBe(true);
      expect(IdSchema.safeParse(preset.theme.id).success, preset.key).toBe(true);
      expect(CommonStyleSchema.partial().safeParse(preset.kit.card).success, preset.key).toBe(true);
      if (preset.kit.background) expect(BackgroundDefinitionSchema.safeParse(preset.kit.background).success, preset.key).toBe(true);
    }
  });

  it("finds a preset by key", () => {
    expect(findPreset("glassmorphism")?.kit.card.backdropFilters?.[0]).toEqual({ type: "blur", radius: 18 });
    expect(findPreset("nothing")).toBeUndefined();
  });
});
