import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  SCHEMA_VERSION,
  isGroup,
  serializeDocument,
  validateDocument,
  walkElements,
  type PatchOperation,
  type PresentationDocument,
} from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import {
  OperationError,
  addElement,
  allDocumentElements,
  cleanupOperationsForDeletion,
  cloneSlide,
  collectIds,
  createPresentation,
  createSlide,
  elementsByRole,
  groupElements,
  makeTextElement,
  makeStarterElement,
  moveElement,
  moveSlide,
  removeElement,
  removeSlide,
  resolveElementById,
  resolveSlideById,
  setProperty,
  setPropertyDeep,
  setSlideProperty,
  validateReferences,
  withFreshIds,
} from "../src/index";

const base: PresentationDocument = loadFixture("technical");
const slideId = base.slides[0]!.id;
const elementId = base.slides[0]!.elements[0]!.id;

/** Every operation goes through the one mutation path, exactly as production does. */
function apply(document: PresentationDocument, operations: PatchOperation[]): PresentationDocument {
  return applyPatch(document, operations).document;
}

describe("starter elements", () => {
  it.each(["text", "shape", "line", "icon", "chart", "diagram", "table", "code"] as const)(
    "creates a valid and useful %s element",
    (kind) => {
      const element = makeStarterElement({ kind, viewport: base.viewport });
      const after = apply(base, addElement(base, { slideId, element }));

      expect(element.type).toBe(kind);
      expect(element.transform.x).toBeGreaterThanOrEqual(0);
      expect(element.transform.y).toBeGreaterThanOrEqual(0);
      expect(validateDocument(after)).toMatchObject({ valid: true });
    },
  );

  it("uses local coordinates for line endpoints", () => {
    const line = makeStarterElement({ kind: "line", viewport: base.viewport });
    expect(line).toMatchObject({
      type: "line",
      from: { x: 0 },
      to: { x: line.transform.width },
      endMarker: "arrow",
    });
  });
});

describe("finding things", () => {
  it("resolves a top-level element and gives back a usable path", () => {
    const found = resolveElementById(base, elementId)!;
    expect(found.element.id).toBe(elementId);
    expect(found.slide.id).toBe(slideId);
    expect(found.ancestors).toEqual([]);
    // A caller that finds an element almost always wants to change it next, and a
    // change is expressed as a path.
    expect(found.path).toBe(`/slides/id:${slideId}/elements/id:${elementId}`);
  });

  it("finds an element nested inside groups and threads the path through them", () => {
    const kpiSlide = base.slides[1]!;
    const row = kpiSlide.elements.find((e) => isGroup(e))!;
    const card = (row as { children: { id: string }[] }).children[0]!;
    const inner = (card as unknown as { children: { id: string }[] }).children[0]!;

    const found = resolveElementById(base, inner.id)!;
    expect(found.ancestors.map((a) => a.id)).toEqual([row.id, card.id]);
    expect(found.path).toBe(
      `/slides/id:${kpiSlide.id}/elements/id:${row.id}/children/id:${card.id}/children/id:${inner.id}`,
    );
  });

  it("returns undefined rather than throwing for a missing id", () => {
    // "Is this id still here" is a routine question — after an agent edit, when
    // restoring a selection — and an exception is the wrong shape for a routine
    // negative answer.
    expect(resolveElementById(base, "el_01JB8Z9K2QW4RN7F3XG5HTMD6A")).toBeUndefined();
    expect(resolveSlideById(base, "sld_01JB8Z9K2QW4RN7F3XG5HTMD6A")).toBeUndefined();
  });

  it("collects every id in the document", () => {
    const ids = collectIds(base);
    expect(ids.has(base.id)).toBe(true);
    expect(ids.has(base.theme.id)).toBe(true);
    expect(ids.has(slideId)).toBe(true);
    expect(ids.has(elementId)).toBe(true);
  });

  it("selects by semantic role", () => {
    // Roles are what let an instruction target meaning rather than geometry.
    expect(elementsByRole(base, "headline").length).toBeGreaterThan(0);
  });
});

describe("createPresentation", () => {
  it("produces a valid, empty document", () => {
    const doc = createPresentation({
      title: "New deck",
      theme: base.theme,
      schemaVersion: SCHEMA_VERSION,
    });

    // Zero slides is valid (doc 02 §4.2) — a new project genuinely has none.
    expect(doc.slides).toEqual([]);
    expect(validateDocument(doc).valid).toBe(true);
  });
});

