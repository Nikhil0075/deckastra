/**
 * A subject cut-out, as Chromium paints it (2026-10-13).
 *
 * A transparent PNG stacked over a yellow ring must show the ring wherever the
 * cut-out is transparent and the subject wherever it is not: that is the whole
 * point of a cut-out. And the PDF must keep the transparency (Chromium writes
 * the picture with a soft mask), not flatten it onto white.
 *
 *   npm run test:browser --workspace @deckastra/worker
 */

import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDocumentScene } from "@deckastra/renderer";
import { newId, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { RenderPool, render, renderPdfScene } from "../src/render";
import { AssetLibrary } from "../src/assets";

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 60_000 });
});
afterAll(async () => {
  await pool.close();
});

/** A 20×20 RGBA PNG: transparent, with an opaque magenta square in its middle half. */
function cutoutPng(): Buffer {
  const size = 20;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const inside = x >= 5 && x < 15 && y >= 5 && y < 15;
      raw.set(inside ? [255, 0, 255, 255] : [0, 0, 0, 0], row + 1 + x * 4);
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** One slide: a yellow ring behind a cut-out subject covering the same box. */
function staged() {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides[0]!;
  const assetId = newId("ast");
  document.assets.push({ id: assetId, type: "image", storageKey: "workspaces/w/cutout.png", mimeType: "image/png", width: 20, height: 20, hasAlpha: true } as never);
  const box = { x: 600, y: 200, width: 600, height: 600, rotation: 0 };
  slide.elements = [
    { id: newId("el"), type: "shape", shape: "rectangle", name: "Ring", layerRole: "decoration-behind-subject", transform: box, style: { fill: { type: "solid", color: "#FFD400" } } },
    { id: newId("el"), type: "image", name: "Subject", layerRole: "subject", assetId, fit: "fill", altText: "A subject", transform: box },
  ] as never;
  return { document, slideId: slide.id, assetId, box };
}

async function pixels(png: Uint8Array, points: [number, number][]) {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return pool.withPage(1, async (page) =>
    page.evaluate<[number, number, number][], { dataUrl: string; points: [number, number][] }>(
      async (input) => {
        const image = new Image();
        image.src = input.dataUrl;
        await image.decode();
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return input.points.map(([x, y]) => {
          const pixel = context.getImageData(x, y, 1, 1).data;
          return [pixel[0]!, pixel[1]!, pixel[2]!] as [number, number, number];
        });
      },
      { dataUrl, points },
    ),
  );
}

it("shows the decoration through the cut-out's transparent pixels and the subject over it", async () => {
  const { document, slideId, assetId, box } = staged();
  const result = await render(
    { document, slideIds: [slideId], format: "png", scale: 1, assets: [{ assetId, mimeType: "image/png", data: cutoutPng().toString("base64") }] },
    pool,
  );
  const [corner, middle] = await pixels(result.artifacts[0]!.bytes, [
    [box.x + 40, box.y + 40],
    [box.x + box.width / 2, box.y + box.height / 2],
  ]);
  // Yellow ring through the transparent corner; magenta subject in the middle.
  expect(corner![0]).toBeGreaterThan(220);
  expect(corner![1]).toBeGreaterThan(180);
  expect(corner![2]).toBeLessThan(60);
  expect(middle).toEqual([255, 0, 255]);
}, 180_000);

it("keeps the cut-out's transparency in the PDF", async () => {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const { document, slideId, assetId } = staged();
  const library = new AssetLibrary([{ assetId, mimeType: "image/png", data: cutoutPng().toString("base64") }]);
  const out = await pool.withPage(1, (page) => renderPdfScene(buildDocumentScene(document), [slideId], "final", page, library));
  const pdf = await PDFDocument.load(out.bytes);
  let masked = 0;
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : (object as { dict?: unknown }).dict;
    if (!(dict instanceof PDFDict)) continue;
    if (dict.get(PDFName.of("Subtype")) === PDFName.of("Image") && dict.get(PDFName.of("SMask"))) masked += 1;
  }
  expect(masked).toBeGreaterThan(0);
}, 180_000);
