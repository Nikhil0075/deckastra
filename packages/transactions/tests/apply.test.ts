import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import {
  newId,
  serializeDocument,
  validateDocument,
  walkElements,
  type PatchOperation,
  type PresentationDocument,
} from "@deckastra/presentation-schema";

import { PatchError, applyPatch, readPath, resolvePath, pathExists } from "../src/index";

function fixture(): PresentationDocument {
  return loadFixture("technical");
}

const doc = fixture();
const slideId = doc.slides[0]!.id;
const elementId = doc.slides[0]!.elements[0]!.id;

describe("path resolution", () => {
  it("resolves an id-addressed path to a concrete index", () => {
    const resolved = resolvePath(doc, `/slides/id:${slideId}/elements/id:${elementId}`);
    expect(resolved.isArray).toBe(true);
    expect(resolved.key).toBe(0);
  });

  it("still resolves after an earlier sibling is inserted", () => {
    // The exit criterion for id-addressed paths, and the entire reason they
    // exist: an index captured at read time is stale the moment anything is
    // inserted before it, which is exactly what agents do (doc 02 §31.3).
    const path = `/slides/id:${slideId}/elements/id:${elementId}/transform/x`;
    const before = readPath(doc, path);

    const { document: after } = applyPatch(doc, [
      {
        op: "add",
        path: `/slides/id:${slideId}/elements/0`,
        value: {
          id: newId("el"),
          type: "shape",
          shape: "rectangle",
          transform: { x: 0, y: 0, width: 10, height: 10 },
        },
      },
    ]);

    // The element moved from index 0 to index 1, and the id path followed it.
    expect(readPath(after, path)).toBe(before);
    expect(resolvePath(after, `/slides/id:${slideId}/elements/id:${elementId}`).key).toBe(1);
  });

  it("names the nearest existing id when one does not resolve", () => {
    // The commonest cause of this failure is an agent citing an id from a stale
    // read, so a dead end that names the closest live id is actionable.
    const wrong = `${elementId.slice(0, -1)}Z`;
    expect(() => resolvePath(doc, `/slides/id:${slideId}/elements/id:${wrong}`)).toThrow(
      /Nearest existing id/,
    );
  });

  it("refuses to descend through something that does not exist", () => {
    // Patches never create intermediate structure: materializing a missing slide
    // silently turns a typo into a data-shaped bug.
    expect(() => resolvePath(doc, `/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD6A/elements/0`)).toThrow();
  });

  it("supports numeric indices for arrays whose members have no id", () => {
    const path = `/slides/id:${slideId}/elements/id:${elementId}/content/blocks/0/spans/0/text`;
    expect(typeof readPath(doc, path)).toBe("string");
  });

  it("round-trips keys containing slashes and tildes", () => {
    const { document: after } = applyPatch(doc, [
      { op: "add", path: "/theme/colors/custom", value: { "brand/primary~alt": "#fff" } },
    ]);
    expect(readPath(after, "/theme/colors/custom/brand~1primary~0alt")).toBe("#fff");
  });

  it("rejects the root path as an operation target", () => {
    expect(() => resolvePath(doc, "/")).toThrow(/root path/);
  });
});

