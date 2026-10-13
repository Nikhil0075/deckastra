import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId, type PresentationDocument, type PresentationElement } from "@deckastra/presentation-schema";

import { buildSlideScene, checkLayout, flattenScene, maskImageCss, resolveTheme } from "../src/index";
import { SlideView } from "../src/react/index";

/**
 * Subject cut-outs and layer roles (2026-10-13): a role is the depth an object
 * means to have; array order stays the authority, and the check says when the
 * two disagree.
 */

function slideWith(elements: PresentationElement[]): { document: PresentationDocument; index: number } {
  const document = structuredClone(loadFixture("technical"));
  const slide = document.slides[0]!;
  slide.elements = elements;
  return { document, index: 0 };
}

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, rotation: 0 });

function ring(layerRole?: string): PresentationElement {
  return {
    id: newId("el"),
    type: "shape",
    shape: "ellipse",
    name: "Yellow ring",
    semanticRole: "decoration",
    ...(layerRole ? { layerRole } : {}),
    transform: box(600, 200, 600, 600),
    style: { fill: { type: "solid", color: "#F5C400" } },
  } as unknown as PresentationElement;
}

function subject(layerRole?: string): PresentationElement {
  return {
    id: newId("el"),
    type: "image",
    name: "Runner",
    assetId: "ast_01J0000000000000000000000A",
    altText: "A runner",
    ...(layerRole ? { layerRole } : {}),
    transform: box(650, 150, 500, 750),
  } as unknown as PresentationElement;
}

function issues(elements: PresentationElement[]) {
  const { document, index } = slideWith(elements);
  const scene = buildSlideScene(document, document.slides[index]!, index, resolveTheme(document.theme));
  return checkLayout(scene);
}

describe("layer roles in Design Check", () => {
  it("says when a subject sits behind the decoration meant to be behind it", () => {
    const found = issues([subject("subject"), ring("decoration-behind-subject")]);
    const w219 = found.filter((issue) => issue.code === "W219");
    expect(w219).toHaveLength(1);
    expect(w219[0]!.detail).toMatchObject({ kind: "layerOrder", role: "decoration-behind-subject", otherRole: "subject" });
    expect(w219[0]!.message).toMatch(/behind the subject/);
  });

  it("calls the overlap the composition when the order agrees with the roles", () => {
    const found = issues([ring("decoration-behind-subject"), subject("subject")]);
    expect(found.filter((issue) => issue.code === "W219" || issue.code === "W110")).toEqual([]);
  });

  it("still calls two overlapping objects of one depth a collision", () => {
    const one = subject("content");
    const two = { ...subject("content"), id: newId("el"), transform: box(700, 200, 500, 700) } as PresentationElement;
    expect(issues([one, two]).some((issue) => issue.code === "W110")).toBe(true);
  });

  it("leaves objects with no role to the ordinary checks", () => {
    expect(issues([subject(), ring()]).some((issue) => issue.code === "W219")).toBe(false);
  });
});

describe("cut-outs in the scene and on the slide", () => {
  it("carries the layer role and the softened edge", () => {
    const element = { ...subject("subject"), edgeFeather: 12 } as PresentationElement;
    const { document, index } = slideWith([element]);
    const scene = buildSlideScene(document, document.slides[index]!, index, resolveTheme(document.theme));
    const node = flattenScene(scene).find((candidate) => candidate.id === element.id)!;
    expect(node.layerRole).toBe("subject");
    expect(node.renderPayload).toMatchObject({ kind: "image", feather: 12 });
  });

  it("names a missing cut-out rather than showing an ordinary gap", () => {
    const { document, index } = slideWith([subject("subject")]);
    const scene = buildSlideScene(document, document.slides[index]!, index, resolveTheme(document.theme));
    const html = renderToStaticMarkup(<SlideView scene={scene} mode="export" />);
    expect(html).toContain("Cut-out missing: A runner");
  });

  it("softens the box's edge from inside it, with a blur", () => {
    const css = decodeURIComponent(maskImageCss(undefined, 400, 300, 12));
    expect(css).toContain("feGaussianBlur");
    // Inset by the feather, so the picture has faded to nothing at its edge.
    expect(css).toContain("M12,12 L388,12 L388,288 L12,288 Z");
    expect(decodeURIComponent(maskImageCss(undefined, 400, 300, 0))).not.toContain("feGaussianBlur");
  });
});
