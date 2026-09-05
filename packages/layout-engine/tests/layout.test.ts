import { describe, expect, it } from "vitest";
import type { ContainerLayout, LayoutConstraint, Rect } from "@deckastra/presentation-schema";

import {
  EstimatingMeasurer,
  MeasurementCache,
  MAX_ITERATIONS,
  contains,
  intersects,
  measurementKey,
  quantizeFontSize,
  resolveConstraints,
  resolveContainer,
  resolveFit,
  validateLayout,
  type ConstrainedElement,
} from "../src/index";

const measurer = new EstimatingMeasurer();
const typography = { fontFamily: "Inter", fontSize: 24 };

// ------------------------------------------------------------------ measuring

describe("measurement", () => {
  it("is deterministic", () => {
    const input = { text: "Hello there, world", typography, maxWidth: 200 };
    expect(measurer.measure(input)).toEqual(measurer.measure(input));
  });

  it("flags estimates so exports know to re-measure", () => {
    expect(measurer.measure({ text: "x", typography, maxWidth: 100 }).estimated).toBe(true);
  });

  it("wraps: a narrower box needs more lines", () => {
    const text = "A sentence long enough that it has to wrap more than once";
    const wide = measurer.measure({ text, typography, maxWidth: 600 });
    const narrow = measurer.measure({ text, typography, maxWidth: 150 });
    expect(narrow.lineCount).toBeGreaterThan(wide.lineCount);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  it("treats explicit newlines as line breaks", () => {
    const metrics = measurer.measure({ text: "one\ntwo\nthree", typography, maxWidth: 900 });
    expect(metrics.lineCount).toBe(3);
  });
});

describe("measurement cache key", () => {
  it("changes when anything that affects metrics changes", () => {
    const base = { text: "abc", typography, maxWidth: 100 };
    const key = measurementKey(base, 0);

    const variants = [
      { ...base, text: "abd" },
      { ...base, maxWidth: 101 },
      { ...base, typography: { ...typography, fontSize: 25 } },
      { ...base, typography: { ...typography, fontWeight: 700 } },
      { ...base, typography: { ...typography, letterSpacing: 1 } },
      { ...base, typography: { ...typography, lineHeight: 1.6 } },
      { ...base, locale: "ja" },
    ];

    // A key missing an input produces the worst kind of bug: correct on a cold
    // cache, wrong on a warm one.
    for (const variant of variants) expect(measurementKey(variant, 0)).not.toBe(key);

    // And a font load must invalidate everything measured against a fallback.
    expect(measurementKey(base, 1)).not.toBe(key);
  });
});

describe("measurement cache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new MeasurementCache(2);
    const metrics = measurer.measure({ text: "x", typography, maxWidth: 100 });

    cache.set("a", metrics);
    cache.set("b", metrics);
    cache.get("a");
    cache.set("c", metrics);

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});

// ------------------------------------------------------------------ fit modes

describe("fit modes", () => {
  const longText = "A headline that is considerably longer than the box it has been given";

  it("autoHeight derives height and never overflows vertically", () => {
    const result = resolveFit(
      { content: longText, typography, box: { width: 300, height: 40 }, fit: "autoHeight" },
      measurer,
    );
    expect(result.height).toBeGreaterThan(40);
    expect(result.overflow).toBe(false);
    expect(result.fontSize).toBe(typography.fontSize);
  });

  it("fixed reports overflow rather than clipping silently", () => {
    // A deck that looks fine in the editor and truncates in a PDF is the failure
    // this rule exists to prevent (doc 04 §17.6).
    const result = resolveFit(
      { content: longText, typography, box: { width: 200, height: 30 }, fit: "fixed" },
      measurer,
    );
    expect(result.overflow).toBe(true);
    expect(result.height).toBe(30);
  });

  it("shrinkToFit reduces the size until it fits", () => {
    const result = resolveFit(
      {
        content: longText,
        typography: { ...typography, fontSize: 64 },
        box: { width: 400, height: 120 },
        fit: "shrinkToFit",
        minFontSize: 12,
      },
      measurer,
    );
    expect(result.fontSize).toBeLessThan(64);
    expect(result.fontSize).toBeGreaterThanOrEqual(12);
    expect(result.overflow).toBe(false);
  });

  it("shrinkToFit leaves the size alone when it already fits", () => {
    const result = resolveFit(
      { content: "Short", typography, box: { width: 800, height: 200 }, fit: "shrinkToFit" },
      measurer,
    );
    expect(result.fontSize).toBe(typography.fontSize);
  });

  it("shrinkToFit still flags overflow once the floor is reached", () => {
    const result = resolveFit(
      {
        content: longText.repeat(6),
        typography: { ...typography, fontSize: 48 },
        box: { width: 120, height: 40 },
        fit: "shrinkToFit",
        minFontSize: 32,
      },
      measurer,
    );
    expect(result.fontSize).toBe(32);
    expect(result.overflow).toBe(true);
  });

  it("quantizes to 0.25px, and never rounds up past the fit", () => {
    // Without quantization two runs on slightly different float paths produce
    // 47.9994 and 48.0001, and the visual regression suite flaps.
    for (const value of [47.9994, 48.0001, 12.13, 63.99]) {
      const quantized = quantizeFontSize(value);
      expect(quantized * 4).toBeCloseTo(Math.round(quantized * 4), 6);
      expect(quantized).toBeLessThanOrEqual(value);
    }
  });

  it("is deterministic across repeated runs", () => {
    const input = {
      content: longText,
      typography: { ...typography, fontSize: 56 },
      box: { width: 320, height: 90 },
      fit: "shrinkToFit" as const,
    };
    expect(resolveFit(input, measurer).fontSize).toBe(resolveFit(input, measurer).fontSize);
  });
});

// ------------------------------------------------------------------ containers

const box = { width: 1000, height: 400 };
const children = [
  { id: "a", width: 200, height: 100 },
  { id: "b", width: 200, height: 140 },
  { id: "c", width: 200, height: 80 },
];

describe("container layout", () => {
  it("lays a horizontal row out left to right with the gap between", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 20 };
    const result = resolveContainer({ layout, box, children });

    expect(result.children.map((c) => c.x)).toEqual([0, 220, 440]);
    expect(result.children.every((c) => c.y === 0)).toBe(true);
  });

  it("distributes equally, which is what makes a row of cards a row of cards", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 20, distribute: "equal" };
    const result = resolveContainer({ layout, box, children });

    const widths = result.children.map((c) => c.width);
    expect(new Set(widths).size).toBe(1);
    // Three equal cards plus two gaps fill the box exactly.
    expect(widths[0]! * 3 + 40).toBeCloseTo(1000, 1);
  });

  it("survives a child whose content grew, which absolute boxes would not", () => {
    // The whole point of doc 02 §21.2: a container re-flows, absolute boxes overlap.
    const layout: ContainerLayout = { type: "vertical", gap: 12 };
    const grown = [
      { id: "a", width: 400, height: 100 },
      { id: "b", width: 400, height: 260 },
      { id: "c", width: 400, height: 60 },
    ];
    const result = resolveContainer({ layout, box, children: grown });

    expect(result.children.map((c) => c.y)).toEqual([0, 112, 384]);
    // No two children overlap.
    for (let i = 0; i < result.children.length - 1; i += 1) {
      const current = result.children[i]!;
      const next = result.children[i + 1]!;
      expect(current.y + current.height).toBeLessThanOrEqual(next.y);
    }
  });

  it("respects padding", () => {
    const layout: ContainerLayout = {
      type: "horizontal",
      gap: 10,
      padding: { top: 30, right: 40, bottom: 30, left: 50 },
    };
    const result = resolveContainer({ layout, box, children });

    expect(result.children[0]!.x).toBe(50);
    expect(result.children[0]!.y).toBe(30);
  });

  it("stretches on the cross axis when asked", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 10, align: "stretch" };
    const result = resolveContainer({ layout, box, children });
    expect(result.children.every((c) => c.height === box.height)).toBe(true);
  });

  it("centres on the cross axis", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 10, align: "center" };
    const result = resolveContainer({ layout, box, children });
    expect(result.children[0]!.y).toBeCloseTo((400 - 100) / 2, 1);
  });

  it("spreads with spaceBetween", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 0, justify: "spaceBetween" };
    const result = resolveContainer({ layout, box, children });

    expect(result.children[0]!.x).toBe(0);
    expect(result.children.at(-1)!.x + result.children.at(-1)!.width).toBeCloseTo(1000, 1);
  });

  it("lays a grid out in rows, sized by the tallest child in each", () => {
    const layout: ContainerLayout = { type: "grid", columns: 2, gap: 10 };
    const result = resolveContainer({
      layout,
      box,
      children: [...children, { id: "d", width: 200, height: 60 }],
    });

    expect(result.children[0]!.y).toBe(0);
    expect(result.children[1]!.y).toBe(0);
    // Second row starts below the taller of the first row's children.
    expect(result.children[2]!.y).toBe(150);
  });

  it("overlays a stack", () => {
    const layout: ContainerLayout = { type: "stack", align: "stretch" };
    const result = resolveContainer({ layout, box, children });

    expect(result.children.every((c) => c.x === 0 && c.y === 0)).toBe(true);
    expect(result.children.every((c) => c.width === box.width)).toBe(true);
  });

  it("leaves free containers alone — the escape hatch", () => {
    const result = resolveContainer({ layout: { type: "free" }, box, children });
    expect(result.children.every((c) => c.x === 0 && c.y === 0)).toBe(true);
  });

  it("reports overflow when children do not fit", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 20 };
    const result = resolveContainer({
      layout,
      box: { width: 300, height: 200 },
      children,
    });
    expect(result.overflow).toBe(true);
  });

  it("is deterministic", () => {
    const layout: ContainerLayout = { type: "horizontal", gap: 17, justify: "spaceAround" };
    const a = resolveContainer({ layout, box, children });
    const b = resolveContainer({ layout, box, children });
    expect(a).toEqual(b);
  });
});