describe("applying patches", () => {
  it("never mutates the input document", () => {
    const before = serializeDocument(doc);
    applyPatch(doc, [
      { op: "replace", path: `/slides/id:${slideId}/keyMessage`, value: "changed" },
    ]);
    expect(serializeDocument(doc)).toBe(before);
  });

  it("is atomic: a failing operation leaves nothing behind", () => {
    const before = serializeDocument(doc);

    expect(() =>
      applyPatch(doc, [
        { op: "replace", path: `/slides/id:${slideId}/keyMessage`, value: "first" },
        { op: "replace", path: "/slides/id:sld_DOESNOTEXIST0000000000000/name", value: "boom" },
      ]),
    ).toThrow(PatchError);

    // The first operation must not have survived the second one failing.
    expect(serializeDocument(doc)).toBe(before);
  });

  it("reports which operation failed and why", () => {
    try {
      applyPatch(doc, [
        { op: "replace", path: `/slides/id:${slideId}/keyMessage`, value: "ok" },
        { op: "remove", path: `/slides/id:${slideId}/elements/id:el_01JB8Z9K2QW4RN7F3XG5HTMD6A` },
      ]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      expect((error as PatchError).operationIndex).toBe(1);
      expect((error as PatchError).code).toBe("E301");
    }
  });

  it("appends with the RFC 6902 dash token", () => {
    const { document: after } = applyPatch(doc, [
      { op: "add", path: "/slides/-", value: { id: newId("sld"), elements: [] } },
    ]);
    expect(after.slides).toHaveLength(doc.slides.length + 1);
  });

  it("moves a slide without a remove/add pair", () => {
    const order = doc.slides.map((s) => s.id);
    const { document: after } = applyPatch(doc, [
      { op: "move", from: `/slides/id:${order[0]}`, path: "/slides/2" },
    ]);

    expect(after.slides.map((s) => s.id)).toEqual([order[1], order[2], order[0], order[3], order[4]]);
  });

  it("moves correctly when source and destination share a parent", () => {
    // The off-by-one trap: removing shortens the array, so a later destination
    // index shifts down. Resolving both paths up front and then splicing gets the
    // reorder case — the most common move there is — wrong by one.
    const order = doc.slides.map((s) => s.id);
    const { document: after } = applyPatch(doc, [
      { op: "move", from: `/slides/id:${order[3]}`, path: "/slides/1" },
    ]);

    expect(after.slides.map((s) => s.id)).toEqual([order[0], order[3], order[1], order[2], order[4]]);
  });

  it("copies without disturbing the source", () => {
    const { document: after } = applyPatch(doc, [
      { op: "copy", from: `/slides/id:${slideId}`, path: "/slides/-" },
    ]);
    expect(after.slides).toHaveLength(doc.slides.length + 1);
    expect(after.slides.at(-1)!.keyMessage).toBe(doc.slides[0]!.keyMessage);
  });

  it("passes a satisfied test and changes nothing", () => {
    const path = `/slides/id:${slideId}/keyMessage`;
    const result = applyPatch(doc, [{ op: "test", path, value: readPath(doc, path) }]);
    expect(serializeDocument(result.document)).toBe(serializeDocument(doc));
    expect(result.inverse).toEqual([]);
  });

  it("fails the whole patch when a test does not hold", () => {
    // Optimistic concurrency: an agent that read a value asserts it is unchanged
    // before writing, and the patch fails atomically if someone got there first.
    expect(() =>
      applyPatch(doc, [
        { op: "test", path: `/slides/id:${slideId}/keyMessage`, value: "something else" },
        { op: "replace", path: `/slides/id:${slideId}/keyMessage`, value: "new" },
      ]),
    ).toThrow(/no longer holds the expected value/);
  });

  it("deep-clones values in, so a caller cannot mutate the document afterwards", () => {
    const value = { nested: { deep: 1 } };
    const { document: after } = applyPatch(doc, [
      { op: "add", path: "/extensions", value },
    ]);
    value.nested.deep = 999;
    expect((after.extensions as typeof value).nested.deep).toBe(1);
  });
});

describe("inverse generation", () => {
  const roundTrip = (operations: PatchOperation[]): void => {
    const forward = applyPatch(doc, operations);
    const back = applyPatch(forward.document, forward.inverse);
    expect(serializeDocument(back.document)).toBe(serializeDocument(doc));
  };

  it("inverts a replace", () => {
    roundTrip([{ op: "replace", path: `/slides/id:${slideId}/keyMessage`, value: "different" }]);
  });

  it("inverts an add", () => {
    roundTrip([{ op: "add", path: "/slides/-", value: { id: newId("sld"), elements: [] } }]);
  });

  it("inverts an add onto an existing key by restoring the old value", () => {
    // `add` onto an existing key overwrites (RFC 6902), so its inverse restores
    // rather than removes. Getting this wrong deletes a property that existed.
    roundTrip([{ op: "add", path: `/slides/id:${slideId}/keyMessage`, value: "overwritten" }]);
  });

  it("inverts a remove, restoring position as well as content", () => {
    const middle = doc.slides[2]!.id;
    const forward = applyPatch(doc, [{ op: "remove", path: `/slides/id:${middle}` }]);
    const back = applyPatch(forward.document, forward.inverse);

    expect(back.document.slides.map((s) => s.id)).toEqual(doc.slides.map((s) => s.id));
    expect(serializeDocument(back.document)).toBe(serializeDocument(doc));
  });

  it("inverts a move", () => {
    roundTrip([{ op: "move", from: `/slides/id:${slideId}`, path: "/slides/3" }]);
  });

  it("inverts a copy", () => {
    roundTrip([{ op: "copy", from: `/slides/id:${slideId}`, path: "/slides/-" }]);
  });

  it("inverts a nested element edit", () => {
    roundTrip([
      {
        op: "replace",
        path: `/slides/id:${slideId}/elements/id:${elementId}/transform/x`,
        value: 999,
      },
    ]);
  });

  it("returns inverses in reverse application order", () => {
    // Undoing [a, b] means undoing b first, because b was applied to the state a
    // produced. Getting this backwards works for single-operation patches and
    // corrupts multi-operation ones — a bug that surfaces weeks later.
    const forward = applyPatch(doc, [
      { op: "replace", path: `/slides/id:${slideId}/keyMessage`, value: "one" },
      { op: "remove", path: `/slides/id:${slideId}/name` },
    ]);

    expect(forward.inverse[0]!.op).toBe("add");
    expect(forward.inverse[1]!.op).toBe("replace");
  });

  it("inverts a multi-operation patch that touches several array indices", () => {
    const ids = doc.slides.map((s) => s.id);
    roundTrip([
      { op: "remove", path: `/slides/id:${ids[1]}` },
      { op: "remove", path: `/slides/id:${ids[3]}` },
      { op: "add", path: "/slides/0", value: { id: newId("sld"), elements: [] } },
      { op: "move", from: `/slides/id:${ids[4]}`, path: "/slides/1" },
    ]);
  });
});

/**
 * The Phase 2 exit criterion, stated in the plan as
 * `apply(inverse(apply(d, p)), p) === d`.
 *
 * Generated rather than hand-written: the hand-written cases above cover the
 * shapes someone thought of, and this covers the ones nobody did — particularly
 * interleavings of array operations, which is where index churn hides.
 */
describe("property: every patch inverts exactly", () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomOperations(base: PresentationDocument, random: () => number): PatchOperation[] {
    const slideIds = base.slides.map((s) => s.id);
    const elementIds: { slide: string; element: string }[] = [];
    for (const slide of base.slides) {
      for (const { element } of walkElements(slide.elements)) {
        elementIds.push({ slide: slide.id, element: element.id });
      }
    }

    const pickSlide = () => slideIds[Math.floor(random() * slideIds.length)]!;
    const pickElement = () => elementIds[Math.floor(random() * elementIds.length)]!;

    const candidates: (() => PatchOperation)[] = [
      () => ({ op: "replace", path: `/slides/id:${pickSlide()}/keyMessage`, value: `m${random()}` }),
      () => ({ op: "add", path: `/slides/id:${pickSlide()}/name`, value: `n${random()}` }),
      () => ({ op: "remove", path: `/slides/id:${pickSlide()}` }),
      () => ({
        op: "add",
        path: `/slides/${Math.floor(random() * (slideIds.length + 1))}`,
        value: { id: newId("sld"), elements: [] },
      }),
      () => ({
        op: "move",
        from: `/slides/id:${pickSlide()}`,
        path: `/slides/${Math.floor(random() * slideIds.length)}`,
      }),
      () => ({ op: "copy", from: `/slides/id:${pickSlide()}`, path: "/slides/-" }),
      () => {
        const { slide, element } = pickElement();
        return {
          op: "replace",
          path: `/slides/id:${slide}/elements/id:${element}/transform/x`,
          value: Math.floor(random() * 1000),
        };
      },
      () => {
        const { slide, element } = pickElement();
        return { op: "remove", path: `/slides/id:${slide}/elements/id:${element}` };
      },
    ];

    const count = 1 + Math.floor(random() * 4);
    return Array.from({ length: count }, () => candidates[Math.floor(random() * candidates.length)]!());
  }

  it("holds over 400 generated patches", () => {
    const original = serializeDocument(doc);
    let applied = 0;
    let skipped = 0;

    for (let seed = 1; seed <= 400; seed += 1) {
      const random = mulberry32(seed);
      const operations = randomOperations(doc, random);

      let forward;
      try {
        forward = applyPatch(doc, operations);
      } catch {
        // A generated patch can be internally inconsistent — removing a slide and
        // then addressing it. That is a legitimate rejection, not a failure of
        // the property under test.
        skipped += 1;
        continue;
      }

      const back = applyPatch(forward.document, forward.inverse);
      expect(serializeDocument(back.document), `seed ${seed}`).toBe(original);
      applied += 1;
    }

    // Guard against the property passing vacuously because everything was skipped.
    expect(applied).toBeGreaterThan(250);
    expect(applied + skipped).toBe(400);
  });

  it("leaves the document valid after apply and after undo", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = mulberry32(seed * 7);
      let forward;
      try {
        forward = applyPatch(doc, randomOperations(doc, random));
      } catch {
        continue;
      }

      // Structural validity is not implied by invertibility: a patch can round-trip
      // perfectly and still leave a document the renderer would refuse.
      const back = applyPatch(forward.document, forward.inverse);
      expect(validateDocument(back.document).valid, `seed ${seed} after undo`).toBe(true);
    }
  });
});

describe("large documents", () => {
  it("round-trips a 20-slide deck without loss", () => {
    // The third Phase 2 exit criterion.
    const big = fixture();
    while (big.slides.length < 20) {
      const source = big.slides[big.slides.length % 5]!;
      big.slides.push({ ...structuredClone(source), id: newId("sld") });
    }

    const before = serializeDocument(big);
    const forward = applyPatch(big, [
      { op: "move", from: `/slides/id:${big.slides[0]!.id}`, path: "/slides/19" },
      { op: "remove", path: `/slides/id:${big.slides[5]!.id}` },
      { op: "add", path: "/slides/3", value: { id: newId("sld"), elements: [] } },
    ]);

    expect(forward.document.slides).toHaveLength(20);
    const back = applyPatch(forward.document, forward.inverse);
    expect(serializeDocument(back.document)).toBe(before);
  });
});

describe("pathExists", () => {
  it("answers without throwing", () => {
    expect(pathExists(doc, `/slides/id:${slideId}`)).toBe(true);
    expect(pathExists(doc, "/slides/id:sld_NOPE00000000000000000000")).toBe(false);
  });
});
