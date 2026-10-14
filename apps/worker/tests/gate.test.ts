/**
 * The image-led export gate's broken cases (item 8, 2026-10-14).
 *
 * Each case is a deck someone could really have: a mask whose path is empty, a
 * cut-out whose file never arrived, a transparent picture recorded as a JPEG,
 * text filled with a picture that has left the manifest, a blend mode
 * PowerPoint does not have, and a subject stacked under the decoration meant
 * to sit behind it. None may fail an export, and none may degrade silently:
 * each has to be named by the validator, Design Check or the export report.
 *
 * What only paint can show is in `gate.browser.test.ts`; the whole deck, read
 * back by pypdf and python-pptx, is `apps/api/tests/test_export_gate.py`.
 */

import { inflateRawSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene, checkLayout, flattenScene } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";
import { fontManifest } from "@deckastra/export-core";
import { buildPptx, sniffImageType } from "@deckastra/export-pptx";

type Element = Record<string, unknown> & { id: string; type: string };

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
  0x00, 0x05, 0x00, 0x01, 0xe9, 0xfa, 0xdc, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/** The technical fixture's picture slide, with the picture handed back to edit. */
function pictureSlide() {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  for (const slide of document.slides) {
    const image = (slide.elements as Element[]).find((element) => element.type === "image");
    if (image) return { document, slide, image: image as Element & { assetId: string } };
  }
  throw new Error("The technical fixture no longer carries an image element.");
}

function exported(document: PresentationDocument, images = new Map<string, { bytes: Uint8Array; contentType: string }>()) {
  const scene = buildDocumentScene(document);
  const scenes = new Map(scene.slides.map((slide) => [slide.slideId, slide]));
  const artifact = buildPptx({ document, scenes, fontManifest: fontManifest(scenes.values()), options: {}, images });
  return { report: artifact.result.report, parts: parts(artifact.bytes) };
}

/** The package's parts by name, read from its local headers. */
function parts(bytes: Uint8Array): Map<string, string> {
  const view = Buffer.from(bytes);
  const out = new Map<string, string>();
  let at = 0;
  while (view.readUInt32LE(at) === 0x04034b50) {
    const method = view.readUInt16LE(at + 8);
    const size = view.readUInt32LE(at + 18);
    const nameLength = view.readUInt16LE(at + 26);
    const extra = view.readUInt16LE(at + 28);
    const name = view.toString("utf8", at + 30, at + 30 + nameLength);
    const start = at + 30 + nameLength + extra;
    const data = view.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString("latin1"));
    at = start + size;
  }
  return out;
}

describe("the export gate's broken cases", () => {
  it("draws a picture whose mask path is empty unmasked, and says so", () => {
    const { document, image } = pictureSlide();
    image.mask = { type: "path", pathData: "" };
    const node = buildDocumentScene(document).slides.flatMap((slide) => slide.nodes).find((one) => one.id === image.id)!;
    if (node.renderPayload.kind !== "image") throw new Error("expected an image");
    expect(node.renderPayload.mask).toBeUndefined();
    expect(node.renderPayload.maskWarning).toBeTruthy();
    const report = exported(document, new Map([[image.assetId, { bytes: PNG, contentType: "image/png" }]])).report;
    expect(report.warnings.some((one) => one.feature === "image mask" && one.elementId === image.id)).toBe(true);
  });

  it("names a cut-out whose file did not arrive", () => {
    const { document, slide, image } = pictureSlide();
    const cutout = { ...structuredClone(image), id: "el_01JB8Z9K2QW4RN7F3XG5GATE01", assetId: "ast_01JB8Z9K2QW4RN7F3XG5GATE01", layerRole: "subject" };
    (slide.elements as Element[]).push(cutout);
    // Not in the manifest either: the file and its record are both gone.
    expect(validateDocument(document).errors.some((one) => one.code === "E102" && one.path.includes(cutout.id))).toBe(true);
    // The ordinary picture beside it is missing too, and the report still
    // names the cut-out on a line of its own.
    const report = exported(document).report;
    expect(report.warnings.find((one) => one.feature === "cut-out")?.elementId).toBe(cutout.id);
    expect(report.warnings.find((one) => one.feature === "image")?.elementId).toBe(image.id);
  });

  it("stores a transparent PNG recorded as a JPEG as the PNG it is", () => {
    const { document, image } = pictureSlide();
    const record = (document.assets as { id: string; mimeType?: string }[]).find((one) => one.id === image.assetId)!;
    record.mimeType = "image/jpeg";
    expect(sniffImageType(PNG)).toBe("image/png");
    const artifact = exported(document, new Map([[image.assetId, { bytes: PNG, contentType: "image/jpeg" }]]));
    const retyped = artifact.report.warnings.filter((one) => one.feature === "image type");
    expect(retyped.map((one) => one.elementId)).toEqual([image.id]);
    const media = [...artifact.parts.keys()].filter((name) => name.startsWith("ppt/media/"));
    expect(media).toEqual(["ppt/media/image1.png"]);
  });

  it("refuses text filled with a picture that has left the manifest, and keeps the words", () => {
    const { document, slide } = pictureSlide();
    const text = (slide.elements as Element[]).find((element) => element.type === "text")!;
    text.pictureFill = { assetId: "ast_01JB8Z9K2QW4RN7F3XG5GATE02", fallbackColor: "#336699" };
    const errors = validateDocument(document).errors.filter((one) => one.code === "E102");
    expect(errors.some((one) => one.path.endsWith("/pictureFill/assetId") && (one.path.includes(text.id) || one.targetIds?.includes(text.id)))).toBe(true);
    const artifact = exported(document);
    const fill = artifact.report.warnings.filter((one) => one.feature === "text-picture-fill" && one.elementId === text.id);
    expect(fill.length).toBe(1);
    // The fallback colour is what the words are drawn in.
    const slideXml = [...artifact.parts].find(([name, xml]) => name.startsWith("ppt/slides/slide") && xml.includes(text.id))![1];
    expect(slideXml).toContain('val="336699"');
  });

  it("reports a blend mode PowerPoint does not have as dropped", () => {
    const { document, image } = pictureSlide();
    image.style = { ...((image.style as object) ?? {}), blendMode: "multiply" };
    const dropped = exported(document).report.warnings.filter((one) => one.feature === "blendMode");
    expect(dropped.map((one) => [one.elementId, one.action])).toEqual([[image.id, "dropped"]]);
  });

  it("finds a subject stacked under the decoration meant to sit behind it", () => {
    const { document, slide, image } = pictureSlide();
    image.layerRole = "subject";
    const ring: Element = {
      id: "el_01JB8Z9K2QW4RN7F3XG5GATE03",
      type: "shape",
      shape: "ellipse",
      name: "Ring",
      semanticRole: "decoration",
      layerRole: "decoration-behind-subject",
      transform: { ...(image.transform as object) },
      style: { fill: { type: "solid", color: "#FFD400" } },
    };
    // Array position is the stacking: the ring painted after the subject is in front of it.
    const elements = slide.elements as Element[];
    elements.splice(elements.indexOf(image) + 1, 0, ring);
    const scene = buildDocumentScene(document).slides.find((one) => one.slideId === slide.id)!;
    const issues = checkLayout(scene).filter((issue) => issue.code === "W219");
    expect(issues.length).toBe(1);
    expect(JSON.stringify(issues[0])).toContain(ring.id);

    // In the right order it is the design, not a finding.
    elements.splice(elements.indexOf(ring), 1);
    elements.splice(elements.indexOf(image), 0, ring);
    const fixed = buildDocumentScene(document).slides.find((one) => one.slideId === slide.id)!;
    expect(checkLayout(fixed).filter((issue) => issue.code === "W219")).toEqual([]);
  });
});

