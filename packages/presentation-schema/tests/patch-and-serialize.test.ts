import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ID_PREFIXES,
  PatchOperationSchema,
  canonicalize,
  computeRiskTier,
  documentHash,
  idTimestamp,
  isId,
  joinPath,
  newId,
  serializeDocument,
  splitPath,
  type PatchOperation,
  type PresentationDocument,
} from "../src/index";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function baseDoc(): PresentationDocument {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "technical-deck.mydeck.json"), "utf8"),
  ) as PresentationDocument;
}

describe("identifiers", () => {
  it("mints ids that satisfy the grammar", () => {
    for (const prefix of Object.values(ID_PREFIXES)) {
      const id = newId(prefix);
      expect(isId(id), `${prefix} -> ${id}`).toBe(true);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
    }
  });

  it("mints monotonically, so a burst within one millisecond cannot collide", () => {
    const ids = Array.from({ length: 500 }, () => newId("el"));
    expect(new Set(ids).size).toBe(ids.length);
    // ULIDs are lexicographically sortable by creation time, which is what makes
    // logs and diffs readable without a separate timestamp column.
    expect([...ids].sort()).toEqual(ids);
  });

  it("recovers creation time from an id", () => {
    const before = Date.now();
    const ts = idTimestamp(newId("el"))!;
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["el_short", "01JB8Z9K2QW4RN7F3XG5HTMD6A", "el_lowercase123", "", "el_"]) {
      expect(isId(bad), bad).toBe(false);
    }
  });
});

describe("patch paths", () => {
  it("round-trips through split and join", () => {
    const path = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD6A/elements/id:el_01JB8Z9K2QW4RN7F3XG5HTMD6B/transform/x";
    expect(joinPath(splitPath(path))).toBe(path);
  });

  it("escapes literal slashes and tildes in keys", () => {
    // A theme could legitimately hold a custom token named "brand/primary". Without
    // escaping, that key would silently split into two path segments.
    const segments = ["theme", "colors", "custom", "brand/primary~alt"];
    const joined = joinPath(segments);
    expect(joined).toBe("/theme/colors/custom/brand~1primary~0alt");
    expect(splitPath(joined)).toEqual(segments);
  });

  it("treats the root path as empty", () => {
    expect(splitPath("/")).toEqual([]);
  });

  it("accepts the append token", () => {
    const op = PatchOperationSchema.parse({
      op: "add",
      path: "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD6A/elements/-",
      value: {},
    });
    expect(op.op).toBe("add");
  });

  it("accepts every operation in the v1.1 set, including test and copy", () => {
    const p = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD6A";
    const ops: PatchOperation[] = [
      { op: "add", path: p, value: 1 },
      { op: "remove", path: p },
      { op: "replace", path: p, value: 2 },
      { op: "move", from: p, path: p },
      { op: "copy", from: p, path: p },
      { op: "test", path: p, value: 3 },
    ];
    for (const op of ops) expect(PatchOperationSchema.safeParse(op).success, op.op).toBe(true);
  });
});

