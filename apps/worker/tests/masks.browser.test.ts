/**
 * A masked picture, as Chromium actually paints it (2026-10-13).
 *
 * The scene's outlines and the CSS that carries them are unit-tested; what a
 * person sees is pixels, so this renders the `technical` fixture's picture in
 * a real browser, filled with one unmistakable colour, and reads points back:
 * inside the outline must be that colour, outside it must not. An inverted
 * mask swaps the two. Then the PowerPoint capture of an inverted mask must be
 * transparent where the hole is, because that capture is what the file holds.
 *
 *   npx playwright install chromium
 *   npm run test:browser --workspace @deckastra/worker
 */

import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDocumentScene, type SlideScene } from "@deckastra/renderer";
import type { MaskDefinition, PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { maskedImageKey } from "@deckastra/export-pptx";

import { RenderPool, captureEquations, render, renderPdfScene } from "../src/render";
import { AssetLibrary } from "../src/assets";

const COLOUR = { r: 255, g: 0, b: 255 };

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 60_000 });
});
afterAll(async () => {
  await pool.close();
});

function solidPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = COLOUR.r;
      raw[row + 2 + x * 3] = COLOUR.g;
      raw[row + 3 + x * 3] = COLOUR.b;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The fixture with its picture covering its box and masked as asked. */
function masked(mask: MaskDefinition) {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  for (const slide of document.slides) {
    const image = slide.elements.find((element) => element.type === "image") as (Record<string, unknown> & { id: string; assetId: string }) | undefined;
    if (!image) continue;
    image.fit = "cover";
    image.mask = mask;
    const scene = buildDocumentScene(document).slides.find((one) => one.slideId === slide.id)!;
    const node = scene.nodes.find((one) => one.id === image.id)!;
    return { document, slideId: slide.id, assetId: image.assetId, bounds: node.bounds, scene, node };
  }
  throw new Error("The technical fixture no longer carries an image element.");
}

async function pixels(png: Uint8Array, points: [number, number][]): Promise<[number, number, number, number][]> {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return pool.withPage(1, async (page) =>
    page.evaluate<[number, number, number, number][], { dataUrl: string; points: [number, number][] }>(
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
          return [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]!] as [number, number, number, number];
        });
      },
      { dataUrl, points: input_points(points) },
    ),
  );
}
const input_points = (points: [number, number][]) => points.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]);

const isColour = ([r, g, b, a]: [number, number, number, number]) => a > 200 && r > 200 && g < 60 && b > 200;

async function draw(mask: MaskDefinition) {
  const target = masked(mask);
  const result = await render(
    {
      document: target.document,
      slideIds: [target.slideId],
      format: "png",
      scale: 1,
      assets: [{ assetId: target.assetId, mimeType: "image/png", data: solidPng(16, 16).toString("base64") }],
    },
    pool,
  );
  return { ...target, png: result.artifacts[0]!.bytes };
}

it("shows the picture inside an arch and not in the corner it cuts away", async () => {
  const { png, bounds } = await draw({ type: "shape", shape: "arch" });
  const [corner, lowerMiddle] = await pixels(png, [
    [bounds.x + 3, bounds.y + 3],
    [bounds.x + bounds.width / 2, bounds.y + bounds.height - 4],
  ]);
  expect(isColour(lowerMiddle!)).toBe(true);
  expect(isColour(corner!)).toBe(false);
}, 180_000);

it("swaps inside and outside when the mask is inverted", async () => {
  const { png, bounds } = await draw({ type: "shape", shape: "circle", invert: true });
  const [centre, corner] = await pixels(png, [
    [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2],
    [bounds.x + 3, bounds.y + 3],
  ]);
  expect(isColour(centre!)).toBe(false);
  expect(isColour(corner!)).toBe(true);
}, 180_000);

it("turns the outline and not the picture", async () => {
  // A triangle turned upside down: its apex moves from the top edge to the bottom.
  const { png, bounds } = await draw({ type: "shape", shape: "triangle", rotation: 180 });
  const [topMiddle, bottomMiddle] = await pixels(png, [
    [bounds.x + bounds.width / 2, bounds.y + 4],
    [bounds.x + bounds.width / 2, bounds.y + bounds.height - 4],
  ]);
  expect(isColour(topMiddle!)).toBe(true);
  expect(isColour(bottomMiddle!)).toBe(true);
  // Its lower corners are cut away, which an unturned triangle's are not.
  const [lowerCorner] = await pixels(png, [[bounds.x + 4, bounds.y + bounds.height - 4]]);
  expect(isColour(lowerCorner!)).toBe(false);
}, 180_000);

it("captures an inverted mask for PowerPoint with the hole transparent", async () => {
  const { scene, node, assetId } = masked({ type: "shape", shape: "circle", invert: true });
  const data = `data:image/png;base64,${solidPng(16, 16).toString("base64")}`;
  const captured = await pool.withPage(1, (page) =>
    captureEquations([scene as SlideScene], page, "", (id) => (id === assetId ? data : undefined)),
  );
  const picture = captured.get(maskedImageKey(node.id));
  expect(picture?.contentType).toBe("image/png");
  const width = Math.ceil(node.bounds.width);
  const height = Math.ceil(node.bounds.height);
  const [centre, corner] = await pixels(picture!.bytes, [
    [width / 2, height / 2],
    [3, 3],
  ]);
  expect(centre![3]).toBeLessThan(10);
  expect(isColour(corner!)).toBe(true);
}, 180_000);

/**
 * The PDF keeps the mask as a mask: Chromium writes the masked picture under
 * an alpha soft mask, so the outline survives zooming and printing. An
 * unmasked picture carries none, which is the control.
 */
it("writes the mask into the PDF as a soft mask", async () => {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const softMasks = async (mask: MaskDefinition | undefined) => {
    const target = mask ? masked(mask) : masked({ type: "ellipse" });
    const document = structuredClone(target.document);
    if (!mask) {
      for (const slide of document.slides) for (const element of slide.elements as Record<string, unknown>[]) delete element.mask;
    }
    const library = new AssetLibrary([{ assetId: target.assetId, mimeType: "image/png", data: solidPng(16, 16).toString("base64") }]);
    const out = await pool.withPage(1, (page) => renderPdfScene(buildDocumentScene(document), [target.slideId], "final", page, library));
    const pdf = await PDFDocument.load(out.bytes);
    let count = 0;
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      const soft = object.get(PDFName.of("SMask"));
      if (soft && soft !== PDFName.of("None")) count += 1;
    }
    return count;
  };
  expect(await softMasks({ type: "shape", shape: "arch" })).toBeGreaterThan(0);
  expect(await softMasks(undefined)).toBe(0);
}, 180_000);