describe("slides", () => {
  it("appends a slide by default and inserts at an index on request", () => {
    const appended = apply(base, createSlide(base).operations);
    expect(appended.slides).toHaveLength(base.slides.length + 1);

    const { operations, slide } = createSlide(base, { atIndex: 1, name: "Inserted" });
    const inserted = apply(base, operations);
    expect(inserted.slides[1]!.id).toBe(slide.id);
  });

  it("reorders with a single move, not a remove/add pair", () => {
    // One operation inverts to one operation; a remove/add pair inverts to two
    // that must replay in the right order against the right intermediate state.
    const operations = moveSlide(base, slideId, 3);
    expect(operations).toHaveLength(1);
    expect(operations[0]!.op).toBe("move");

    const after = apply(base, operations);
    expect(after.slides[3]!.id).toBe(slideId);
    expect(after.slides).toHaveLength(base.slides.length);
  });

  it("emits nothing when a move would change nothing", () => {
    expect(moveSlide(base, slideId, 0)).toEqual([]);
  });

  it("removes a slide", () => {
    const after = apply(base, removeSlide(base, slideId));
    expect(after.slides.map((s) => s.id)).not.toContain(slideId);
  });

  it("refuses to operate on a slide that does not exist", () => {
    expect(() => removeSlide(base, "sld_01JB8Z9K2QW4RN7F3XG5HTMD6A")).toThrow(OperationError);
  });
});

describe("cloning a slide", () => {
  const source = base.slides[1]!;

  it("gives every copied element a fresh id", () => {
    // Reusing ids would make the copy indistinguishable from the original to
    // every animation target, constraint and provenance record — and duplicate
    // ids are error E001 for exactly that reason.
    const { operations, slide, idMap } = cloneSlide(base, source.id);
    const after = apply(base, operations);

    const originalIds = new Set([...walkElements(source.elements)].map(({ element }) => element.id));
    const copyIds = [...walkElements(slide.elements)].map(({ element }) => element.id);

    expect(copyIds.length).toBeGreaterThan(0);
    for (const id of copyIds) expect(originalIds.has(id)).toBe(false);
    expect(idMap.size).toBeGreaterThanOrEqual(originalIds.size + 1); // every element plus the slide
    for (const id of originalIds) expect(copyIds).toContain(idMap.get(id));
    expect(validateDocument(after).valid).toBe(true);
  });

  it("lands immediately after the original", () => {
    const { operations, slide } = cloneSlide(base, source.id);
    const after = apply(base, operations);
    expect(after.slides[2]!.id).toBe(slide.id);
  });

  it("rewrites animation targets to point at the copy's own elements", () => {
    // The part that is easy to forget: a track pointing at the *original* element
    // would leave the duplicate animating its neighbour's contents.
    const animated = loadFixture("animation");
    const original = animated.slides[0]!;
    const copy = withFreshIds(original);

    const copyElementIds = new Set([...walkElements(copy.elements)].map(({ element }) => element.id));
    expect(copy.animations!.length).toBeGreaterThan(0);
    for (const track of copy.animations!) {
      expect(copyElementIds.has(track.targetId)).toBe(true);
    }
  });

  it("produces a document that still validates, with no dangling references", () => {
    const animated = loadFixture("animation");
    const { operations } = cloneSlide(animated, animated.slides[0]!.id);
    const after = apply(animated, operations);

    expect(validateDocument(after).valid).toBe(true);
    expect(validateReferences(after).filter((p) => p.severity === "error")).toEqual([]);
  });
});

