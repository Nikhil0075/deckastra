import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MECHANICALLY_FIXABLE,
  REQUIRES_RENDER_CONTEXT,
  RULES,
  newId,
  validateDocument,
  walkElements,
  type PresentationDocument,
  type ValidationReport,
} from "../src/index";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function baseDoc(): PresentationDocument {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "technical-deck.mydeck.json"), "utf8"),
  ) as PresentationDocument;
}

function codes(report: ValidationReport): string[] {
  return [...report.errors, ...report.warnings].map((i) => i.code);
}

describe("rule catalog", () => {
  it("every rule has a severity consistent with its code prefix", () => {
    for (const [code, rule] of Object.entries(RULES)) {
      const expected = code.startsWith("E") ? "error" : "warning";
      expect(rule.severity, `${code} severity`).toBe(expected);
    }
  });

  it("every declared rule has a non-empty summary", () => {
    for (const [code, rule] of Object.entries(RULES)) {
      expect(rule.summary.length, `${code} summary`).toBeGreaterThan(10);
    }
  });

  it("mechanically-fixable and render-context rules all exist in the catalog", () => {
    for (const code of [...MECHANICALLY_FIXABLE, ...REQUIRES_RENDER_CONTEXT]) {
      expect(RULES[code], `${code} is referenced but not in the catalog`).toBeDefined();
    }
  });
});

describe("structural rules", () => {
  it("validates document byte limits without Node Buffer", () => {
    const globals = globalThis as typeof globalThis & { Buffer?: unknown };
    const previous = globals.Buffer;
    Reflect.deleteProperty(globals, "Buffer");
    let report: ValidationReport;
    try {
      report = validateDocument(baseDoc());
    } finally {
      globals.Buffer = previous;
    }
    expect(report!.valid).toBe(true);
  });

  it("E001: rejects a duplicate id", () => {
    const doc = baseDoc();
    const slide = doc.slides[0]!;
    const first = slide.elements[0]!;
    slide.elements.push({ ...first });

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E001");
    // The message must name the offending id — a validator that says "duplicate
    // id somewhere" costs more time than it saves.
    expect(report.errors.find((e) => e.code === "E001")!.message).toContain(first.id);
  });

  it("E006: rejects non-finite geometry", () => {
    const doc = baseDoc();
    // JSON cannot carry NaN, but an in-memory document reaching the validator
    // after a bad computation absolutely can — which is exactly when it matters.
    (doc.slides[0]!.elements[0]!.transform as Record<string, number>).x = Number.NaN;

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E006");
  });

  it("E007: rejects a zero-size element", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements[0]!.transform.width = 0;

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    // width: 0 fails the schema's own min(1) as E003 before reaching the semantic
    // check; either way the document is refused, which is the guarantee that matters.
    expect(codes(report).some((c) => c === "E007" || c === "E003")).toBe(true);
  });

  it("E011: rejects updatedAt before createdAt", () => {
    const doc = baseDoc();
    doc.updatedAt = "2020-01-01T00:00:00Z";

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E011");
  });

  it("E008: rejects group nesting deeper than 8", () => {
    const doc = baseDoc();
    let innermost: Record<string, unknown> = {
      id: newId("el"),
      type: "group",
      transform: { x: 0, y: 0, width: 100, height: 100 },
      children: [],
    };
    const root = innermost;
    for (let i = 0; i < 9; i += 1) {
      const child: Record<string, unknown> = {
        id: newId("el"),
        type: "group",
        transform: { x: 0, y: 0, width: 100, height: 100 },
        children: [],
      };
      (innermost.children as unknown[]).push(child);
      innermost = child;
    }
    doc.slides[0]!.elements.push(root as never);

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E008");
  });
});

describe("referential rules", () => {
  it("E101: rejects an animation targeting a missing element", () => {
    const doc = baseDoc();
    doc.slides[0]!.animations = [
      {
        id: newId("anm"),
        targetId: newId("el"),
        trigger: { type: "slideEnter" },
        clips: [{ id: newId("clp"), preset: "fade", startMs: 0, durationMs: 300 }],
      },
    ];

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E101");
  });

  it("E102: rejects an image pointing at a missing asset", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements.push({
      id: newId("el"),
      type: "image",
      transform: { x: 0, y: 0, width: 100, height: 100 },
      assetId: newId("ast"),
      fit: "cover",
    } as never);

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E102");
  });

  it("E106: rejects a diagram edge pointing at a missing node", () => {
    const doc = baseDoc();
    const diagram = doc.slides
      .flatMap((s) => [...walkElements(s.elements)])
      .map(({ element }) => element)
      .find((el) => el.type === "diagram") as { edges: { id: string; from: string; to: string }[] };

    diagram.edges.push({ id: newId("edg"), from: newId("nd"), to: newId("nd") });

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E106");
  });

  it("E105: rejects goToSlide pointing at a missing slide", () => {
    const doc = baseDoc();
    doc.slides[0]!.interactions = [
      {
        id: newId("el"),
        trigger: { type: "click", targetId: doc.slides[0]!.elements[0]!.id },
        action: { type: "goToSlide", slideId: newId("sld") },
      },
    ];

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E105");
  });

  it("W105: a deleted anchor warns but does not invalidate the deck", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements.push({
      id: newId("el"),
      type: "line",
      transform: { x: 0, y: 0, width: 200, height: 2 },
      from: { elementId: newId("el"), anchor: "auto" },
      to: { x: 200, y: 0 },
    } as never);

    const report = validateDocument(doc);
    // Deleting a node must never silently delete its connectors — the user loses
    // work they did not ask to lose. Warn, keep the connector, let them fix it.
    expect(report.valid).toBe(true);
    expect(codes(report)).toContain("W105");
  });
});