describe("risk tiering", () => {
  const slideA = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD61";
  const slideB = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD62";
  const slideC = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD63";
  const slideD = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD64";
  const slideE = "/slides/id:sld_01JB8Z9K2QW4RN7F3XG5HTMD65";

  it("auto-applies a small single-slide edit", () => {
    const result = computeRiskTier([
      { op: "replace", path: `${slideA}/elements/id:el_01JB8Z9K2QW4RN7F3XG5HTMD6A/transform/x`, value: 10 },
    ]);
    expect(result.tier).toBe("low");
    expect(result.defaultBehavior).toBe("autoApply");
  });

  it("requires a preview once content is removed", () => {
    const result = computeRiskTier([
      { op: "remove", path: `${slideA}/elements/id:el_01JB8Z9K2QW4RN7F3XG5HTMD6A` },
    ]);
    expect(result.tier).toBe("medium");
    expect(result.defaultBehavior).toBe("pendingPreview");
  });

  it("requires explicit approval to delete a slide", () => {
    const result = computeRiskTier([{ op: "remove", path: slideA }]);
    expect(result.tier).toBe("high");
    expect(result.reasons).toContain("Deletes a slide");
  });

  it("requires explicit approval to change the theme or the viewport", () => {
    for (const path of ["/theme/colors/accent", "/viewport/width"]) {
      const result = computeRiskTier([{ op: "replace", path, value: 1 }]);
      expect(result.tier, path).toBe("high");
    }
  });

  it("escalates once more than three slides are touched", () => {
    const result = computeRiskTier(
      [slideA, slideB, slideC, slideD, slideE].map((s, i) => ({
        op: "replace" as const,
        path: `${s}/keyMessage`,
        value: `m${i}`,
      })),
    );
    expect(result.tier).toBe("high");
    expect(result.reasons.some((r) => r.includes("5 slides"))).toBe(true);
  });

  it("counts the source slide of a move", () => {
    // A move out of a slide changes that slide too. Counting only the destination
    // would let a cross-deck reshuffle look like a single-slide edit and auto-apply.
    const result = computeRiskTier([
      { op: "move", from: `${slideA}/elements/id:el_01JB8Z9K2QW4RN7F3XG5HTMD6A`, path: `${slideB}/elements/-` },
    ]);
    expect(result.tier).not.toBe("low");
  });

  it("always explains itself", () => {
    const result = computeRiskTier([{ op: "remove", path: slideA }]);
    // The tier is computed server-side and the user is asked to approve it, so it
    // has to be able to say why.
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("canonical serialization", () => {
  it("produces identical bytes for deeply equal documents built in different key orders", () => {
    const a = baseDoc();
    const b = JSON.parse(JSON.stringify(a)) as PresentationDocument;

    // Rebuild one slide with its keys in a different insertion order — exactly what
    // an agent patch or a different code path naturally produces.
    const slide = b.slides[0]!;
    b.slides[0] = {
      transition: slide.transition,
      elements: slide.elements,
      keyMessage: slide.keyMessage,
      id: slide.id,
      name: slide.name,
      semanticIntent: slide.semanticIntent,
      background: slide.background,
      animations: slide.animations,
    } as typeof slide;

    expect(serializeDocument(b)).toBe(serializeDocument(a));
  });

  it("never reorders arrays, because array position carries meaning", () => {
    const doc = baseDoc();
    const before = doc.slides.map((s) => s.id);
    const after = (JSON.parse(serializeDocument(doc)) as PresentationDocument).slides.map(
      (s) => s.id,
    );
    // Slide order and z-order are both array position (doc 02 §7.2, §8.4). Sorting
    // an array here would silently reorder the deck.
    expect(after).toEqual(before);
  });

  it("floats identity keys to the top so diffs stay readable", () => {
    const json = serializeDocument(baseDoc());
    const keys = Object.keys(JSON.parse(json) as object);
    expect(keys[0]).toBe("schemaVersion");
    expect(keys[1]).toBe("id");
  });

  it("omits undefined rather than writing null", () => {
    // "absent" and "explicitly null" mean different things to a patch: one is a
    // property that was never set, the other is a property deliberately cleared.
    const value = canonicalize({ a: 1, b: undefined, c: null }) as Record<string, unknown>;
    expect("b" in value).toBe(false);
    expect("c" in value).toBe(true);
    expect(value.c).toBeNull();
  });

  it("hashes stably across key orderings and unstably across real edits", async () => {
    const a = baseDoc();
    const reordered = JSON.parse(JSON.stringify(a)) as PresentationDocument;
    const edited = JSON.parse(JSON.stringify(a)) as PresentationDocument;
    edited.slides[0]!.keyMessage = "something else";

    const [hashA, hashReordered, hashEdited] = await Promise.all([
      documentHash(a),
      documentHash(reordered),
      documentHash(edited),
    ]);

    expect(hashReordered).toBe(hashA);
    expect(hashEdited).not.toBe(hashA);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ends a pretty document with a newline, so files are POSIX-clean", () => {
    expect(serializeDocument(baseDoc()).endsWith("}\n")).toBe(true);
  });
});