describe("elements", () => {
  const text = () =>
    makeTextElement({ text: "Hello", x: 100, y: 100, width: 400, height: 80 });

  it("adds at slide level", () => {
    const element = text();
    const after = apply(base, addElement(base, { slideId, element }));
    expect(after.slides[0]!.elements.at(-1)!.id).toBe(element.id);
  });

  it("adds inside a group", () => {
    const kpiSlide = base.slides[1]!;
    const row = kpiSlide.elements.find((e) => isGroup(e))!;
    const element = text();

    const after = apply(
      base,
      addElement(base, { slideId: kpiSlide.id, element, parentGroupId: row.id }),
    );

    const updatedRow = after.slides[1]!.elements.find((e) => e.id === row.id)!;
    expect((updatedRow as { children: { id: string }[] }).children.at(-1)!.id).toBe(element.id);
  });

  it("refuses to add into something that is not a group", () => {
    expect(() =>
      addElement(base, { slideId, element: text(), parentGroupId: elementId }),
    ).toThrow(/not a group/);
  });

  it("removes an element wherever it is nested", () => {
    const kpiSlide = base.slides[1]!;
    const row = kpiSlide.elements.find((e) => isGroup(e))!;
    const card = (row as { children: { id: string }[] }).children[0]!;

    const after = apply(base, removeElement(base, card.id));
    expect(resolveElementById(after, card.id)).toBeUndefined();
  });

  it("reorders within a parent, which is what 'bring to front' means", () => {
    // Array position is the ordering authority; zIndex is an override for pinning
    // (doc 02 §8.4).
    const first = base.slides[0]!.elements[0]!.id;
    const after = apply(base, moveElement(base, { elementId: first, toIndex: 2 }));
    expect(after.slides[0]!.elements[2]!.id).toBe(first);
    expect(after.slides[0]!.elements).toHaveLength(base.slides[0]!.elements.length);
  });

  it("moves an element to another slide", () => {
    const target = base.slides[2]!.id;
    const after = apply(base, moveElement(base, { elementId, toSlideId: target }));

    expect(after.slides[0]!.elements.map((e) => e.id)).not.toContain(elementId);
    expect(after.slides[2]!.elements.at(-1)!.id).toBe(elementId);
  });

  it("moves an element into a group", () => {
    const kpiSlide = base.slides[1]!;
    const row = kpiSlide.elements.find((e) => isGroup(e))!;
    const loose = kpiSlide.elements.find((e) => !isGroup(e))!;

    const after = apply(
      base,
      moveElement(base, { elementId: loose.id, toSlideId: kpiSlide.id, toGroupId: row.id }),
    );

    const found = resolveElementById(after, loose.id)!;
    expect(found.ancestors.map((a) => a.id)).toContain(row.id);
  });

  it("refuses to move a group into itself", () => {
    // Without the check the move succeeds and detaches the whole subtree from the
    // document.
    const kpiSlide = base.slides[1]!;
    const row = kpiSlide.elements.find((e) => isGroup(e))!;
    const card = (row as { children: { id: string }[] }).children[0]!;

    expect(() =>
      moveElement(base, { elementId: row.id, toSlideId: kpiSlide.id, toGroupId: card.id }),
    ).toThrow(/cannot be moved into itself/);
  });

  it("emits nothing when a move would change nothing", () => {
    expect(moveElement(base, { elementId, toIndex: 0 })).toEqual([]);
  });
});

describe("setting properties", () => {
  it("replaces a property that exists and adds one that does not", () => {
    // Choosing wrong makes the patch fail on an optional property that has never
    // been set.
    expect(setProperty(base, elementId, "transform.x", 42)[0]!.op).toBe("replace");
    expect(setProperty(base, elementId, "metadata", { notes: "n" })[0]!.op).toBe("add");
  });

  it("targets the narrowest possible path", () => {
    // A patch that replaces a whole slide destroys ids, breaks animations that
    // referenced them, and makes the change unreviewable (doc 02 §31.8).
    const operations = setProperty(base, elementId, "typography.fontSize", 72);
    expect(operations[0]!.path).toBe(
      `/slides/id:${slideId}/elements/id:${elementId}/typography/fontSize`,
    );

    const after = apply(base, operations);
    expect((after.slides[0]!.elements[0]! as { typography: { fontSize: number } }).typography.fontSize).toBe(72);
  });

  it("sets a slide property", () => {
    const after = apply(base, setSlideProperty(base, slideId, "keyMessage", "New message"));
    expect(after.slides[0]!.keyMessage).toBe("New message");
  });
});