describe("semantic rules", () => {
  it("E202: rejects a theme token that resolves nowhere", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements[0]!.style = {
      fill: { type: "solid", color: "token:colors.doesNotExist" },
    };

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E202");
  });

  it("E205: rejects a zero-duration clip", () => {
    const doc = baseDoc();
    const target = doc.slides[0]!.elements[0]!.id;
    doc.slides[0]!.animations = [
      {
        id: newId("anm"),
        targetId: target,
        trigger: { type: "slideEnter" },
        clips: [{ id: newId("clp"), preset: "fade", startMs: 0, durationMs: 0 }],
      },
    ];

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E205");
  });

  it("E204: rejects unsorted keyframes and offers a sorted fix", () => {
    const doc = baseDoc();
    const target = doc.slides[0]!.elements[0]!.id;
    doc.slides[0]!.animations = [
      {
        id: newId("anm"),
        targetId: target,
        trigger: { type: "slideEnter" },
        clips: [
          {
            id: newId("clp"),
            startMs: 0,
            durationMs: 400,
            propertyTracks: [
              {
                property: "opacity",
                keyframes: [
                  { offset: 1, value: 1 },
                  { offset: 0, value: 0 },
                ],
              },
            ],
          },
        ],
      },
    ];

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);

    const issue = report.errors.find((e) => e.code === "E204")!;
    // Sorting keyframes is mechanically derivable, so the validator must hand back
    // the repair rather than making an agent burn another model round-trip on it.
    expect(issue.suggestedFix).toBeDefined();
    const fixed = issue.suggestedFix![0] as { value: { keyframes: { offset: number }[] }[] };
    expect(fixed.value[0]!.keyframes.map((k) => k.offset)).toEqual([0, 1]);
  });

  it("E206: rejects a binding targeting a property outside the allowlist", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements[0]!.bindings = [
      // Rewriting `children` through a binding is a structural-integrity hazard,
      // which is the entire reason the allowlist exists.
      { sourceId: newId("src"), path: "$.value", targetProperty: "children" },
    ];

    const report = validateDocument(doc);
    expect(report.valid).toBe(false);
    expect(codes(report)).toContain("E206");
  });

  it("W101: warns about a second headline on a slide", () => {
    const doc = baseDoc();
    const slide = doc.slides[0]!;
    const clone = { ...slide.elements[0]!, id: newId("el"), semanticRole: "headline" as const };
    slide.elements.push(clone);

    const report = validateDocument(doc);
    expect(report.valid).toBe(true);
    expect(codes(report)).toContain("W101");
  });

  it("W131: warns when two clips animate the same property over overlapping time", () => {
    const doc = baseDoc();
    const target = doc.slides[0]!.elements[0]!.id;
    const clip = (id: string, startMs: number) => ({
      id,
      startMs,
      durationMs: 500,
      propertyTracks: [
        {
          property: "opacity" as const,
          keyframes: [
            { offset: 0, value: 0 },
            { offset: 1, value: 1 },
          ],
        },
      ],
    });

    doc.slides[0]!.animations = [
      {
        id: newId("anm"),
        targetId: target,
        trigger: { type: "slideEnter" },
        clips: [clip(newId("clp"), 0), clip(newId("clp"), 200)],
      },
    ];

    const report = validateDocument(doc);
    // Last-defined wins; values are never blended, because a blended result cannot
    // be reproduced by PPTX export or a video renderer.
    expect(codes(report)).toContain("W131");
  });

  it("W132: warns when a slide entrance overruns the motion budget", () => {
    const doc = baseDoc();
    const target = doc.slides[0]!.elements[0]!.id;
    doc.slides[0]!.animations = [
      {
        id: newId("anm"),
        targetId: target,
        trigger: { type: "slideEnter" },
        clips: [{ id: newId("clp"), preset: "fade", startMs: 0, durationMs: 6000 }],
      },
    ];

    const report = validateDocument(doc);
    expect(codes(report)).toContain("W132");
  });
});

describe("report shape", () => {
  it("splits errors and warnings by severity and never mixes them", () => {
    const doc = baseDoc();
    doc.updatedAt = "2020-01-01T00:00:00Z";

    const report = validateDocument(doc);
    expect(report.errors.every((i) => i.severity === "error")).toBe(true);
    expect(report.warnings.every((i) => i.severity !== "error")).toBe(true);
    expect(report.valid).toBe(report.errors.length === 0);
    expect(Date.parse(report.checkedAt)).not.toBeNaN();
  });

  it("gives every issue a path a client can navigate to", () => {
    const doc = baseDoc();
    doc.slides[0]!.elements.push({ ...doc.slides[0]!.elements[0]! });

    for (const issue of validateDocument(doc).errors) {
      expect(issue.path.startsWith("/"), `${issue.code} path "${issue.path}"`).toBe(true);
    }
  });
});
