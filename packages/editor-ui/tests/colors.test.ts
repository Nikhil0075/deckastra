import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import {
  addNamedColorOperations,
  contrastBetween,
  contrastVerdict,
  deckColors,
  deleteNamedColorOperations,
  namedColorProblem,
  namedColors,
  normaliseColor,
  promoteColorOperations,
  renameNamedColorOperations,
  replaceColorOperations,
  setChartSeriesOperations,
  setThemeColorOperations,
  tokenUseCount,
} from "../src/lib/colors";

/**
 * The colour model (colour wizard, 2026-09-26), applied through the real
 * applier and checked with the real validator: a rename or a delete that left a
 * reference behind is an E202, and a deck that silently draws the fallback.
 */

function deck(): PresentationDocument {
  const document = structuredClone(loadFixture("technical"));
  // Two loose uses of one colour, spelled two ways, on two slides.
  const first = document.slides[0]!.elements.find((element) => element.type === "text") as { typography: { color?: string } };
  first.typography.color = "#1e4bd2";
  const shape = document.slides[1]!.elements[0] as { style?: Record<string, unknown> };
  shape.style = { ...(shape.style ?? {}), fill: { type: "solid", color: "#1E4BD2" } };
  return document;
}

const apply = (document: PresentationDocument, operations: Parameters<typeof applyPatch>[1]) => applyPatch(document, operations).document;
const errors = (document: PresentationDocument) => validateDocument(document).errors;

describe("the colour model", () => {
  it("finds loose colours on the slides, counting every spelling as one", () => {
    const found = deckColors(deck()).find((color) => color.value === "#1E4BD2");
    expect(found?.count).toBe(2);
    expect(normaliseColor("#abc")).toBe("#AABBCC");
    expect(normaliseColor("#112233ff")).toBe("#112233");
  });

  it("names a loose colour, and every use of it becomes a reference, in one patch", () => {
    const before = deck();
    const after = apply(before, promoteColorOperations(before, "#1e4bd2", "Brand blue"));
    expect(namedColors(after)).toEqual([{ name: "Brand blue", value: "#1E4BD2", token: "token:colors.custom.Brand blue" }]);
    expect(deckColors(after).some((color) => color.value === "#1E4BD2")).toBe(false);
    expect(tokenUseCount(after, "token:colors.custom.Brand blue")).toBe(2);
    expect(errors(after)).toEqual([]);
  });

  it("renames a colour and rewrites every reference, so nothing points at the old name", () => {
    const named = apply(deck(), promoteColorOperations(deck(), "#1E4BD2", "Brand blue"));
    // A theme role can point at a named colour too; the rename must reach it.
    const pointed = apply(named, setThemeColorOperations(named, "accent", "token:colors.custom.Brand blue"));
    const renamed = apply(pointed, renameNamedColorOperations(pointed, "Brand blue", "Ocean"));
    expect(namedColors(renamed).map((color) => color.name)).toEqual(["Ocean"]);
    expect(tokenUseCount(renamed, "token:colors.custom.Ocean")).toBe(3);
    expect(JSON.stringify(renamed)).not.toContain("Brand blue");
    expect(errors(renamed)).toEqual([]);
  });

  it("deletes a colour by giving its uses the colour it was, so nothing changes appearance", () => {
    const named = apply(deck(), promoteColorOperations(deck(), "#1E4BD2", "Brand blue"));
    const deleted = apply(named, deleteNamedColorOperations(named, "Brand blue"));
    expect(namedColors(deleted)).toEqual([]);
    expect(deckColors(deleted).find((color) => color.value === "#1E4BD2")?.count).toBe(2);
    expect(errors(deleted)).toEqual([]);
  });

  it("replaces a loose colour everywhere, and leaves words that merely look like one alone", () => {
    const before = deck();
    const text = before.slides[0]!.elements.find((element) => element.type === "text") as { content: { blocks: { spans: { text: string }[] }[] } };
    text.content.blocks[0]!.spans[0]!.text = "#1E4BD2";
    const after = apply(before, replaceColorOperations(before, "#1E4BD2", "token:colors.accent"));
    expect(deckColors(after).some((color) => color.value === "#1E4BD2")).toBe(false);
    const again = after.slides[0]!.elements.find((element) => element.type === "text") as typeof text;
    expect(again.content.blocks[0]!.spans[0]!.text).toBe("#1E4BD2");
  });

  it("adds the first named colour by creating the slot, and refuses names that would break a token", () => {
    const before = deck();
    const made = addNamedColorOperations(before, "Signal", "#FF3300");
    expect(made.operations).toEqual([{ op: "add", path: "/theme/colors/custom", value: { Signal: "#FF3300" } }]);
    const after = apply(before, made.operations);
    expect(namedColorProblem(after, "signal")).toMatch(/already/);
    expect(namedColorProblem(after, "a.b")).toMatch(/letters/);
    expect(namedColorProblem(after, "  ")).toMatch(/name/);
    expect(() => addNamedColorOperations(after, "Signal", "#000000")).toThrow(/already/);
  });

  it("keeps the theme's required roles and the chart palette's minimum", () => {
    const document = deck();
    expect(setThemeColorOperations(document, "accent", undefined)).toEqual([]);
    expect(() => setChartSeriesOperations(document, ["#000", "#111"])).toThrow(/six/);
  });

  it("reads contrast as WCAG does", () => {
    expect(contrastBetween("#000000", "#FFFFFF")).toBe(21);
    expect(contrastVerdict(contrastBetween("#767676", "#FFFFFF"))).toBe("AA");
    expect(contrastVerdict(contrastBetween("#999999", "#FFFFFF"))).toBe("Low");
  });
});
