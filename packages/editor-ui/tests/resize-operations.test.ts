import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId, PresentationDocumentSchema, type GroupElement, type TextElement } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";
import { resizeOperations } from "../src/lib/resize-operations";

it("scales nested text uniformly within a non-uniform group resize and restores the entire patch", () => {
  const document = loadFixture("technical");
  const original = document.slides[0]!.elements.find(element => element.type === "text") as TextElement;
  const text: TextElement = {
    ...original, id: newId("el"),
    transform: { x: 10, y: 12, width: 80, height: 40, rotation: 15 },
    typography: { ...original.typography, fontSize: 20, letterSpacing: 2 },
    minFontSize: 10, maxFontSize: 40,
  };
  const group: GroupElement = {
    id: newId("el"), type: "group", name: "Group",
    transform: { x: 100, y: 200, width: 200, height: 100, rotation: 30 },
    children: [text],
  };
  document.slides[0]!.elements = [group];
  const result = applyPatch(document, resizeOperations(document, group.id, { ...group.transform, width: 400, height: 150 }));
  expect(PresentationDocumentSchema.safeParse(result.document).success).toBe(true);
  const resized = result.document.slides[0]!.elements[0] as GroupElement;
  const child = resized.children[0] as TextElement;
  expect(resized.transform.rotation).toBe(30);
  expect(child.transform).toMatchObject({ x: 20, y: 18, width: 160, height: 60, rotation: 15 });
  expect(child.typography).toMatchObject({ fontSize: 30, letterSpacing: 3 });
  expect(child.minFontSize).toBe(15);
  expect(child.maxFontSize).toBe(60);
  expect(applyPatch(result.document, result.inverse).document).toEqual(document);
});

it("defaults a container group to preserving child content and geometry", () => {
  const document = loadFixture("technical");
  const children = document.slides[0]!.elements;
  const group: GroupElement = {
    id: newId("el"), type: "group", name: "Container",
    transform: { x: 0, y: 0, width: 800, height: 400 },
    children, containerLayout: { type: "horizontal" },
  };
  document.slides[0]!.elements = [group];
  const result = applyPatch(document, resizeOperations(document, group.id, { ...group.transform, width: 1000 }));
  expect(PresentationDocumentSchema.safeParse(result.document).success).toBe(true);
  expect((result.document.slides[0]!.elements[0] as GroupElement).children).toEqual(children);
});
