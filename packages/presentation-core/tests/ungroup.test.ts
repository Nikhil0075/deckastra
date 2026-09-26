import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  isGroup,
  newId,
  validateDocument,
  type PresentationDocument,
  type PresentationElement,
  type Transform,
} from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import { groupElements, resolveElementById, ungroupElements } from "../src/index";

/** The renderer's composition, restated so this test does not trust the code under test. */
function matrix(t: Transform) {
  const { x, y, width, height, rotation = 0, scaleX = 1, scaleY = 1, originX = 0.5, originY = 0.5 } = t;
  const r = (rotation * Math.PI) / 180;
  const ox = width * originX;
  const oy = height * originY;
  const a = Math.cos(r) * scaleX, b = Math.sin(r) * scaleX, c = -Math.sin(r) * scaleY, d = Math.cos(r) * scaleY;
  return { a, b, c, d, e: x + ox - (a * ox + c * oy), f: y + oy - (b * ox + d * oy) };
}
type M = ReturnType<typeof matrix>;
const mul = (p: M, q: M): M => ({
  a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b,
  c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d,
  e: p.a * q.e + p.c * q.f + p.e, f: p.b * q.e + p.d * q.f + p.f,
});
function corners(m: M, w: number, h: number) {
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [m.a * x! + m.c * y! + m.e, m.b * x! + m.d * y! + m.f]);
}

function deckWithGroup(groupTransform: Transform, style?: PresentationElement["style"]): {
  doc: PresentationDocument;
  groupId: string;
  children: PresentationElement[];
} {
  const doc = structuredClone(loadFixture("technical"));
  const groupId = newId("el");
  const children = [
    { id: newId("el"), type: "shape", shape: "rectangle", transform: { x: 10, y: 20, width: 100, height: 40, rotation: 15 } },
    { id: newId("el"), type: "shape", shape: "ellipse", transform: { x: 150, y: 60, width: 50, height: 50 } },
  ] as unknown as PresentationElement[];
  doc.slides[0]!.elements.splice(1, 0, {
    id: groupId,
    type: "group",
    name: "Card",
    transform: groupTransform,
    children,
    ...(style ? { style } : {}),
  } as unknown as PresentationElement);
  doc.slides[0]!.animations = [
    ...(doc.slides[0]!.animations ?? []),
    { id: newId("anm"), targetId: groupId, trigger: { type: "onEnter" }, clips: [{ id: newId("clp"), preset: "fade", durationMs: 300 }] } as never,
  ];
  return { doc, groupId, children };
}

describe("ungroup", () => {
  it.each([
    ["an unrotated group", { x: 300, y: 200, width: 260, height: 160 }],
    ["a rotated group", { x: 300, y: 200, width: 260, height: 160, rotation: 30 }],
    ["a rotated, uniformly scaled group", { x: 300, y: 200, width: 260, height: 160, rotation: 90, scaleX: 1.5, scaleY: 1.5 }],
  ])("leaves every child exactly where it was drawn: %s", (_label, transform) => {
    const { doc, groupId, children } = deckWithGroup(transform as Transform);
    const result = ungroupElements(doc, groupId);
    expect(result.approximated).toEqual([]);
    const after = applyPatch(doc, result.operations).document;

    for (const child of children) {
      const before = corners(mul(matrix(transform as Transform), matrix(child.transform)), child.transform.width, child.transform.height);
      const moved = resolveElementById(after, child.id)!;
      expect(moved.ancestors).toHaveLength(0);
      const now = corners(matrix(moved.element.transform), moved.element.transform.width, moved.element.transform.height);
      now.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(before[i]![0]!, 1);
        expect(y).toBeCloseTo(before[i]![1]!, 1);
      });
    }
    expect(validateDocument(after).errors).toEqual([]);
  });

  it("puts the children in the group's z-order slot, and one undo regroups exactly", () => {
    const { doc, groupId, children } = deckWithGroup({ x: 300, y: 200, width: 260, height: 160 });
    const result = applyPatch(doc, ungroupElements(doc, groupId).operations);
    const ids = result.document.slides[0]!.elements.map((element) => element.id);
    expect(ids.slice(1, 3)).toEqual(children.map((child) => child.id));
    expect(result.document.slides[0]!.elements.some((element) => element.id === groupId)).toBe(false);

    const undone = applyPatch(result.document, result.inverse).document;
    expect(undone).toEqual(doc);
  });

  it("removes what pointed at the group itself and nothing that points at its children", () => {
    const { doc, groupId, children } = deckWithGroup({ x: 0, y: 0, width: 260, height: 160 });
    doc.slides[0]!.animations!.push({
      id: newId("anm"), targetId: children[0]!.id, trigger: { type: "onEnter" }, clips: [{ id: newId("clp"), preset: "fade", durationMs: 300 }],
    } as never);
    const after = applyPatch(doc, ungroupElements(doc, groupId).operations).document;
    const targets = after.slides[0]!.animations!.map((track) => track.targetId);
    expect(targets).not.toContain(groupId);
    expect(targets).toContain(children[0]!.id);
  });

  it("keeps a styled card's background as a rectangle behind its children", () => {
    const style = { fill: { type: "solid", color: "token:colors.surface" }, cornerRadius: 16 } as PresentationElement["style"];
    const { doc, groupId, children } = deckWithGroup({ x: 300, y: 200, width: 260, height: 160 }, style);
    const result = ungroupElements(doc, groupId);
    const after = applyPatch(doc, result.operations).document;
    const elements = after.slides[0]!.elements;
    const background = elements[1]!;
    expect(background).toMatchObject({ type: "shape", shape: "rectangle", style, transform: { x: 300, y: 200, width: 260, height: 160 } });
    expect(elements.slice(2, 4).map((element) => element.id)).toEqual(children.map((child) => child.id));
    expect(result.elementIds).toEqual(children.map((child) => child.id));
  });

  it("uses a container's laid-out boxes rather than the children's advisory coordinates", () => {
    const { doc, groupId, children } = deckWithGroup({ x: 100, y: 100, width: 400, height: 100 });
    const placements = new Map([[children[1]!.id, { x: 200, y: 25, width: 50, height: 50 }]]);
    const after = applyPatch(doc, ungroupElements(doc, groupId, { placements }).operations).document;
    expect(resolveElementById(after, children[1]!.id)!.element.transform).toMatchObject({ x: 300, y: 125 });
  });

  it("round-trips with grouping", () => {
    const doc = structuredClone(loadFixture("technical"));
    const [a, b] = doc.slides[0]!.elements;
    const grouped = applyPatch(doc, groupElements(doc, [a!.id, b!.id]).operations).document;
    const group = grouped.slides[0]!.elements.find((element) => isGroup(element))!;
    const ungrouped = applyPatch(grouped, ungroupElements(grouped, group.id).operations).document;
    for (const original of [a!, b!]) {
      expect(resolveElementById(ungrouped, original.id)!.element.transform).toMatchObject({
        x: original.transform.x,
        y: original.transform.y,
      });
    }
  });

  it("refuses a locked group and anything that is not a group, by name", () => {
    const { doc, groupId } = deckWithGroup({ x: 0, y: 0, width: 260, height: 160 });
    const found = resolveElementById(doc, groupId)!;
    (found.element as { locked?: boolean }).locked = true;
    expect(() => ungroupElements(doc, groupId)).toThrow(/locked/);
    expect(() => ungroupElements(doc, doc.slides[0]!.elements[0]!.id)).toThrow(/not a group/);
  });
});
