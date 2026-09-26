import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import { MultiSection } from "../src/components/inspector/MultiSection";
import { matchSize, setForAll, sharedValue } from "../src/lib/multi-edit";

/** Formatting several objects at once (design review, 2026-09-27). */

afterEach(cleanup);

let seq = 0;
const id = (prefix = "el") => `${prefix}_01JB8Z9K2QW4RN7F3X7${String(++seq).padStart(7, "0")}`;

const shape = (fill: string, width = 200): PresentationElement =>
  ({ id: id(), type: "shape", shape: "rectangle", transform: { x: 100 * seq, y: 100, width, height: 120 }, style: { fill: { type: "solid", color: fill } } }) as unknown as PresentationElement;
const text = (color?: string): PresentationElement =>
  ({
    id: id(),
    type: "text",
    transform: { x: 100, y: 400, width: 300, height: 60 },
    content: { version: 1, blocks: [{ id: id("blk"), type: "paragraph", spans: [{ text: "Label" }] }] },
    ...(color ? { typography: { color } } : {}),
  }) as unknown as PresentationElement;

function deck(elements: PresentationElement[]): PresentationDocument {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  document.slides = [{ ...document.slides[0]!, elements }];
  return document;
}

it("says whether the selection agrees on a value", () => {
  const a = shape("#FF0000");
  const b = shape("#FF0000");
  const c = shape("#00FF00");
  const read = (e: PresentationElement) => (e.style?.fill as { color?: string }).color;
  expect(sharedValue([a, b], read)).toMatchObject({ value: "#FF0000", mixed: false });
  expect(sharedValue([a, b, c], read)).toMatchObject({ value: undefined, mixed: true });
});

it("writes one property on every object in one valid patch, and one undo takes it all back", () => {
  const elements = [shape("#FF0000"), shape("#00FF00"), shape("#0000FF")];
  const document = deck(elements);
  const operations = setForAll(document, elements, "style.cornerRadius", 16);
  const applied = applyPatch(document, operations);
  expect(applied.document.slides[0]!.elements.map((e) => e.style?.cornerRadius)).toEqual([16, 16, 16]);
  const undone = applyPatch(applied.document, applied.inverse).document;
  expect(undone).toEqual(document);
});

it("makes every object as wide as the first one selected", () => {
  const elements = [shape("#FF0000", 320), shape("#00FF00", 200), shape("#0000FF", 150)];
  const document = deck(elements);
  const after = applyPatch(document, matchSize(document, elements, "width")).document;
  expect(after.slides[0]!.elements.map((e) => e.transform.width)).toEqual([320, 320, 320]);
});

it("shows Mixed where the selection differs, and applies a choice to all of them as one edit", () => {
  const elements = [shape("#FF0000"), shape("#00FF00"), text("#111111")];
  const document = deck(elements);
  const edit = vi.fn<(operations: PatchOperation[], label: string) => void>();
  render(<MultiSection document={document} elements={elements} edit={edit} />);

  expect(screen.getByRole("button", { name: "Fill: Mixed" })).toBeTruthy();
  // The fill control says it only reaches the shapes.
  expect(screen.getByText("Changes 2 of the 3 selected objects.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Fill: Mixed" }));
  fireEvent.click(screen.getAllByRole("option").find((o) => o.getAttribute("aria-label") !== "None")!);
  expect(edit).toHaveBeenCalledTimes(1);
  const [operations, label] = edit.mock.calls[0]!;
  expect(label).toBe("Change fill of 2 objects");
  const after = applyPatch(document, operations).document;
  const fills = after.slides[0]!.elements.slice(0, 2).map((e) => JSON.stringify(e.style?.fill));
  expect(fills[0]).toBe(fills[1]);
});

it("commits a typed size to every text box even when it matches one of them", () => {
  const a = { ...text(), typography: { fontSize: 24 } } as PresentationElement;
  const b = { ...text(), typography: { fontSize: 40 } } as PresentationElement;
  const document = deck([a, b]);
  const edit = vi.fn<(operations: PatchOperation[], label: string) => void>();
  render(<MultiSection document={document} elements={[a, b]} edit={edit} />);
  const size = screen.getByLabelText("Font size") as HTMLInputElement;
  expect(size.placeholder).toBe("Mixed");
  fireEvent.change(size, { target: { value: "24" } });
  fireEvent.keyDown(size, { key: "Enter" });
  const after = applyPatch(document, edit.mock.calls[0]![0]).document;
  expect(after.slides[0]!.elements.map((e) => (e as { typography?: { fontSize?: number } }).typography?.fontSize)).toEqual([24, 24]);
});
