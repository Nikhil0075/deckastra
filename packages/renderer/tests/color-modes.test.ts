import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { expect, it } from "vitest";

import { buildDocumentScene, resolveTheme, resolveValue } from "../src/index";

/** Colour roles that alias primitives, and colour modes per slide (design review, 2026-09-27). */

it("follows a colour that names another colour, and falls back on a cycle", () => {
  const theme = structuredClone(loadFixture("technical").theme);
  (theme.colors as Record<string, unknown>).custom = {
    Blue: "#1E4BD2",
    Primary: "token:colors.custom.Blue",
    "On primary": "token:colors.background",
    Loop: "token:colors.custom.Loop",
  };
  const resolved = resolveTheme(theme);
  expect(resolveValue(resolved, "token:colors.custom.Primary")).toBe("#1E4BD2");
  expect(resolveValue(resolved, "token:colors.custom.On primary")).toBe(theme.colors.background);
  expect(resolveValue(resolved, "token:colors.custom.Loop", "#000000")).toBe("#000000");
});

it("draws a slide in its colour mode and the others in the theme's colours", () => {
  const document = structuredClone(loadFixture("technical"));
  (document.theme as { modes?: unknown }).modes = {
    Light: { appearance: "light", colors: { background: "#FAFAF7", foreground: "#111111" } },
  };
  document.slides[1]!.colorMode = "Light";
  delete document.slides[0]!.background;
  delete document.slides[1]!.background;
  const scene = buildDocumentScene(document);
  expect(scene.slides[1]!.background?.color).toBe("#FAFAF7");
  expect(scene.slides[1]!.theme.mode).toBe("light");
  expect(scene.slides[0]!.background?.color).toBe(document.theme.colors.background);
});

it("draws the theme's colours for a mode the theme does not have", () => {
  const document = structuredClone(loadFixture("technical"));
  document.slides[0]!.colorMode = "Nowhere";
  delete document.slides[0]!.background;
  expect(buildDocumentScene(document).slides[0]!.background?.color).toBe(document.theme.colors.background);
});
