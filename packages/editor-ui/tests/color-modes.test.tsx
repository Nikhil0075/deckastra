import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { PresentationDocumentSchema, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";

import {
  addModeOperations,
  generateOppositeMode,
  modeColor,
  removeModeOperations,
  setModeColorOperations,
  slideModeOperations,
  standardRolesOperations,
  wouldLoop,
} from "../src/lib/color-modes";
import { contrastBetween, resolveColorValue, setNamedColorOperations } from "../src/lib/colors";

/** Colour modes and colour roles (design review, 2026-09-27). */

const technical = () => structuredClone(loadFixture("technical")) as PresentationDocument;

function run(document: PresentationDocument, operations: PatchOperation[]) {
  expect(operations.length).toBeGreaterThan(0);
  const result = applyPatch(document, operations);
  const parsed = PresentationDocumentSchema.safeParse(result.document);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([]);
  expect(applyPatch(result.document, result.inverse).document).toEqual(document);
  return result.document;
}

it("generates the opposite appearance with readable text on its surfaces and on its accent", () => {
  const document = technical();
  expect(document.theme.mode).toBe("dark");
  const light = generateOppositeMode(document);
  expect(light.appearance).toBe("light");
  const colors = light.colors as Record<string, string>;
  expect(contrastBetween(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
  const accent = resolveColorValue(document, "token:colors.accent")!;
  expect(contrastBetween(colors.accentForeground, accent)).toBeGreaterThanOrEqual(3);
});

it("adds a mode, puts one slide in it, and the canvas draws that slide in the mode's colours", () => {
  let document = technical();
  document = run(document, addModeOperations(document, "Light", generateOppositeMode(document)));
  const target = document.slides[1]!;
  document = run(document, slideModeOperations(document, [target.id], "Light"));
  delete document.slides[1]!.background;
  delete document.slides[0]!.background;
  const scene = buildDocumentScene(document);
  expect(scene.slides[1]!.background?.color).toBe(modeColor(document, "Light", "background"));
  expect(scene.slides[0]!.background?.color).toBe(document.theme.colors.background);
});

it("edits a colour in one mode only, and puts it back to the theme's", () => {
  let document = technical();
  document = run(document, addModeOperations(document, "Light", generateOppositeMode(document)));
  document = run(document, setModeColorOperations(document, "Light", "accent", "#D2001E"));
  expect(modeColor(document, "Light", "accent")).toBe("#D2001E");
  expect(resolveColorValue(document, "token:colors.accent")).not.toBe("#D2001E");
  document = run(document, setModeColorOperations(document, "Light", "accent", undefined));
  expect(modeColor(document, "Light", "accent")).toBe(resolveColorValue(document, "token:colors.accent"));
});

it("deleting a mode puts its slides back on the theme's colours in the same patch", () => {
  let document = technical();
  document = run(document, addModeOperations(document, "Light", generateOppositeMode(document)));
  document = run(document, slideModeOperations(document, document.slides.map((slide) => slide.id), "Light"));
  document = run(document, removeModeOperations(document, "Light"));
  expect(document.theme.modes).toBeUndefined();
  expect(document.slides.every((slide) => slide.colorMode === undefined)).toBe(true);
});

it("adds roles that follow the theme's colours, which follow a change and a mode", () => {
  let document = technical();
  document = run(document, standardRolesOperations(document));
  const custom = (document.theme.colors as { custom?: Record<string, string> }).custom!;
  expect(custom.Primary).toBe("token:colors.accent");
  expect(resolveColorValue(document, "token:colors.custom.Primary")).toBe(resolveColorValue(document, "token:colors.accent"));
  expect(standardRolesOperations(document)).toEqual([]);

  // A role on a slide follows the mode the slide is in.
  document = run(document, addModeOperations(document, "Light", generateOppositeMode(document)));
  document = run(document, setModeColorOperations(document, "Light", "accent", "#D2001E"));
  const title = document.slides[0]!.elements.find((element) => element.type === "text")!;
  (title as { typography: { color?: string } }).typography.color = "token:colors.custom.Primary";
  document.slides[0]!.colorMode = "Light";
  const node = buildDocumentScene(document).slides[0]!.nodes.find((candidate) => candidate.id === title.id)!;
  expect((node.renderPayload as { typography: { color?: string } }).typography.color).toBe("#D2001E");
});

it("refuses a role that would follow itself round a loop", () => {
  let document = technical();
  document = run(document, standardRolesOperations(document));
  document = run(document, setNamedColorOperations(document, "Surface", "token:colors.custom.Primary"));
  expect(wouldLoop(document, "Primary", "token:colors.custom.Surface")).toBe(true);
  expect(wouldLoop(document, "Primary", "token:colors.background")).toBe(false);
});