// ----------------------------------------------------------------- constraints

const slide: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

function element(
  id: string,
  rect: Rect,
  constraints?: LayoutConstraint[],
): ConstrainedElement {
  return { id, rect, constraints };
}

describe("constraint resolution", () => {
  it("aligns to another element", () => {
    const elements = [
      element("anchor", { x: 200, y: 100, width: 400, height: 200 }),
      element("follower", { x: 0, y: 500, width: 300, height: 100 }, [
        { type: "align", axis: "left", targetId: "anchor" },
      ]),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    expect(rects.get("follower")!.x).toBe(200);
    // Only the constrained axis moves.
    expect(rects.get("follower")!.y).toBe(500);
  });

  it("centres on the slide", () => {
    const elements = [
      element("centred", { x: 0, y: 0, width: 400, height: 200 }, [
        { type: "align", axis: "centerX", targetId: "slide" },
      ]),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    expect(rects.get("centred")!.x).toBe((1920 - 400) / 2);
  });

  it("keeps a caption a fixed distance below its image", () => {
    const elements = [
      element("image", { x: 100, y: 100, width: 600, height: 400 }),
      element("caption", { x: 100, y: 900, width: 600, height: 60 }, [
        { type: "distance", edge: "top", targetId: "image", targetEdge: "bottom", value: 16 },
      ]),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    expect(rects.get("caption")!.y).toBe(516);
  });

  it("anchors a footer to the slide's bottom edge", () => {
    const elements = [
      element("footer", { x: 0, y: 0, width: 400, height: 40 }, [
        {
          type: "anchor",
          anchor: "slide",
          edges: ["bottom", "left"],
          insets: { top: 0, right: 0, bottom: 40, left: 60 },
        },
      ]),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    const footer = rects.get("footer")!;
    expect(footer.x).toBe(60);
    expect(footer.y).toBe(1080 - 40 - 40);
  });

  it("stretches when opposite edges are both anchored", () => {
    const elements = [
      element("band", { x: 0, y: 500, width: 100, height: 80 }, [
        {
          type: "anchor",
          anchor: "slide",
          edges: ["left", "right"],
          insets: { top: 0, right: 120, bottom: 0, left: 120 },
        },
      ]),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    expect(rects.get("band")!.x).toBe(120);
    expect(rects.get("band")!.width).toBe(1920 - 240);
  });

  it("keeps an element inside its container", () => {
    const elements = [
      element("card", { x: 100, y: 100, width: 800, height: 400 }),
      element("inner", { x: 5000, y: 100, width: 200, height: 100 }, [
        { type: "containment", containerId: "card" },
      ]),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    const inner = rects.get("inner")!;
    expect(inner.x + inner.width).toBeLessThanOrEqual(900);
  });

  it("evaluates dependencies before dependents", () => {
    // c depends on b, b depends on a. Declared in reverse so only the topological
    // sort can produce the right answer.
    const elements = [
      element("c", { x: 0, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "b", offset: 10 },
      ]),
      element("b", { x: 0, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "a", offset: 10 },
      ]),
      element("a", { x: 500, y: 0, width: 100, height: 50 }),
    ];

    const { rects } = resolveConstraints(elements, { slide });
    expect(rects.get("b")!.x).toBe(510);
    expect(rects.get("c")!.x).toBe(520);
  });

  it("breaks a cycle by dropping the lowest-priority constraint, and says so", () => {
    // Two elements each positioned relative to the other has no solution. Which
    // one loses must be predictable, which is what priorities are for.
    const elements = [
      element("a", { x: 0, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "b", priority: "weak" },
      ]),
      element("b", { x: 300, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "a", priority: "strong" },
      ]),
    ];

    const result = resolveConstraints(elements, { slide });

    expect(result.warnings.some((w) => w.code === "cycle-broken")).toBe(true);
    expect(result.brokenConstraintIds.length).toBe(1);
    // The weak one was suspended, so the strong one still applies.
    expect(result.brokenConstraintIds[0]).toContain("a:");
  });

  it("reports irreconcilable required constraints rather than picking one", () => {
    const elements = [
      element("a", { x: 0, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "b", priority: "required" },
      ]),
      element("b", { x: 300, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "a", priority: "required" },
      ]),
    ];

    const result = resolveConstraints(elements, { slide });
    expect(result.warnings.some((w) => w.code === "conflicting-required")).toBe(true);
  });

  it("terminates on a cycle rather than hanging", () => {
    const elements = [
      element("a", { x: 0, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "b" },
      ]),
      element("b", { x: 0, y: 0, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "a" },
      ]),
    ];

    const result = resolveConstraints(elements, { slide });
    expect(result.iterations).toBeLessThanOrEqual(MAX_ITERATIONS);
  });

  it("skips a constraint whose target is not on the slide, with a warning", () => {
    const elements = [
      element("a", { x: 10, y: 10, width: 100, height: 50 }, [
        { type: "align", axis: "left", targetId: "el_gone" },
      ]),
    ];

    const result = resolveConstraints(elements, { slide });
    expect(result.rects.get("a")!.x).toBe(10);
    expect(result.warnings.some((w) => w.code === "unresolved-target")).toBe(true);
  });

  it("is deterministic regardless of declaration order among independents", () => {
    const build = (order: string[]) =>
      order.map((id, i) =>
        element(id, { x: i * 100, y: 0, width: 80, height: 40 }, [
          { type: "align", axis: "top", targetId: "slide", offset: 20 },
        ]),
      );

    const forward = resolveConstraints(build(["a", "b", "c"]), { slide });
    const backward = resolveConstraints(build(["c", "b", "a"]), { slide });

    for (const id of ["a", "b", "c"]) {
      expect(forward.rects.get(id)!.y).toBe(backward.rects.get(id)!.y);
    }
  });

  it("never collapses an element below its minimum size", () => {
    const elements: ConstrainedElement[] = [
      {
        id: "a",
        rect: { x: 0, y: 0, width: 200, height: 100 },
        minWidth: 50,
        minHeight: 24,
        constraints: [{ type: "aspectRatio", ratio: 100 }],
      },
    ];

    const { rects } = resolveConstraints(elements, { slide });
    expect(rects.get("a")!.height).toBeGreaterThanOrEqual(24);
  });
});

