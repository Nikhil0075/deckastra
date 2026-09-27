import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";

import { DesignCheckPanel } from "../src/components/DesignCheckPanel";
import { designCheck, fixAllOperations, fixOperations, IGNORE_KEY, safeFixes } from "../src/lib/design-check";

/** Design Check (design review, 2026-09-27): each finding, and its fix, and its undo. */

afterEach(cleanup);

let seq = 0;
const id = (prefix = "el") => `${prefix}_01JB8Z9K2QW4RN7F3X8${String(++seq).padStart(7, "0")}`;

function text(x: number, y: number, w: number, h: number, typography: Record<string, unknown> = {}, words = "Quarterly revenue"): PresentationElement {
  return {
    id: id(),
    type: "text",
    transform: { x, y, width: w, height: h },
    content: { version: 1, blocks: [{ id: id("blk"), type: "paragraph", spans: [{ text: words }] }] },
    typography: { fontSize: 32, color: "#111111", ...typography },
  } as unknown as PresentationElement;
}

function card(x: number, y: number, w: number, h: number, fill: string): PresentationElement {
  return { id: id(), type: "shape", shape: "rectangle", transform: { x, y, width: w, height: h }, style: { fill: { type: "solid", color: fill } } } as unknown as PresentationElement;
}

function deck(elements: PresentationElement[]): PresentationDocument {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides[0]!;
  slide.elements = elements;
  slide.background = { paint: { type: "solid", color: "#FFFFFF" } } as never;
  document.slides = [slide];
  return document;
}

const check = (document: PresentationDocument) => designCheck(document, buildDocumentScene(document));

function fixAndUndo(document: PresentationDocument, code: string) {
  const finding = check(document).find((f) => f.code === code);
  expect(finding?.fix).toBeTruthy();
  const applied = applyPatch(document, fixOperations(document, [finding!.fix!]));
  expect(check(applied.document).filter((f) => f.code === code && f.elementId === finding!.elementId)).toEqual([]);
  const undone = applyPatch(applied.document, applied.inverse).document;
  expect(check(undone).some((f) => f.code === code && f.elementId === finding!.elementId)).toBe(true);
}

it("moves an overlapping object clear, and Undo puts it back", () => {
  fixAndUndo(deck([text(200, 200, 400, 60), text(560, 210, 300, 60)]), "W110");
});

it("brings an object back inside the safe area", () => {
  fixAndUndo(deck([text(40, 200, 400, 60)]), "W104");
});

it("raises small text to the minimum", () => {
  fixAndUndo(deck([text(200, 200, 400, 60, { fontSize: 11 })]), "W216");
});

it("gives dark text on a dark card a colour that reads on it, as a theme reference", () => {
  const document = deck([card(200, 200, 600, 300, "#1E4BD2"), text(240, 240, 300, 60, { color: "#111111", fontSize: 20 })]);
  const finding = check(document).find((f) => f.code === "A102")!;
  const change = finding.fix!.changes[0] as { property: string; value: string };
  expect(change.property).toBe("typography.color");
  fixAndUndo(document, "A102");
});

it("makes a text box tall enough for its words", () => {
  const long = "A sentence long enough that it cannot possibly fit in a box this small at this size, however it wraps.";
  fixAndUndo(deck([text(200, 200, 300, 40, { fontSize: 40 }, long)]), "W103");
});

it("remembers an overlap marked as intended, on the object", () => {
  const document = deck([text(200, 200, 400, 60), text(560, 210, 300, 60)]);
  const finding = check(document).find((f) => f.code === "W110")!;
  const after = applyPatch(document, fixOperations(document, [finding.alternative!])).document;
  expect(check(after).filter((f) => f.code === "W110")).toEqual([]);
  const element = after.slides[0]!.elements.find((e) => e.id === finding.elementId)!;
  expect((element.metadata as Record<string, unknown>)[IGNORE_KEY]).toEqual(["W110"]);
});

it("combines every safe fix on a slide into one valid patch", () => {
  const a = text(200, 200, 400, 60, { fontSize: 11 });
  const document = deck([a, text(560, 210, 300, 60), text(40, 600, 300, 60)]);
  const fixes = safeFixes(check(document));
  expect(fixes.length).toBeGreaterThanOrEqual(3);
  const after = applyPatch(document, fixOperations(document, fixes)).document;
  const left = check(after).filter((f) => ["W110", "W104", "W216"].includes(f.code));
  expect(left).toEqual([]);
});

it("judges contrast again after moving text off the card it was on", () => {
  // Dark text on a blue card, half hanging off it: moving it clear puts it on
  // the white slide, where the colour chosen for the card would be wrong.
  const document = deck([card(200, 200, 400, 200, "#1E4BD2"), text(420, 220, 400, 60, { color: "#111111", fontSize: 20 })]);
  const before = check(document);
  expect(before.map((f) => f.code)).toEqual(expect.arrayContaining(["W110"]));
  const after = applyPatch(document, fixAllOperations(document, before)).document;
  expect(check(after).filter((f) => f.code === "W110" || f.code === "A102")).toEqual([]);
});

it("keeps fixing until three boxes stacked on one spot are all clear", () => {
  const document = deck([text(600, 300, 300, 80), text(600, 300, 300, 80), text(600, 300, 300, 80)]);
  const after = applyPatch(document, fixAllOperations(document, check(document))).document;
  expect(check(after).filter((f) => f.code === "W110")).toEqual([]);
});