describe("grouping", () => {
  it("wraps elements and re-expresses their transforms in the group's space", () => {
    const slide = base.slides[0]!;
    const [a, b] = [slide.elements[0]!, slide.elements[1]!];

    const { operations, groupId } = groupElements(base, [a.id, b.id], { name: "Title block" });
    const after = apply(base, operations);

    const group = after.slides[0]!.elements.find((e) => e.id === groupId)!;
    expect(isGroup(group)).toBe(true);

    // The group's box is the union of its children; a child's transform is in its
    // parent's space (doc 02 §10.3), so leaving world coordinates would displace
    // every one of them.
    const expectedX = Math.min(a.transform.x, b.transform.x);
    expect(group.transform.x).toBeCloseTo(expectedX, 1);

    const children = (group as { children: { id: string; transform: { x: number } }[] }).children;
    const movedA = children.find((c) => c.id === a.id)!;
    expect(movedA.transform.x).toBeCloseTo(a.transform.x - expectedX, 1);
  });

  it("keeps world positions unchanged after grouping", () => {
    const slide = base.slides[0]!;
    const [a, b] = [slide.elements[0]!, slide.elements[1]!];

    const { operations, groupId } = groupElements(base, [a.id, b.id]);
    const after = apply(base, operations);

    const group = after.slides[0]!.elements.find((e) => e.id === groupId)!;
    const child = (group as { children: { id: string; transform: { x: number; y: number } }[] }).children.find(
      (c) => c.id === a.id,
    )!;

    expect(group.transform.x + child.transform.x).toBeCloseTo(a.transform.x, 1);
    expect(group.transform.y + child.transform.y).toBeCloseTo(a.transform.y, 1);
  });

  it("refuses to group across slides or with fewer than two elements", () => {
    const other = base.slides[1]!.elements[0]!.id;
    expect(() => groupElements(base, [elementId, other])).toThrow(/same slide/);
    expect(() => groupElements(base, [elementId])).toThrow(/at least two/);
  });

  it("produces a valid document", () => {
    const slide = base.slides[0]!;
    const { operations } = groupElements(base, [slide.elements[0]!.id, slide.elements[1]!.id]);
    expect(validateDocument(apply(base, operations)).valid).toBe(true);
  });
});

describe("reference integrity", () => {
  it("reports nothing for the untouched fixtures", () => {
    for (const name of ["technical", "repository", "animation"] as const) {
      expect(validateReferences(loadFixture(name)), name).toEqual([]);
    }
  });

  it("catches an animation left pointing at a deleted element", () => {
    const animated = loadFixture("animation");
    const target = animated.slides[0]!.animations![0]!.targetId;
    const after = apply(animated, removeElement(animated, target));

    const problems = validateReferences(after);
    expect(problems.some((p) => p.code === "E101")).toBe(true);
    expect(problems[0]!.severity).toBe("error");
  });

  it("treats a lost connector anchor as a warning, not an error", () => {
    // Deleting a node must never silently delete its connectors — the user loses
    // work they did not ask to lose (doc 02 §14.2).
    const withConnector = apply(base, [
      {
        op: "add",
        path: `/slides/id:${slideId}/elements/-`,
        value: {
          id: "el_01JB8Z9K2QW4RN7F3XG5HTMD71",
          type: "line",
          transform: { x: 0, y: 0, width: 200, height: 2 },
          from: { elementId, anchor: "auto" },
          to: { x: 200, y: 0 },
        },
      },
    ]);

    const orphaned = apply(withConnector, removeElement(withConnector, elementId));
    const problems = validateReferences(orphaned);

    const anchor = problems.find((p) => p.code === "W105")!;
    expect(anchor.severity).toBe("warning");
    expect(anchor.message).toMatch(/re-attach/);
  });

  it("proposes cleanup that lets a deletion commit as one transaction", () => {
    // Deleting an element and orphaning its animation in two steps leaves a window
    // where the document is invalid, and an undo of only the first half is worse
    // than either.
    const animated = loadFixture("animation");
    const target = animated.slides[0]!.animations![0]!.targetId;

    const cleanup = cleanupOperationsForDeletion(animated, [target]);
    expect(cleanup.length).toBeGreaterThan(0);

    const after = apply(animated, [...cleanup, ...removeElement(animated, target)]);
    expect(validateReferences(after).filter((p) => p.severity === "error")).toEqual([]);
    expect(validateDocument(after).valid).toBe(true);
  });

  it("cleans up animations targeting a group's children when the group goes", () => {
    const animated = loadFixture("animation");
    const targets = animated.slides[0]!.animations!.map((t) => t.targetId);
    const cleanup = cleanupOperationsForDeletion(animated, targets);
    expect(cleanup).toHaveLength(animated.slides[0]!.animations!.length);
  });
});