// ------------------------------------------------------------------ validation

describe("layout validation", () => {
  const safeArea: Rect = { x: 120, y: 80, width: 1680, height: 920 };

  it("counts overlaps between real content", () => {
    const result = validateLayout({
      slide,
      elements: [
        { id: "a", bounds: { x: 100, y: 100, width: 300, height: 200 } },
        { id: "b", bounds: { x: 250, y: 150, width: 300, height: 200 } },
      ],
    });

    expect(result.overlapCount).toBe(1);
    expect(result.overlappingPairs[0]).toEqual(["a", "b"]);
  });

  it("ignores decoration overlaps", () => {
    // A background flourish over a headline is intentional; flagging it every
    // time trains people to ignore warnings.
    const result = validateLayout({
      slide,
      elements: [
        { id: "art", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, semanticRole: "decoration" },
        { id: "headline", bounds: { x: 200, y: 200, width: 800, height: 120 }, semanticRole: "headline" },
      ],
    });

    expect(result.overlapCount).toBe(0);
  });

  it("ignores text sitting on a filled card", () => {
    // The single most common layout in any deck.
    const result = validateLayout({
      slide,
      elements: [
        { id: "card", bounds: { x: 100, y: 100, width: 600, height: 300 }, hasFill: true },
        { id: "label", bounds: { x: 140, y: 140, width: 400, height: 60 } },
      ],
    });

    expect(result.overlapCount).toBe(0);
  });

  it("finds elements outside the slide", () => {
    const result = validateLayout({
      slide,
      elements: [
        { id: "inside", bounds: { x: 100, y: 100, width: 200, height: 100 } },
        { id: "outside", bounds: { x: 5000, y: 100, width: 200, height: 100 } },
      ],
    });

    expect(result.outOfBoundsIds).toContain("outside");
    expect(result.outOfBoundsIds).not.toContain("inside");
  });

  it("reports safe-area breaks separately, because they are often deliberate", () => {
    const result = validateLayout({
      slide,
      safeArea,
      elements: [{ id: "hero", bounds: { x: 0, y: 0, width: 1920, height: 600 } }],
    });

    expect(result.outsideSafeAreaIds).toContain("hero");
    expect(result.outOfBoundsIds).not.toContain("hero");
  });

  it("counts overflow and distinct type sizes", () => {
    const result = validateLayout({
      slide,
      elements: [
        { id: "a", bounds: { x: 0, y: 0, width: 100, height: 50 }, overflow: true, fontSize: 24 },
        { id: "b", bounds: { x: 200, y: 0, width: 100, height: 50 }, fontSize: 24 },
        { id: "c", bounds: { x: 400, y: 0, width: 100, height: 50 }, fontSize: 64 },
      ],
    });

    expect(result.overflowCount).toBe(1);
    expect(result.distinctFontSizes).toBe(2);
    expect(result.minFontSize).toBe(24);
    expect(result.warnings.some((w) => w.includes("does not fit"))).toBe(true);
  });

  it("skips hidden elements entirely", () => {
    const result = validateLayout({
      slide,
      elements: [
        { id: "a", bounds: { x: 100, y: 100, width: 300, height: 200 } },
        { id: "b", bounds: { x: 150, y: 150, width: 300, height: 200 }, hidden: true },
      ],
    });

    expect(result.overlapCount).toBe(0);
  });
});

describe("geometry helpers", () => {
  it("intersects and contains agree with intuition", () => {
    const outer: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const inner: Rect = { x: 10, y: 10, width: 50, height: 50 };
    const apart: Rect = { x: 200, y: 200, width: 10, height: 10 };

    expect(contains(outer, inner)).toBe(true);
    expect(contains(inner, outer)).toBe(false);
    expect(intersects(outer, inner)).toBe(true);
    expect(intersects(outer, apart)).toBe(false);
  });
});
