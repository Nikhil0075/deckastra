import { describe, expect, it } from "vitest";

import {
  buildDocumentScene,
  buildSlideScene,
  flattenScene,
  localMatrix,
  multiply,
  resolveTheme,
  resolveValue,
  shapeGeometry,
  transformedBounds,
  EstimatingTextMeasurer,
  IDENTITY,
  type SceneNode,
} from "../src/index";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";

const technical = loadFixture("technical");
const animation = loadFixture("animation");

describe("matrix", () => {
  it("places an unrotated element at its top-left", () => {
    const m = localMatrix({ x: 100, y: 50, width: 200, height: 80 });
    expect(m.e).toBeCloseTo(100);
    expect(m.f).toBeCloseTo(50);
  });

  it("rotates about the element centre, not its corner", () => {
    // Default origin is 0.5/0.5 (doc 02 §10). Rotating about the corner instead
    // makes every rotated element drift as it resizes.
    const m = localMatrix({ x: 0, y: 0, width: 100, height: 100, rotation: 90 });
    const bounds = transformedBounds(m, 100, 100);
    expect(bounds.x).toBeCloseTo(0, 5);
    expect(bounds.y).toBeCloseTo(0, 5);
    expect(bounds.width).toBeCloseTo(100, 5);
  });

  it("expands axis-aligned bounds under rotation", () => {
    const m = localMatrix({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    const bounds = transformedBounds(m, 100, 100);
    // A 45-degree square measures 100*sqrt(2) across. Computing bounds from two
    // corners instead of four would report 100 and clip the element.
    expect(bounds.width).toBeCloseTo(141.42, 1);
  });

  it("expresses flip as negative scale", () => {
    const m = localMatrix({ x: 0, y: 0, width: 100, height: 50, scaleX: -1 });
    expect(m.a).toBeLessThan(0);
  });

  it("composes group transforms top-down", () => {
    const parent = localMatrix({ x: 100, y: 100, width: 500, height: 500 });
    const child = localMatrix({ x: 20, y: 30, width: 50, height: 50 });
    const world = multiply(parent, child);
    // A child's transform is expressed in the group's space (doc 02 §10.3).
    expect(world.e).toBeCloseTo(120);
    expect(world.f).toBeCloseTo(130);
  });
});

describe("theme resolution", () => {
  const theme = resolveTheme(technical.theme);

  it("flattens tokens to concrete values", () => {
    expect(theme.tokens.get("colors.accent")).toBe("#4CC2FF");
    expect(theme.tokens.get("typography.h1.fontSize")).toBe(64);
  });

  it("keeps composite tokens whole, so token:typography.h1 means the whole style", () => {
    const h1 = theme.tokens.get("typography.h1") as { fontSize: number };
    expect(h1.fontSize).toBe(64);
  });

  it("keeps ordered arrays intact rather than splitting them into indexed keys", () => {
    // Chart series assignment must be deterministic: series 0 takes index 0.
    const series = theme.tokens.get("colors.chartSeries") as string[];
    expect(Array.isArray(series)).toBe(true);
    expect(series[0]).toBe("#4CC2FF");
  });

  it("resolves token references and passes literals through", () => {
    expect(resolveValue(theme, "token:colors.accent")).toBe("#4CC2FF");
    expect(resolveValue(theme, "#ff0000")).toBe("#ff0000");
  });

  it("falls back rather than throwing on a dangling token", () => {
    // Throwing here would blank a slide over a typo. The validator already reports
    // unresolvable tokens as E202, which is the right place to fail loudly.
    expect(resolveValue(theme, "token:colors.nope", "#000")).toBe("#000");
  });
});

describe("shape geometry", () => {
  it("resolves every shape to a path, rectangles included", () => {
    for (const shape of ["rectangle", "ellipse", "triangle", "diamond", "star", "polygon", "arrow"]) {
      const geometry = shapeGeometry({ shape, width: 100, height: 60 });
      expect(geometry.pathData.length, shape).toBeGreaterThan(0);
      expect(geometry.pathData.startsWith("M"), shape).toBe(true);
    }
  });

  it("gives a pill a radius the style cannot override away", () => {
    const geometry = shapeGeometry({ shape: "pill", width: 200, height: 60 });
    expect(geometry.radiusOverride).toBe(30);
  });

  it("degrades an unknown shape kind to a rectangle", () => {
    const geometry = shapeGeometry({ shape: "hypercube", width: 100, height: 100 });
    expect(geometry.preferRect).toBe(true);
    expect(geometry.pathData.length).toBeGreaterThan(0);
  });

  it("scales a normalized custom path into the element box", () => {
    const geometry = shapeGeometry({
      shape: "customPath",
      width: 200,
      height: 100,
      pathData: "M0,0 L1,0 L1,1 Z",
    });
    expect(geometry.pathData).toContain("200");
    expect(geometry.pathData).toContain("100");
  });

  it("survives customPath with no pathData rather than crashing the slide", () => {
    expect(shapeGeometry({ shape: "customPath", width: 100, height: 100 }).pathData).toBe("");
  });
});

describe("text measurement", () => {
  const measurer = new EstimatingTextMeasurer();
  const content = {
    version: 1 as const,
    blocks: [
      {
        id: "blk_01JB8Z9K2QW4RN7F3XG5HTMD6A",
        type: "paragraph" as const,
        spans: [{ text: "A reasonably long headline that will need more than one line" }],
      },
    ],
  };

  it("is deterministic", () => {
    const request = {
      content,
      typography: { fontFamily: "Inter", fontSize: 48 },
      maxWidth: 600,
      maxHeight: 200,
      fit: "fixed" as const,
    };
    expect(measurer.measure(request)).toEqual(measurer.measure(request));
  });

  it("flags its results as estimated so exports know to re-measure", () => {
    const metrics = measurer.measure({
      content,
      typography: { fontFamily: "Inter", fontSize: 48 },
      maxWidth: 600,
      maxHeight: 200,
      fit: "fixed",
    });
    expect(metrics.estimated).toBe(true);
  });

  it("shrinks to fit down to the floor and quantizes the result", () => {
    const metrics = measurer.measure({
      content,
      typography: { fontFamily: "Inter", fontSize: 96 },
      maxWidth: 400,
      maxHeight: 120,
      fit: "shrinkToFit",
      minFontSize: 24,
    });

    expect(metrics.appliedFontSize).toBeLessThan(96);
    expect(metrics.appliedFontSize).toBeGreaterThanOrEqual(24);
    // Quantized to 0.25px: without it, two runs land on sizes differing in the
    // eighth decimal and produce spurious diffs (doc 04 §17.3).
    expect(metrics.appliedFontSize * 4).toBeCloseTo(Math.round(metrics.appliedFontSize * 4), 6);
  });

  it("reports overflow rather than silently clipping", () => {
    const metrics = measurer.measure({
      content,
      typography: { fontFamily: "Inter", fontSize: 96 },
      maxWidth: 200,
      maxHeight: 40,
      fit: "fixed",
    });
    expect(metrics.overflow).toBe(true);
  });
});

describe("scene building", () => {
  const scene = buildDocumentScene(technical);

  it("builds a scene per slide", () => {
    expect(scene.slides).toHaveLength(technical.slides.length);
    expect(scene.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("keeps node ids equal to document element ids", () => {
    // Stability here is what lets selection, animation targets and provenance
    // survive a rebuild.
    const nodes = flattenScene(scene.slides[0]!);
    const documentIds = new Set<string>();
    const walk = (elements: readonly { id: string; children?: readonly never[] }[]) => {
      for (const el of elements) {
        documentIds.add(el.id);
        if ("children" in el && el.children) walk(el.children);
      }
    };
    walk(technical.slides[0]!.elements as never);

    for (const node of nodes) expect(documentIds.has(node.id)).toBe(true);
  });

  it("composes world transforms through groups", () => {
    const kpiSlide = scene.slides[1]!;
    const nodes = flattenScene(kpiSlide);
    const row = nodes.find((n) => n.type === "group" && n.name === "KPI row")!;
    const card = row.children![0]!;
    const label = card.children![0]!;

    // The label's world position must include the row's and the card's offsets.
    // Recomputing this by walking up per query is O(depth) per hit test and shows
    // up immediately in marquee selection (doc 04 §8.2).
    expect(label.worldTransform.e).toBeGreaterThanOrEqual(row.worldTransform.e);
    expect(label.worldTransform.f).toBeGreaterThanOrEqual(row.worldTransform.f);
  });

  it("assigns a zPath whose sort is the paint order", () => {
    const slide = scene.slides[0]!;
    const nodes = flattenScene(slide);
    expect(slide.paintOrder).toHaveLength(nodes.length);

    // Every node appears exactly once, so painting cannot drop or duplicate one.
    expect(new Set(slide.paintOrder).size).toBe(nodes.length);
  });

  it("nests a child's zPath under its parent, so a child cannot escape its group", () => {
    const nodes = flattenScene(scene.slides[1]!);
    const group = nodes.find((n) => n.type === "group" && n.children?.length)!;
    const child = group.children![0]!;

    expect(child.zPath.slice(0, group.zPath.length)).toEqual(group.zPath);
  });

  it("assigns layers by type, not by preference", () => {
    const byType = new Map<string, string>();
    for (const slide of scene.slides) {
      for (const node of flattenScene(slide)) byType.set(node.type, node.layer);
    }
    expect(byType.get("text")).toBe("content");
    expect(byType.get("diagram")).toBe("vector");
  });

  it("orders accessibility by semantic role, not by z-order", () => {
    const nodes = flattenScene(scene.slides[0]!);
    const headline = nodes.find((n) => n.semanticRole === "headline")!;
    const eyebrow = nodes.find((n) => n.semanticRole === "eyebrow")!;
    const subtitle = nodes.find((n) => n.semanticRole === "subtitle")!;

    // Eyebrow reads before headline reads before subtitle, whatever order they
    // happen to be painted in (doc 04 §8.4).
    expect(eyebrow.a11y.order).toBeLessThan(headline.a11y.order);
    expect(headline.a11y.order).toBeLessThan(subtitle.a11y.order);
  });

  it("resolves tokens into concrete style values", () => {
    const nodes = flattenScene(scene.slides[1]!);
    const card = nodes.find((n) => n.resolvedStyle.fill)!;
    // No "token:" survives into the scene — an export adapter has no business
    // re-deriving what a token meant.
    expect(card.resolvedStyle.fill).not.toContain("token:");
    expect(card.resolvedStyle.fill).toMatch(/^#|rgb|linear-gradient/);
  });

  it("renders unimplemented element types as placeholders instead of dropping them", () => {
    // Video is in the schema and deferred past MVP (doc 02 §37.1), so it still
    // takes this path. It is the placeholder's remaining live case now that
    // charts, diagrams and icons draw for real.
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    doc.slides[0]!.elements.push({
      id: "el_01JB8Z9K2QW4RN7F3XG5HTMD88",
      type: "video",
      name: "Product tour",
      transform: { x: 10, y: 10, width: 100, height: 100 },
      assetId: "ast_01JB8Z9K2QW4RN7F3XG5HTMD87",
    } as never);

    const nodes = flattenScene(buildDocumentScene(doc).slides[0]!);
    const video = nodes.find((n) => n.type === "video")!;
    expect(video.renderPayload.kind).toBe("placeholder");
    // Not marked unsupported: the schema knows this type, the renderer just has
    // not implemented it yet. The distinction matters for the message shown.
    expect(video.flags.unsupported).toBe(false);
  });

  it("marks an element type it does not know as unsupported, and keeps it", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    doc.slides[0]!.elements.push({
      id: "el_01JB8Z9K2QW4RN7F3XG5HTMD99",
      type: "hologram",
      transform: { x: 10, y: 10, width: 100, height: 100 },
    } as never);

    const nodes = flattenScene(buildDocumentScene(doc).slides[0]!);
    const unknown = nodes.find((n) => n.type === "hologram")!;
    expect(unknown).toBeDefined();
    expect(unknown.flags.unsupported).toBe(true);
    expect(unknown.renderPayload.kind).toBe("placeholder");
  });

  it("flags elements that fall outside the slide", () => {
    const doc = JSON.parse(JSON.stringify(technical)) as PresentationDocument;
    doc.slides[0]!.elements[0]!.transform.x = 5000;

    const nodes = flattenScene(buildDocumentScene(doc).slides[0]!);
    expect(nodes[0]!.flags.outOfBounds).toBe(true);
  });

  it("carries transition, speaker notes and animations onto the scene", () => {
    const animScene = buildDocumentScene(animation);

    // By name, not by index: the fixture gains slides as the animation surface
    // grows, and a positional assertion here fails for a reason that has nothing
    // to do with what it is checking.
    const zoomed = animScene.slides.find((slide) => slide.name === "Transition target")!;
    expect(zoomed.transition?.type).toBe("zoom");

    // Animations ride on the scene unresolved (doc 04 §22.1): the renderer does
    // not compile timelines, but present mode and the export drive motion from a
    // scene alone, so the tracks have to arrive with it.
    const sequenced = animScene.slides.find((slide) => slide.name === "Sequenced entrance")!;
    expect(sequenced.animations).toHaveLength(4);
  });

  it("is deterministic: two builds of the same document match", () => {
    const a = buildSlideScene(technical, technical.slides[0]!, 0, resolveTheme(technical.theme));
    const b = buildSlideScene(technical, technical.slides[0]!, 0, resolveTheme(technical.theme));

    const strip = (node: SceneNode): unknown => ({
      id: node.id,
      transform: node.worldTransform,
      bounds: node.bounds,
      style: node.resolvedStyle,
      payload: node.renderPayload,
    });

    expect(flattenScene(a).map(strip)).toEqual(flattenScene(b).map(strip));
  });

  it("never leaks editor state into the scene", () => {
    // The scene is disposable and derived; it is also the input to export, so a
    // stray camera or selection value here would reach a PDF.
    const json = JSON.stringify(scene.slides[0]);
    for (const forbidden of ["camera", "selection", "hovered", "zoom"]) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
  });
});

describe("identity", () => {
  it("exports an identity matrix that composes to a no-op", () => {
    const m = localMatrix({ x: 5, y: 7, width: 10, height: 10 });
    expect(multiply(IDENTITY, m)).toEqual(m);
  });
});
