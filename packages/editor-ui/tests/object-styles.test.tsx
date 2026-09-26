import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { PresentationDocumentSchema, type PatchOperation, type PresentationDocument, type PresentationElement } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import { StylesSection } from "../src/components/inspector/StylesSection";
import {
  applyStyleOperations,
  deleteStyleOperations,
  detachOperations,
  drifted,
  objectStyles,
  renameStyleOperations,
  saveStyleOperations,
  styleNameProblem,
  updateStyleOperations,
} from "../src/lib/object-styles";

/** Reusable object styles (design review, 2026-09-27). */

afterEach(cleanup);

let seq = 0;
const id = () => `el_01JB8Z9K2QW4RN7F3X6${String(++seq).padStart(7, "0")}`;

const card = (fill: string, extra: Record<string, unknown> = {}): PresentationElement =>
  ({
    id: id(),
    type: "shape",
    shape: "rectangle",
    transform: { x: 100, y: 100, width: 300, height: 200 },
    style: { fill: { type: "solid", color: fill }, cornerRadius: 12, blendMode: "multiply" },
    ...extra,
  }) as unknown as PresentationElement;

function deck(elements: PresentationElement[]): PresentationDocument {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  document.slides = [{ ...document.slides[0]!, elements }];
  return document;
}

const run = (document: PresentationDocument, operations: PatchOperation[]) => {
  const result = applyPatch(document, operations);
  const parsed = PresentationDocumentSchema.safeParse(result.document);
  expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  return result;
};
const find = (document: PresentationDocument, elementId: string) => document.slides[0]!.elements.find((e) => e.id === elementId)!;

it("saves a look as a style, applies it to others, and one undo removes both", () => {
  const source = card("#1E4BD2", { style: { fill: { type: "solid", color: "#1E4BD2" }, cornerRadius: 24, shadow: [{ type: "drop", offsetX: 0, offsetY: 8, blur: 24, spread: 0, color: "#00000033" }] } });
  const other = card("#FF0000");
  const document = deck([source, other]);
  const saved = run(document, saveStyleOperations(document, "Metric card", source, [source, other]));

  expect(objectStyles(saved.document)).toMatchObject([{ name: "Metric card", uses: 2 }]);
  const after = find(saved.document, other.id);
  expect(after.styleRef).toBe("Metric card");
  expect(after.style).toMatchObject({ fill: { color: "#1E4BD2" }, cornerRadius: 24, blendMode: "multiply" });
  expect(after.style?.shadow).toHaveLength(1);

  expect(applyPatch(saved.document, saved.inverse).document).toEqual(document);
});

it("updating a style brings every object that uses it into line, and says who drifted", () => {
  const a = card("#1E4BD2");
  const b = card("#1E4BD2");
  let document = deck([a, b]);
  document = run(document, saveStyleOperations(document, "Card", a, [a, b])).document;
  expect(drifted(document, find(document, a.id))).toBe(false);

  document = run(document, [{ op: "replace", path: `/slides/id:${document.slides[0]!.id}/elements/id:${a.id}/style/fill`, value: { type: "solid", color: "#00A36C" } }]).document;
  expect(drifted(document, find(document, a.id))).toBe(true);
  expect(drifted(document, find(document, b.id))).toBe(false);

  document = run(document, updateStyleOperations(document, "Card", find(document, a.id))).document;
  expect((find(document, b.id).style?.fill as { color: string }).color).toBe("#00A36C");
  expect(drifted(document, find(document, a.id))).toBe(false);
});

it("detach keeps the look; rename and delete rewrite every reference", () => {
  const a = card("#1E4BD2");
  const b = card("#1E4BD2");
  let document = deck([a, b]);
  document = run(document, saveStyleOperations(document, "Card", a, [a, b])).document;

  document = run(document, renameStyleOperations(document, "Card", "Hero card")).document;
  expect(find(document, a.id).styleRef).toBe("Hero card");
  expect(Object.keys(document.theme.objectStyles ?? {})).toEqual(["Hero card"]);

  const detached = run(document, detachOperations(document, [find(document, a.id)])).document;
  expect(find(detached, a.id).styleRef).toBeUndefined();
  expect(find(detached, a.id).style).toEqual(find(document, a.id).style);

  const deleted = run(document, deleteStyleOperations(document, "Hero card")).document;
  expect(deleted.theme.objectStyles).toBeUndefined();
  expect(find(deleted, b.id).styleRef).toBeUndefined();
  expect(find(deleted, b.id).style).toEqual(find(document, b.id).style);
});

it("applies text styles to text, leaving what a style does not own alone", () => {
  const heading = {
    id: id(),
    type: "text",
    transform: { x: 100, y: 100, width: 600, height: 80 },
    content: { version: 1, blocks: [] },
    typography: { fontFamily: "Inter", fontSize: 48, fontWeight: 700, color: "#1E4BD2", textDecoration: "none" },
  } as unknown as PresentationElement;
  const plain = { ...heading, id: id(), typography: { fontFamily: "Lora", fontSize: 20, textDecoration: "underline" } } as PresentationElement;
  let document = deck([heading, plain]);
  document = run(document, saveStyleOperations(document, "Section heading", heading, [heading])).document;
  document = run(document, applyStyleOperations(document, "Section heading", [plain])).document;
  expect((find(document, plain.id) as { typography?: object }).typography).toEqual({ fontFamily: "Inter", fontSize: 48, fontWeight: 700, color: "#1E4BD2", textDecoration: "underline" });
});

it("refuses a name in use or with a full stop", () => {
  const a = card("#1E4BD2");
  let document = deck([a]);
  document = run(document, saveStyleOperations(document, "Card", a, [a])).document;
  expect(styleNameProblem(document, "card")).toMatch(/already/);
  expect(styleNameProblem(document, "v1.2")).toMatch(/full stop/);
  expect(styleNameProblem(document, "Card", "Card")).toBeUndefined();
});

it("saves from the panel with a name, as one edit", () => {
  const a = card("#1E4BD2");
  const document = deck([a]);
  const edit = vi.fn<(operations: PatchOperation[], label: string) => void>();
  render(<StylesSection document={document} elements={[a]} edit={edit} />);
  fireEvent.click(screen.getByRole("button", { name: /Object style/ }));
  fireEvent.click(screen.getByTestId("style-save-open"));
  fireEvent.change(screen.getByLabelText("Style name"), { target: { value: "Metric card" } });
  fireEvent.click(screen.getByTestId("style-save"));
  expect(edit).toHaveBeenCalledTimes(1);
  expect(edit.mock.calls[0]![1]).toBe('Save style "Metric card"');
  const after = applyPatch(document, edit.mock.calls[0]![0]).document;
  expect(find(after, a.id).styleRef).toBe("Metric card");
});