it("shrinks an object larger than the safe area to fit inside it", () => {
  fixAndUndo(deck([card(0, 0, 1920, 1080, "#EEEEEE")]), "W104");
});

it("fits a diagram's frame to its boxes", () => {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides.find((s) => s.elements.some((e) => e.type === "diagram"))!;
  const diagram = slide.elements.find((e) => e.type === "diagram")!;
  diagram.transform = { ...diagram.transform, width: diagram.transform.width * 4, height: diagram.transform.height * 4 };
  document.slides = [slide];
  const finding = check(document).find((f) => f.code === "W217" && f.elementId === diagram.id)!;
  expect(finding.fix?.label).toBe("Fit the frame to the diagram");
  const after = applyPatch(document, fixOperations(document, [finding.fix!])).document;
  expect(check(after).filter((f) => f.code === "W217" && f.elementId === diagram.id)).toEqual([]);
});

it("offers a card behind text on a picture, and never adds one by itself", () => {
  const picture = { id: id(), type: "image", transform: { x: 100, y: 100, width: 900, height: 600 }, assetId: "ast_01JB8Z9K2QW4RN7F3X01006800", altText: "A photograph" } as unknown as PresentationElement;
  const words = text(240, 300, 300, 60, { color: "#111111", fontSize: 32 });
  const document = deck([picture, words]);
  const finding = check(document).find((f) => f.code === "W218")!;
  expect(finding.elementId).toBe(words.id);
  expect(safeFixes([finding])).toEqual([]);
  expect(fixAllOperations(document, check(document)).some((op) => op.op === "add")).toBe(false);
  const after = applyPatch(document, fixOperations(document, [finding.fix!])).document;
  const elements = after.slides[0]!.elements;
  expect(elements.map((e) => e.id).indexOf(words.id)).toBe(2);
  expect(check(after).filter((f) => f.code === "W218")).toEqual([]);
});

it("asks for a picture's description and writes it where the picture keeps one", () => {
  const picture = { id: id(), type: "image", transform: { x: 200, y: 200, width: 600, height: 400 }, assetId: "ast_01JB8Z9K2QW4RN7F3X01006800" } as unknown as PresentationElement;
  const document = deck([picture]);
  const onApply = vi.fn();
  render(<DesignCheckPanel document={document} slideId={document.slides[0]!.id} findings={check(document)} apply={onApply} onSelect={() => {}} />);
  fireEvent.click(screen.getByTestId("check-prompt-open"));
  fireEvent.change(screen.getByTestId("check-prompt"), { target: { value: "Revenue doubled in Q3" } });
  fireEvent.click(screen.getByTestId("check-prompt-save"));
  expect(onApply).toHaveBeenCalledTimes(1);
  const operations = onApply.mock.calls[0]![0];
  const after = applyPatch(document, operations).document;
  expect((after.slides[0]!.elements[0] as { altText?: string }).altText).toBe("Revenue doubled in Q3");
});

it("fixes a table's heading colour where the heading keeps it", () => {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides.find((s) => s.elements.some((e) => e.type === "table"))!;
  const table = slide.elements.find((e) => e.type === "table")! as PresentationElement & { tableStyle?: Record<string, unknown> };
  table.tableStyle = { ...(table.tableStyle ?? {}), headerFill: { type: "solid", color: "#F4EFE3" }, headerColor: "#FFFFFF" };
  document.slides = [slide];
  const finding = check(document).find((f) => f.code === "A102" && f.elementId === table.id && f.fix)!;
  expect((finding.fix!.changes[0] as { property: string }).property).toBe("tableStyle.headerColor");
  const after = applyPatch(document, fixOperations(document, [finding.fix!])).document;
  expect(check(after).filter((f) => f.code === "A102" && f.elementId === table.id && (f.fix?.changes[0] as { property?: string } | undefined)?.property === "tableStyle.headerColor")).toEqual([]);
});

it("lists findings, fixes one on press, and goes to the object", () => {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides.find((candidate) => candidate.elements.some((element) => element.type === "diagram"))!;
  const diagram = slide.elements.find((element) => element.type === "diagram")!;
  diagram.name = "Architecture map";
  diagram.metadata = { ...diagram.metadata, altText: "" };
  const findings = check(document);
  const apply = vi.fn();
  const onSelect = vi.fn();
  render(<DesignCheckPanel document={document} slideId={slide.id} findings={findings} apply={apply} onSelect={onSelect} />);

  const item = screen.getByText(/"Architecture map" has no alternative text/).closest("li")!;
  fireEvent.click(within(item).getByText(/no alternative text/));
  expect(onSelect).toHaveBeenCalledWith(slide.id, diagram.id);
  fireEvent.click(within(item).getByRole("button", { name: "It's decoration" }));
  expect(apply).toHaveBeenCalledWith([expect.objectContaining({ path: expect.stringContaining("semanticRole") })], "It's decoration");

  expect(screen.getByLabelText("In PowerPoint").textContent).toMatch(/diagram/);
  fireEvent.click(screen.getByText(/Reading order/));
  expect(screen.getByRole("list", { name: "Current slide reading order" })).toBeTruthy();
});
