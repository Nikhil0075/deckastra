import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { PresentationDocumentSchema, isGroup, type PatchOperation, type PresentationDocument, type PresentationElement } from "@deckastra/presentation-schema";
import { buildDocumentScene, type SceneNode } from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";

import {
  distributeWithGapOperations,
  fitOperations,
  removeLayoutOperations,
  repeatAsGridOperations,
  stackOperations,
  updateLayoutOperations,
} from "../src/lib/layout-actions";

/** Stacks, grids and container controls (design review, 2026-09-27). */

let seq = 0;
const id = () => `el_01JB8Z9K2QW4RN7F3X5${String(++seq).padStart(7, "0")}`;
const box = (x: number, y: number, w = 200, h = 120): PresentationElement =>
  ({ id: id(), type: "shape", shape: "rectangle", transform: { x, y, width: w, height: h }, style: { fill: { type: "solid", color: "#1E4BD2" } } }) as unknown as PresentationElement;

function deck(elements: PresentationElement[]): PresentationDocument {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  document.slides = [{ ...document.slides[0]!, elements }];
  return document;
}

function run(document: PresentationDocument, operations: PatchOperation[]) {
  expect(operations.length).toBeGreaterThan(0);
  const result = applyPatch(document, operations);
  const parsed = PresentationDocumentSchema.safeParse(result.document);
  expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
  expect(applyPatch(result.document, result.inverse).document).toEqual(document);
  return result.document;
}

/** Where the canvas draws each object, in slide coordinates. */
function drawn(document: PresentationDocument): Map<string, SceneNode["bounds"]> {
  const out = new Map<string, SceneNode["bounds"]>();
  const visit = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      out.set(node.id, node.bounds);
      if (node.children) visit(node.children);
    }
  };
  visit(buildDocumentScene(document).slides[0]!.nodes);
  return out;
}

it("makes a row in reading order, with exact gaps, sized to hold it", () => {
  const [a, b, c] = [box(700, 300), box(100, 320, 160), box(400, 280, 240)];
  const document = deck([a!, b!, c!]);
  const { operations, groupId } = stackOperations(document, [a!.id, b!.id, c!.id], "horizontal", { gap: 30 });
  const after = run(document, operations);

  const group = after.slides[0]!.elements.find((e) => e.id === groupId)!;
  expect(isGroup(group) && group.children.map((child) => child.id)).toEqual([b!.id, c!.id, a!.id]);
  expect(group.transform.width).toBe(160 + 30 + 240 + 30 + 200);

  const boxes = drawn(after);
  const [first, second, third] = [boxes.get(b!.id)!, boxes.get(c!.id)!, boxes.get(a!.id)!];
  expect(second.x - (first.x + first.width)).toBeCloseTo(30);
  expect(third.x - (second.x + second.width)).toBeCloseTo(30);
  expect(new Set([first.y, second.y, third.y]).size).toBe(1);
});

it("changes a grid's columns and resizes the container", () => {
  const items = [box(100, 100), box(400, 100), box(700, 100), box(100, 400)];
  const document = deck(items);
  const made = stackOperations(document, items.map((e) => e.id), "grid", { gap: 20, columns: 2 });
  let after = run(document, made.operations);
  const group = () => after.slides[0]!.elements.find((e) => e.id === made.groupId)!;
  expect(group().transform.width).toBe(200 * 2 + 20);
  expect(group().transform.height).toBe(120 * 2 + 20);

  after = run(after, updateLayoutOperations(after, made.groupId!, { columns: 4 }));
  expect(group().transform.width).toBe(200 * 4 + 20 * 3);
  expect(group().transform.height).toBe(120);
});

it("removes a layout without moving anything on screen", () => {
  const items = [box(100, 100), box(500, 400), box(900, 200)];
  const document = deck(items);
  const made = stackOperations(document, items.map((e) => e.id), "vertical", { gap: 16, padding: 24 });
  const stacked = run(document, made.operations);
  const before = drawn(stacked);
  const removed = run(stacked, removeLayoutOperations(stacked, made.groupId!));
  const group = removed.slides[0]!.elements.find((e) => e.id === made.groupId)!;
  expect(isGroup(group) && group.containerLayout).toBeFalsy();
  const after = drawn(removed);
  for (const item of items) expect(after.get(item.id)).toEqual(before.get(item.id));
});

it("repeats one card into a grid of copies", () => {
  const card = box(120, 120);
  const document = deck([card]);
  const made = repeatAsGridOperations(document, card.id, 3, 2, 24);
  const after = run(document, made.operations);
  const group = after.slides[0]!.elements.find((e) => e.id === made.groupId)!;
  expect(isGroup(group) && group.children).toHaveLength(6);
  expect(isGroup(group) && group.children[0]!.id).toBe(card.id);
  expect(new Set(isGroup(group) ? group.children.map((c) => c.id) : []).size).toBe(6);
  expect(group.transform.width).toBe(200 * 3 + 24 * 2);
});

it("fits a plain group to what it holds, moving nothing", () => {
  const document = deck([
    {
      id: id(),
      type: "group",
      transform: { x: 100, y: 100, width: 900, height: 700 },
      children: [box(50, 60), box(300, 200)],
    } as unknown as PresentationElement,
  ]);
  const group = document.slides[0]!.elements[0]!;
  const before = drawn(document);
  const after = run(document, fitOperations(document, group.id));
  const fitted = after.slides[0]!.elements[0]!;
  expect(fitted.transform).toMatchObject({ x: 150, y: 160, width: 450, height: 260 });
  const now = drawn(after);
  for (const child of isGroup(group) ? group.children : []) expect(now.get(child.id)).toEqual(before.get(child.id));
});

it("spaces objects with an exact gap in the order they sit", () => {
  const items = [box(100, 100, 100), box(600, 100, 150), box(300, 100, 80)];
  const document = deck(items);
  const after = run(document, distributeWithGapOperations(document, items.map((e) => e.id), "x", 40));
  const xs = after.slides[0]!.elements.map((e) => e.transform.x);
  expect(xs).toEqual([100, 100 + 100 + 40 + 80 + 40, 100 + 100 + 40]);
});
