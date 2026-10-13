/**
 * Picture treatments (image-led visual systems, item 4, 2026-10-13).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { validateDocument, type ImageTreatment, type PresentationDocument } from "@deckastra/presentation-schema";

import {
  buildSlideScene,
  duotoneFilterId,
  duotoneFilterMarkup,
  flattenScene,
  resolveTheme,
  resolveTreatment,
  slideDigest,
  treatmentFilterCss,
} from "../src/index";
import { SlideView } from "../src/react/index";

const technical = loadFixture("technical");

function treated(treatment: ImageTreatment | undefined, extra: Record<string, unknown> = {}): { document: PresentationDocument; id: string; index: number } {
  const document = structuredClone(technical);
  for (const [index, slide] of document.slides.entries()) {
    const image = slide.elements.find((element) => element.type === "image");
    if (image) {
      Object.assign(image, { treatment, ...extra });
      return { document, id: image.id, index };
    }
  }
  throw new Error("the technical fixture has no image");
}

function scene(document: PresentationDocument, index: number) {
  return buildSlideScene(document, document.slides[index]!, index, resolveTheme(document.theme));
}

function payload(treatment: ImageTreatment | undefined) {
  const { document, id, index } = treated(treatment);
  return flattenScene(scene(document, index)).find((node) => node.id === id)!.renderPayload as { treatment?: ReturnType<typeof resolveTreatment> };
}

describe("resolving a treatment", () => {
  it("carries nothing for a picture with no treatment, or one that changes nothing", () => {
    expect(payload(undefined)).not.toHaveProperty("treatment");
    expect(payload({ exposure: 0, grain: 0 })).not.toHaveProperty("treatment");
  });

  it("leaves an untreated picture's digest line as it was", () => {
    const plain = treated(undefined);
    const zero = treated({ contrast: 0 });
    expect(slideDigest(scene(zero.document, zero.index))).toBe(slideDigest(scene(plain.document, plain.index)));
    const changed = treated({ contrast: 0.2 });
    expect(slideDigest(scene(changed.document, changed.index))).toContain("treatment=e0,c0.2");
  });

  it("resolves a duotone's theme colours to hex, so it follows the theme", () => {
    const { document } = treated(undefined);
    const theme = resolveTheme(document.theme);
    const resolved = resolveTreatment({ duotone: ["token:colors.foreground", "#FF8800"] }, theme)!;
    expect(resolved.duotone![0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolved.duotone![1]).toBe("#ff8800");
  });

  it("draws no duotone in a guessed colour when a token does not resolve", () => {
    const { document } = treated(undefined);
    expect(resolveTreatment({ duotone: ["token:colors.nowhere", "#FF8800"] }, resolveTheme(document.theme))).toBeUndefined();
  });

  it("is checked by the schema", () => {
    const good = treated({ monochrome: 1, duotone: ["#000000", "#ffffff"], vignette: 0.4 });
    expect(validateDocument(good.document).errors).toEqual([]);
    for (const bad of [{ monochrome: 2 }, { exposure: -3 }, { duotone: ["#000000"] }, { duotone: ["#000", "#fff", "#888"] }]) {
      expect(validateDocument(treated(bad as ImageTreatment).document).errors.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
    // A duotone token that does not resolve is the ordinary unresolved-token error.
    const token = treated({ duotone: ["token:colors.nowhere", "#ffffff"] });
    expect(validateDocument(token.document).errors.map((issue) => issue.code)).toContain("E202");
  });
});

describe("drawing a treatment", () => {
  it("turns the adjustments into one filter, in a fixed order", () => {
    const resolved = { exposure: 0.2, contrast: -0.1, saturation: 0.5, monochrome: 0.3, vignette: 0, grain: 0, duotone: ["#102030", "#f0e0d0"] as [string, string] };
    expect(treatmentFilterCss(resolved)).toBe(
      `brightness(1.2) contrast(0.9) saturate(1.5) grayscale(0.3) url(#${duotoneFilterId(resolved.duotone)})`,
    );
  });

  it("maps lightness from the shadow colour to the highlight colour", () => {
    const { matrix, tables } = duotoneFilterMarkup(["#000000", "#ff8000"]);
    expect(matrix.split(" ")).toHaveLength(20);
    expect(tables).toEqual({ r: "0 1", g: "0 0.502", b: "0 0" });
  });

  it("filters the picture and defines its duotone beside it", () => {
    const { document, index } = treated({ monochrome: 1, duotone: ["#000000", "#ff8000"] });
    const html = renderToStaticMarkup(<SlideView scene={scene(document, index)} mode="export" resolveAssetUrl={() => "data:image/png;base64,AA=="} />);
    expect(html).toContain('data-treatment="true"');
    expect(html).toContain("grayscale(1)");
    expect(html).toContain(`<filter id="${duotoneFilterId(["#000000", "#ff8000"])}"`);
    expect(html).toContain('tableValues="0 1"');
    // No vignette or grain: the picture is not wrapped.
    expect(html).not.toContain("data-treatment-layer");
  });

  it("lays the vignette and grain over the picture, cut to the same mask", () => {
    const { document, index } = treated({ vignette: 0.5, grain: 0.4 }, { mask: { type: "ellipse" }, fit: "cover" });
    const html = renderToStaticMarkup(<SlideView scene={scene(document, index)} mode="export" resolveAssetUrl={() => "data:image/png;base64,AA=="} />);
    expect(html).toContain('data-treatment-layer="vignette"');
    expect(html).toContain('data-treatment-layer="grain"');
    expect(html).toContain("radial-gradient(ellipse at center");
    expect(html).toContain("feTurbulence");
    // The mask moved from the picture to the wrapper, so the layers are cut too.
    const img = html.match(/<img[^>]*>/)![0];
    expect(img).not.toContain("mask-image");
    const wrapper = html.slice(0, html.indexOf("<img")).split("<div").at(-1)!;
    expect(wrapper).toContain("mask-image");
  });

  it("renders the same markup twice", () => {
    const { document, index } = treated({ grain: 0.3, duotone: ["#000000", "#ffffff"] });
    const render = () => renderToStaticMarkup(<SlideView scene={scene(document, index)} mode="export" resolveAssetUrl={() => "data:image/png;base64,AA=="} />);
    expect(render()).toBe(render());
  });
});
