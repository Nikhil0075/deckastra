/**
 * Subject cut-outs in the editor (2026-10-13).
 */
import { deflateSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { applyPatch } from "@deckastra/transactions";
import { newId, validateDocument, type ImageElement, type PresentationDocument, type PresentationElement } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";

import { addCutoutOperations, layerRoleOperations } from "../src/lib/cutouts";
import { pictureHasAlpha } from "../src/lib/insert-image";
import { designCheck, fixOperations } from "../src/lib/design-check";

function png(colourType: number, extra: [string, Buffer][] = []): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = colourType;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      ...extra.map(([type, body]) => chunk(type, body)),
      chunk("IDAT", deflateSync(Buffer.alloc(5))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function webp(chunk: string, flagOffset: number, flag: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("WEBP"), 8);
  bytes.set(Buffer.from(chunk), 12);
  bytes[flagOffset] = flag;
  return bytes;
}

describe("reading transparency from a picture's header", () => {
  it("knows a PNG with alpha, with a transparency chunk, and without either", () => {
    expect(pictureHasAlpha(png(6))).toBe(true);
    expect(pictureHasAlpha(png(4))).toBe(true);
    expect(pictureHasAlpha(png(2, [["tRNS", Buffer.from([0, 0, 0, 0, 0, 0])]]))).toBe(true);
    expect(pictureHasAlpha(png(2))).toBe(false);
  });

  it("knows a JPEG never has it and a WebP says so in its header", () => {
    expect(pictureHasAlpha(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(pictureHasAlpha(webp("VP8X", 20, 0x10))).toBe(true);
    expect(pictureHasAlpha(webp("VP8X", 20, 0x00))).toBe(false);
    expect(pictureHasAlpha(webp("VP8L", 24, 0x10))).toBe(true);
    expect(pictureHasAlpha(webp("VP8 ", 20, 0))).toBe(false);
  });

  it("does not guess for a format that cannot say", () => {
    expect(pictureHasAlpha(new Uint8Array(Buffer.from("GIF89a")))).toBeUndefined();
  });
});

function withImage(): { document: PresentationDocument; image: ImageElement } {
  const document = structuredClone(loadFixture("technical"));
  for (const slide of document.slides) {
    const image = slide.elements.find((element) => element.type === "image") as ImageElement | undefined;
    if (image) return { document, image };
  }
  throw new Error("the technical fixture has no image");
}

describe("adding a cut-out", () => {
  const asset = { id: newId("ast"), kind: "image", storage_key: "workspaces/w/cutout.png", filename: "runner-cutout.png", content_type: "image/png", bytes: 1000, width: 800, height: 1200 };

  it("places it exactly over its source, as the subject, in one valid patch", () => {
    const { document, image } = withImage();
    image.fit = "cover";
    image.focalPoint = { x: 0.3, y: 0.6 };
    const { operations, elementId } = addCutoutOperations(document, { sourceElementId: image.id, asset, hasAlpha: true });
    const after = applyPatch(document, operations).document;
    expect(validateDocument(after).errors).toEqual([]);

    const slide = after.slides.find((candidate) => candidate.elements.some((element) => element.id === image.id))!;
    const index = slide.elements.findIndex((element) => element.id === image.id);
    const cutout = slide.elements[index + 1] as ImageElement;
    expect(cutout.id).toBe(elementId);
    expect(cutout.layerRole).toBe("subject");
    expect(cutout.transform).toEqual(image.transform);
    expect(cutout.fit).toBe("cover");
    expect(cutout.focalPoint).toEqual({ x: 0.3, y: 0.6 });
    expect(cutout.altText).toBe(image.altText);

    const source = slide.elements[index] as ImageElement;
    expect(source.layerRole).toBe("scene");
    expect(after.assets.find((entry) => entry.id === asset.id)).toMatchObject({ derivedFrom: image.assetId, hasAlpha: true, mimeType: "image/png" });
  });

  it("keeps a role the source already has", () => {
    const { document, image } = withImage();
    image.layerRole = "background";
    const { operations } = addCutoutOperations(document, { sourceElementId: image.id, asset });
    const after = applyPatch(document, operations).document;
    const source = after.slides.flatMap((slide) => slide.elements).find((element) => element.id === image.id)!;
    expect(source.layerRole).toBe("background");
  });

  it("does nothing for something that is not a picture", () => {
    const { document } = withImage();
    const text = document.slides[0]!.elements.find((element) => element.type === "text")!;
    expect(addCutoutOperations(document, { sourceElementId: text.id, asset }).operations).toEqual([]);
  });
});

describe("Design Check with layer roles", () => {
  function staged(order: "wrong" | "right", pin = false) {
    const { document, image } = withImage();
    const slide = document.slides.find((candidate) => candidate.elements.some((element) => element.id === image.id))!;
    const ring = {
      id: newId("el"),
      type: "shape",
      shape: "ellipse",
      name: "Ring",
      layerRole: "decoration-behind-subject",
      transform: { ...image.transform },
      style: { fill: { type: "solid", color: "#F5C400" } },
      ...(pin ? { zIndex: 5 } : {}),
    } as unknown as PresentationElement;
    image.layerRole = "subject";
    const at = slide.elements.findIndex((element) => element.id === image.id);
    slide.elements.splice(order === "wrong" ? at + 1 : at, 0, ring);
    return { document, image, ring };
  }

  it("offers to put a decoration back behind the subject, as one move", () => {
    const { document, image, ring } = staged("wrong");
    const finding = designCheck(document, buildDocumentScene(document)).find((one) => one.code === "W219")!;
    expect(finding.elementId).toBe(ring.id);
    expect(finding.fix?.label).toBe("Put it behind");
    const operations = fixOperations(document, [finding.fix!]);
    expect(operations).toHaveLength(1);
    expect(operations[0]!.op).toBe("move");
    const after = applyPatch(document, operations).document;
    const slide = after.slides.find((candidate) => candidate.elements.some((element) => element.id === image.id))!;
    const ids = slide.elements.map((element) => element.id);
    expect(ids.indexOf(ring.id)).toBeLessThan(ids.indexOf(image.id));
    expect(designCheck(after, buildDocumentScene(after)).some((one) => one.code === "W219")).toBe(false);
  });

  it("says to remove a stacking pin rather than offering a move that would change nothing", () => {
    const { document } = staged("wrong", true);
    // The ring is pinned in front (zIndex 5) and stacked in front too, so a
    // move alone would leave it drawn in front: no fix, and the reason said.
    const finding = designCheck(document, buildDocumentScene(document)).find((one) => one.code === "W219");
    expect(finding).toBeDefined();
    expect(finding!.fix).toBeUndefined();
    expect(finding!.message).toMatch(/pinned/);
  });

  it("says nothing when the order agrees with the roles", () => {
    const { document } = staged("right");
    expect(designCheck(document, buildDocumentScene(document)).some((one) => one.code === "W219")).toBe(false);
  });

  it("says when the subject's picture is not a cut-out", () => {
    const { document, image } = withImage();
    image.layerRole = "subject";
    (document.assets.find((entry) => entry.id === image.assetId) as { hasAlpha?: boolean }).hasAlpha = false;
    const finding = designCheck(document, buildDocumentScene(document)).find((one) => one.code === "W221")!;
    expect(finding.elementId).toBe(image.id);
    expect(finding.message).toMatch(/no transparent background/);
    // Unknown transparency is not "opaque".
    delete (document.assets.find((entry) => entry.id === image.assetId) as { hasAlpha?: boolean }).hasAlpha;
    expect(designCheck(document, buildDocumentScene(document)).some((one) => one.code === "W221")).toBe(false);
  });

  it("sets and clears a depth in one patch", () => {
    const { document, image } = withImage();
    const set = applyPatch(document, layerRoleOperations(document, image.id, "foreground")).document;
    expect(set.slides.flatMap((slide) => slide.elements).find((element) => element.id === image.id)!.layerRole).toBe("foreground");
    const cleared = applyPatch(set, layerRoleOperations(set, image.id, undefined)).document;
    expect(cleared.slides.flatMap((slide) => slide.elements).find((element) => element.id === image.id)!.layerRole).toBeUndefined();
  });
});