describe("what a screen reader is given", () => {
  /** The picture slide with a cut-out over its picture and its text under both. */
  function layered() {
    const { document, slide, image } = pictureSlide();
    image.mask = { type: "shape", shape: "arch" };
    image.treatment = { duotone: ["#102030", "#F0E0D0"], vignette: 0.4 };
    image.layerRole = "scene";
    image.altText = "The scene, masked and treated";
    const cutout = { ...structuredClone(image), id: "el_01JB8Z9K2QW4RN7F3XG5GATE04", altText: "The subject, cut out", layerRole: "subject", mask: undefined, treatment: undefined, semanticRole: "heroVisual" };
    const elements = slide.elements as Element[];
    const texts = elements.filter((element) => element.type === "text");
    // Every word under the pictures: depth now says pictures first.
    for (const text of texts) elements.splice(elements.indexOf(text), 1);
    elements.unshift(...texts);
    elements.push(cutout);
    const scene = buildDocumentScene(document).slides.find((one) => one.slideId === slide.id)!;
    return { scene, image, cutout, texts };
  }

  it("puts the markup in story order, while the paint stays in depth order", () => {
    const { scene } = layered();
    const markup = renderToStaticMarkup(createElement(SlideView, { scene, mode: "export" }));
    const inMarkup = [...markup.matchAll(/data-element-id="([^"]+)"/g)].map((match) => match[1]!);
    const nodes = flattenScene(scene).filter((node) => !node.flags.hidden);
    const story = [...nodes]
      .sort((left, right) => Number(right.a11y.role === "presentation") - Number(left.a11y.role === "presentation") || left.a11y.order - right.a11y.order)
      .map((node) => node.id);
    expect(inMarkup).toEqual(story);
    // Meaningful only because the depth disagrees with the story here.
    const depth = scene.paintOrder.filter((id) => inMarkup.includes(id));
    expect(depth).not.toEqual(story);
    // And the paint is untouched: each object keeps its depth as its z-index.
    for (const [index, id] of scene.paintOrder.entries()) {
      expect(markup).toMatch(new RegExp(`data-element-id="${id}"[^>]*z-index:${index * 10}[;"]`));
    }
  });

  it("keeps the description on a masked, a treated and a cut-out picture", () => {
    const { scene } = layered();
    const markup = renderToStaticMarkup(createElement(SlideView, { scene, mode: "export", resolveAssetUrl: () => "data:image/png;base64,AA==" }));
    expect(markup).toContain('alt="The subject, cut out"');
    // A treated picture is wrapped, and the wrapper is the image to a reader.
    expect(markup).toMatch(/role="img" aria-label="The scene, masked and treated"/);
    expect(markup.match(/The scene, masked and treated/g)!.length).toBeGreaterThanOrEqual(1);
    expect(markup).not.toContain('alt="The scene, masked and treated"');
  });
});
