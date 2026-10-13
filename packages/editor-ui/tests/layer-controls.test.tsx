/**
 * Layer controls (image-led visual systems, item 3, 2026-10-13).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { applyPatch } from "@deckastra/transactions";
import { newId, validateDocument, type PatchOperation, type PresentationDocument, type PresentationElement, type TextElement } from "@deckastra/presentation-schema";

import { reorderOperations } from "../src/lib/reorder";
import { layerRows, lockOperations, visibilityOperations } from "../src/lib/layers";
import { deckPictures, pictureFillOperations, pictureFillWithAsset } from "../src/lib/picture-fill";
import { LayersList } from "../src/components/inspector/LayersList";
import type { EditorApi } from "../src/lib/useEditor";

afterEach(cleanup);

const box = (x = 100) => ({ x, y: 100, width: 200, height: 100, rotation: 0 });
const rect = (name: string, extra: Record<string, unknown> = {}) =>
  ({ id: newId("el"), type: "shape", shape: "rectangle", name, transform: box(), ...extra }) as unknown as PresentationElement;

function deckWith(elements: PresentationElement[]): PresentationDocument {
  const document = structuredClone(loadFixture("technical"));
  document.slides[0]!.elements = elements;
  return document;
}

const ids = (document: PresentationDocument) => document.slides[0]!.elements.map((element) => element.name);

describe("reordering", () => {
  it("moves within the slide", () => {
    const [a, b, c] = [rect("a"), rect("b"), rect("c")];
    const document = deckWith([a, b, c]);
    expect(ids(applyPatch(document, reorderOperations(document, a.id, "forward")).document)).toEqual(["b", "a", "c"]);
    expect(ids(applyPatch(document, reorderOperations(document, a.id, "front")).document)).toEqual(["b", "c", "a"]);
    expect(ids(applyPatch(document, reorderOperations(document, c.id, "back")).document)).toEqual(["c", "a", "b"]);
    expect(reorderOperations(document, c.id, "forward")).toEqual([]);
  });

  it("keeps an object inside its group", () => {
    // It used to call moveElement without the group, which lifts the object
    // out of its group onto the slide.
    const [inner1, inner2] = [rect("inner 1"), rect("inner 2")];
    const group = { id: newId("el"), type: "group", name: "group", transform: box(), children: [inner1, inner2] } as unknown as PresentationElement;
    const document = deckWith([rect("outside"), group]);
    const after = applyPatch(document, reorderOperations(document, inner1.id, "front")).document;
    expect(validateDocument(after).errors).toEqual([]);
    expect(after.slides[0]!.elements).toHaveLength(2);
    const children = (after.slides[0]!.elements[1] as { children: PresentationElement[] }).children;
    expect(children.map((child) => child.name)).toEqual(["inner 2", "inner 1"]);
  });
});

describe("the layer rows", () => {
  it("run front to back, with a group's children after it", () => {
    const [inner1, inner2] = [rect("inner 1"), rect("inner 2")];
    const group = { id: newId("el"), type: "group", name: "group", transform: box(), children: [inner1, inner2] } as unknown as PresentationElement;
    const rows = layerRows([rect("back"), group, rect("front")]);
    expect(rows.map((row) => [row.element.name, row.depth])).toEqual([
      ["front", 0],
      ["group", 0],
      ["inner 2", 1],
      ["inner 1", 1],
      ["back", 0],
    ]);
  });

  it("locks, unlocks, hides and shows without leaving a default behind", () => {
    const shape = rect("a");
    const document = deckWith([shape]);
    const locked = applyPatch(document, lockOperations(document, shape.id, true)).document;
    expect(locked.slides[0]!.elements[0]!.locked).toBe(true);
    const unlocked = applyPatch(locked, lockOperations(locked, shape.id, false)).document;
    expect("locked" in unlocked.slides[0]!.elements[0]!).toBe(false);
    const hidden = applyPatch(document, visibilityOperations(document, shape.id, false)).document;
    expect(hidden.slides[0]!.elements[0]!.visible).toBe(false);
    const shown = applyPatch(hidden, visibilityOperations(hidden, shape.id, true)).document;
    expect("visible" in shown.slides[0]!.elements[0]!).toBe(false);
  });
});

describe("the Layers panel", () => {
  function mount(document: PresentationDocument) {
    const applied: { operations: PatchOperation[]; label?: string }[] = [];
    let selected: string[] = [];
    const editor = {
      document,
      slideIndex: 0,
      selection: { selectedIds: [], primaryId: undefined },
      setSelection: (update: (current: { selectedIds: string[] }) => { selectedIds: string[] }) => {
        selected = update({ selectedIds: [] }).selectedIds;
      },
      apply: (operations: PatchOperation[], options?: { label?: string }) => applied.push({ operations, label: options?.label }),
    } as unknown as EditorApi;
    render(<LayersList editor={editor} />);
    return { applied, selected: () => selected };
  }

  it("lists front to back, shows depth, ends at the slide background, and selects a covered object", () => {
    const back = rect("Background photograph", { layerRole: "background" });
    const front = rect("Headline", { layerRole: "content" });
    const panel = mount(deckWith([back, front]));
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Headline");
    expect(rows[0]!.textContent).toContain("Content");
    expect(rows[1]!.textContent).toContain("Background photograph");
    expect(rows[2]!.textContent).toContain("Slide background");
    fireEvent.click(rows[1]!.querySelector(`[data-layer-id="${back.id}"]`)!);
    expect(panel.selected()).toEqual([back.id]);
  });

  it("locks and hides from the row, one change each", () => {
    const shape = rect("Ring");
    const panel = mount(deckWith([shape]));
    fireEvent.click(screen.getByRole("button", { name: "Lock Ring" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Ring" }));
    expect(panel.applied.map((one) => one.label)).toEqual(["Lock", "Hide"]);
    expect(panel.applied[0]!.operations).toHaveLength(1);
  });
});

describe("picture-filled text", () => {
  it("fills, keeps placement when the picture changes, and clears", () => {
    const document = structuredClone(loadFixture("technical"));
    const text = document.slides[0]!.elements.find((element) => element.type === "text") as TextElement;
    const [picture] = deckPictures(document);
    expect(picture).toBeDefined();

    const filled = applyPatch(document, pictureFillOperations(document, text.id, pictureFillWithAsset(undefined, picture!.id, "#112233"))).document;
    expect(validateDocument(filled).errors).toEqual([]);
    const fill = (filled.slides[0]!.elements.find((element) => element.id === text.id) as TextElement).pictureFill!;
    expect(fill).toEqual({ fit: "cover", assetId: picture!.id, fallbackColor: "#112233" });

    const moved = { ...fill, focalPoint: { x: 0.2, y: 0.8 } };
    expect(pictureFillWithAsset(moved, "ast_other")).toEqual({ ...moved, assetId: "ast_other" });

    const cleared = applyPatch(filled, pictureFillOperations(filled, text.id, pictureFillWithAsset(fill, undefined))).document;
    expect("pictureFill" in cleared.slides[0]!.elements.find((element) => element.id === text.id)!).toBe(false);
  });
});