describe("every operation is undoable, because they are all patches", () => {
  it("round-trips each one", () => {
    const cases: [string, PatchOperation[]][] = [
      ["createSlide", createSlide(base, { name: "New" }).operations],
      ["removeSlide", removeSlide(base, slideId)],
      ["moveSlide", moveSlide(base, slideId, 3)],
      ["cloneSlide", cloneSlide(base, slideId).operations],
      [
        "addElement",
        addElement(base, {
          slideId,
          element: makeTextElement({ text: "Hi", x: 10, y: 10, width: 100, height: 50 }),
        }),
      ],
      ["removeElement", removeElement(base, elementId)],
      ["moveElement", moveElement(base, { elementId, toIndex: 2 })],
      ["setProperty", setProperty(base, elementId, "transform.x", 999)],
      [
        "groupElements",
        groupElements(base, [base.slides[0]!.elements[0]!.id, base.slides[0]!.elements[1]!.id])
          .operations,
      ],
    ];

    const original = serializeDocument(base);

    for (const [label, operations] of cases) {
      const forward = applyPatch(base, operations);
      const back = applyPatch(forward.document, forward.inverse);
      expect(serializeDocument(back.document), label).toBe(original);
    }
  });
});

describe("document walking", () => {
  it("visits nested elements with their depth", () => {
    const all = allDocumentElements(base);
    expect(all.length).toBeGreaterThan(base.slides.length);
    expect(all.some(({ depth }) => depth > 0)).toBe(true);
  });
});

describe("move indices land exactly (regression)", () => {
  it("puts an element at every requested final position", () => {
    // `toIndex` is the position the element ends up at. An earlier version
    // subtracted one for forward moves — compensating for a shift the applier
    // already handles — and landed everything one slot short.
    const slide = base.slides[0]!;
    const ids = slide.elements.map((e) => e.id);

    for (let from = 0; from < ids.length; from += 1) {
      for (let to = 0; to < ids.length; to += 1) {
        const operations = moveElement(base, { elementId: ids[from]!, toIndex: to });
        const after = apply(base, operations);

        expect(after.slides[0]!.elements[to]!.id, `${from} -> ${to}`).toBe(ids[from]);
        expect(after.slides[0]!.elements, `${from} -> ${to}`).toHaveLength(ids.length);
      }
    }
  });

  it("puts a slide at every requested final position", () => {
    const ids = base.slides.map((s) => s.id);

    for (let from = 0; from < ids.length; from += 1) {
      for (let to = 0; to < ids.length; to += 1) {
        const after = apply(base, moveSlide(base, ids[from]!, to));
        expect(after.slides[to]!.id, `${from} -> ${to}`).toBe(ids[from]);
        expect(after.slides, `${from} -> ${to}`).toHaveLength(ids.length);
      }
    }
  });
});

describe("setPropertyDeep", () => {
  it("adds the outermost missing object, so the inverse removes exactly that", () => {
    const text = base.slides[0]!.elements.find((element) => element.type === "text")!;
    const doc = structuredClone(base);
    const found = resolveElementById(doc, text.id)!;
    delete (found.element as { paragraph?: unknown }).paragraph;
    const operations = setPropertyDeep(doc, text.id, "paragraph.align", "center");
    expect(operations).toEqual([{ op: "add", path: `${found.path}/paragraph`, value: { align: "center" } }]);
    const result = applyPatch(doc, operations);
    expect((resolveElementById(result.document, text.id)!.element as { paragraph?: unknown }).paragraph).toEqual({ align: "center" });
    expect(applyPatch(result.document, result.inverse).document).toEqual(doc);
  });

  it("replaces an existing value and removes on undefined, and removing nothing is no operation", () => {
    const shape = makeStarterElement({ kind: "shape", viewport: base.viewport });
    const doc = apply(base, addElement(base, { slideId, element: shape }));
    expect(setPropertyDeep(doc, shape.id, "style.cornerRadius", 4)[0]).toMatchObject({ op: "replace" });
    expect(setPropertyDeep(doc, shape.id, "style.cornerRadius", undefined)[0]).toMatchObject({ op: "remove" });
    expect(setPropertyDeep(doc, shape.id, "style.stroke", undefined)).toEqual([]);
  });
});
