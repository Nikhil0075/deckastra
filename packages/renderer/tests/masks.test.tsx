import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { MaskDefinition, PresentationDocument } from "@deckastra/presentation-schema";

import {
  buildSlideScene,
  cubicPath,
  flattenScene,
  maskImageCss,
  resolveImageMask,
  resolveTheme,
} from "../src/index";
import { MASK_SHAPES } from "@deckastra/presentation-schema";
import { SlideView } from "../src/react/index";

/** Every point a path names, controls included. */
function points(d: string): { x: number; y: number }[] {
  return cubicPath(d).flatMap((segment) =>
    segment.op === "Z" ? [] : segment.op === "C" ? [segment.c1, segment.c2, segment.to] : [segment.to],
  );
}

function bounds(d: string) {
  const all = points(d);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe("mask outlines", () => {
  it("draws every named shape as cubic outlines inside the box", () => {
    for (const shape of MASK_SHAPES) {
      const { mask, warning } = resolveImageMask({ type: "shape", shape }, 400, 300);
      expect(warning, shape).toBeUndefined();
      for (const d of mask!.paths) {
        // Only M, L, C and Z reach the consumers: arcs are already curves.
        expect(d, shape).toMatch(/^[MLCZ0-9.,\s-]+$/);
        const box = bounds(d);
        expect(box.left, shape).toBeGreaterThanOrEqual(-12);
        expect(box.right, shape).toBeLessThanOrEqual(412);
        expect(box.top, shape).toBeGreaterThanOrEqual(-12);
        expect(box.bottom, shape).toBeLessThanOrEqual(312);
      }
    }
  });

  it("keeps a circle round and centred in a box that is not square", () => {
    // A portrait picture in a landscape box: the frame is still a circle.
    const landscape = bounds(resolveImageMask({ type: "shape", shape: "circle" }, 400, 200).mask!.paths[0]!);
    expect(landscape).toEqual({ left: 100, right: 300, top: 0, bottom: 200 });
    const portrait = bounds(resolveImageMask({ type: "shape", shape: "circle" }, 200, 500).mask!.paths[0]!);
    expect(portrait).toEqual({ left: 0, right: 200, top: 150, bottom: 350 });
  });

  it("gives an arch a round top and a flat bottom", () => {
    const d = resolveImageMask({ type: "shape", shape: "arch" }, 200, 300).mask!.paths[0]!;
    expect(d.startsWith("M0,300 L0,100")).toBe(true);
    expect(bounds(d)).toEqual({ left: 0, right: 200, top: 0, bottom: 300 });
  });

  it("scales a custom path from 0..1 to the box and turns arcs into curves", () => {
    const d = resolveImageMask({ type: "path", pathData: "M0,1 L0,0.5 A0.5,0.5 0 0,1 1,0.5 L1,1 Z" }, 300, 200).mask!.paths[0]!;
    expect(d).not.toMatch(/A/);
    expect(d.startsWith("M0,200 L0,100")).toBe(true);
    expect(bounds(d).right).toBeCloseTo(300, 3);
  });

  it("turns the outline about the box centre and leaves the picture alone", () => {
    const flat = resolveImageMask({ type: "shape", shape: "triangle" }, 200, 200).mask!.paths[0]!;
    const turned = resolveImageMask({ type: "shape", shape: "triangle", rotation: 180 }, 200, 200).mask!.paths[0]!;
    expect(turned).not.toBe(flat);
    // Upside down: the apex that was at the top is now at the bottom.
    expect(points(flat)[0]).toEqual({ x: 100, y: 0 });
    expect(points(turned)[0]).toEqual({ x: 100, y: 200 });
  });

  it("is deterministic to three decimals", () => {
    const one = resolveImageMask({ type: "shape", shape: "blob", rotation: 17 }, 333.3, 211.1);
    const two = resolveImageMask({ type: "shape", shape: "blob", rotation: 17 }, 333.3, 211.1);
    expect(one).toEqual(two);
    expect(one.mask!.paths[0]).not.toMatch(/\d\.\d{4}/);
  });

  it("combines parts and keeps inversion", () => {
    const compound: MaskDefinition = {
      type: "compound",
      invert: true,
      parts: [
        { type: "shape", shape: "circle" },
        { type: "rounded", radius: 12, rotation: 45 },
      ],
    };
    const { mask } = resolveImageMask(compound, 200, 200);
    expect(mask!.paths).toHaveLength(2);
    expect(mask!.invert).toBe(true);
    expect(mask!.preset).toBeUndefined();
  });

  it("names the PowerPoint preset an outline is exactly", () => {
    expect(resolveImageMask({ type: "ellipse" }, 300, 200).mask!.preset).toEqual({ geometry: "ellipse" });
    expect(resolveImageMask({ type: "shape", shape: "pill" }, 300, 100).mask!.preset).toEqual({ geometry: "roundRect", radius: 50 });
    expect(resolveImageMask({ type: "rounded", radius: 20 }, 300, 100).mask!.preset).toEqual({ geometry: "roundRect", radius: 20 });
    // A turned or inverted outline is no longer that preset.
    expect(resolveImageMask({ type: "ellipse", rotation: 30 }, 300, 200).mask!.preset).toBeUndefined();
    expect(resolveImageMask({ type: "ellipse", invert: true }, 300, 200).mask!.preset).toBeUndefined();
    expect(resolveImageMask({ type: "shape", shape: "arch" }, 300, 200).mask!.preset).toBeUndefined();
  });

  it("says why a mask is not drawn, rather than drawing nothing", () => {
    expect(resolveImageMask({ type: "path", pathData: "M0.5,0.5 Z" }, 100, 100).warning).toMatch(/empty/);
    expect(resolveImageMask({ type: "shape", shape: "spiral" } as MaskDefinition, 100, 100).warning).toMatch(/spiral/);
    expect(resolveImageMask({ type: "shapeRef", elementId: "el_x" }, 100, 100).warning).toMatch(/without it/);
    expect(resolveImageMask(undefined, 100, 100)).toEqual({});
  });
});

describe("masks in the scene and on the slide", () => {
  const technical = loadFixture("technical");

  function masked(mask: MaskDefinition | undefined): { document: PresentationDocument; id: string } {
    const document = structuredClone(technical);
    for (const slide of document.slides) {
      const image = slide.elements.find((element) => element.type === "image");
      if (image) {
        (image as { mask?: MaskDefinition }).mask = mask;
        return { document, id: image.id };
      }
    }
    throw new Error("the technical fixture has no image");
  }

  function node(document: PresentationDocument, id: string) {
    for (const [index, slide] of document.slides.entries()) {
      const found = flattenScene(buildSlideScene(document, slide, index, resolveTheme(document.theme))).find((candidate) => candidate.id === id);
      if (found) return { found, index };
    }
    throw new Error("no node");
  }

  it("leaves an unmasked picture's payload exactly as it was", () => {
    const { document, id } = masked(undefined);
    const payload = node(document, id).found.renderPayload;
    expect(payload).not.toHaveProperty("mask");
    expect(payload).not.toHaveProperty("maskWarning");
  });

  it("carries the outline in the box the picture is drawn in", () => {
    const { document, id } = masked({ type: "shape", shape: "arch" });
    const { found } = node(document, id);
    expect(found.renderPayload).toMatchObject({ kind: "image", mask: { invert: false } });
    const d = (found.renderPayload as { mask: { paths: string[] } }).mask.paths[0]!;
    expect(bounds(d).right).toBeCloseTo(found.localBounds.width, 3);
  });

  it("draws the mask on the picture with the same outline", () => {
    const { document, id } = masked({ type: "shape", shape: "circle", invert: true });
    const { found, index } = node(document, id);
    const scene = buildSlideScene(document, document.slides[index]!, index, resolveTheme(document.theme));
    const html = renderToStaticMarkup(<SlideView scene={scene} mode="export" resolveAssetUrl={() => "data:image/png;base64,AA=="} />);
    const expected = maskImageCss((found.renderPayload as { mask: never }).mask, found.localBounds.width, found.localBounds.height);
    expect(html).toContain('data-mask="true"');
    expect(html).toContain("mask-size:100% 100%");
    // React escapes the quotes in the url; the outline itself is in it.
    expect(html.replace(/&quot;/g, '"')).toContain(expected);
  });

  it("clips the missing-picture placeholder too, so the shape still shows", () => {
    const { document, id } = masked({ type: "shape", shape: "blob" });
    const { index } = node(document, id);
    const scene = buildSlideScene(document, document.slides[index]!, index, resolveTheme(document.theme));
    const html = renderToStaticMarkup(<SlideView scene={scene} mode="export" />);
    expect(html).toContain("mask-image:url(");
  });

  it("inverts with an SVG mask, so overlapping parts stay one hole", () => {
    const css = decodeURIComponent(maskImageCss({ paths: ["M0,0 L10,0 L10,10 Z", "M5,0 L10,0 L10,10 Z"], invert: true }, 10, 10));
    expect(css).toContain("<mask");
    expect(css).not.toContain("evenodd");
  });
});
