/**
 * Picture treatments, as Chromium paints them (2026-10-13).
 *
 * A duotone must map white to its highlight colour exactly, black and white
 * must leave a red picture grey, a vignette must darken the corners and not
 * the centre, and the capture PowerPoint receives for a vignette must carry it.
 *
 *   npm run test:browser --workspace @deckastra/worker
 */

import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDocumentScene, type SlideScene } from "@deckastra/renderer";
import { maskedImageKey } from "@deckastra/export-pptx";
import { newId, type ImageTreatment, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { RenderPool, captureEquations, render } from "../src/render";

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 60_000 });
});
afterAll(async () => {
  await pool.close();
});

/** A size×size opaque PNG of one colour. */
function solidPng(colour: [number, number, number], size = 16): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) raw.set(colour, y * (1 + size * 3) + 1 + x * 3);
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
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const box = { x: 400, y: 200, width: 800, height: 600, rotation: 0 };

function staged(treatment: ImageTreatment) {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides[0]!;
  const assetId = newId("ast");
  document.assets.push({ id: assetId, type: "image", storageKey: "workspaces/w/solid.png", mimeType: "image/png", width: 16, height: 16 } as never);
  const id = newId("el");
  slide.elements = [{ id, type: "image", name: "Photo", assetId, fit: "fill", altText: "A photograph", transform: box, treatment }] as never;
  return { document, slideId: slide.id, assetId, id };
}

async function pixels(png: Uint8Array, points: [number, number][]) {
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
      { dataUrl, points },
    ),
  );
}

async function slidePng(treatment: ImageTreatment, colour: [number, number, number]) {
  const { document, slideId, assetId } = staged(treatment);
  const result = await render(
    { document, slideIds: [slideId], format: "png", scale: 1, assets: [{ assetId, mimeType: "image/png", data: solidPng(colour).toString("base64") }] },
    pool,
  );
  return result.artifacts[0]!.bytes;
}

const centre: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
const corner: [number, number] = [box.x + 3, box.y + 3];
const near = (actual: number, expected: number, tolerance = 3) => Math.abs(actual - expected) <= tolerance;

it("maps white to a duotone's highlight colour", async () => {
  const [middle] = await pixels(await slidePng({ duotone: ["#000000", "#00AA55"] }, [255, 255, 255]), [centre]);
  expect(near(middle![0], 0) && near(middle![1], 170) && near(middle![2], 85)).toBe(true);
}, 180_000);

it("leaves a red picture grey in black and white", async () => {
  const [middle] = await pixels(await slidePng({ monochrome: 1 }, [220, 30, 30]), [centre]);
  expect(near(middle![0], middle![1]) && near(middle![1], middle![2])).toBe(true);
  // The control: untreated, the same picture is red.
  const [control] = await pixels(await slidePng({}, [220, 30, 30]), [centre]);
  expect(control![0] - control![1]).toBeGreaterThan(150);
}, 180_000);

it("darkens the corners and not the centre with a vignette", async () => {
  const [middle, edge] = await pixels(await slidePng({ vignette: 1 }, [255, 255, 255]), [centre, corner]);
  expect(middle![0]).toBeGreaterThan(245);
  expect(edge![0]).toBeLessThan(120);
}, 180_000);

it("gives PowerPoint a capture that carries the vignette", async () => {
  const { document, assetId, id } = staged({ vignette: 1 });
  const scene = buildDocumentScene(document).slides[0]!;
  const data = `data:image/png;base64,${solidPng([255, 255, 255]).toString("base64")}`;
  const captured = await pool.withPage(1, (page) =>
    captureEquations([scene as SlideScene], page, "", (asset) => (asset === assetId ? data : undefined)),
  );
  const picture = captured.get(maskedImageKey(id));
  expect(picture?.contentType).toBe("image/png");
  const [middle, edge] = await pixels(picture!.bytes, [
    [box.width / 2, box.height / 2],
    [3, 3],
  ]);
  expect(middle![0]).toBeGreaterThan(245);
  expect(edge![0]).toBeLessThan(120);
}, 180_000);

it("grains a flat dark picture visibly, not only a bright one", async () => {
  // The first grain was an overlay blend, which scales with the picture's own
  // brightness and left a night sky untouched. Measured over a patch.
  const spread = async (treatment: ImageTreatment) => {
    const points: [number, number][] = [];
    for (let dx = 0; dx < 40; dx += 2) for (let dy = 0; dy < 40; dy += 2) points.push([centre[0] + dx, centre[1] + dy]);
    const values = (await pixels(await slidePng(treatment, [30, 30, 40]), points)).map((pixel) => pixel[0]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  };
  expect(await spread({})).toBeLessThan(1);
  expect(await spread({ grain: 0.35 })).toBeGreaterThan(4);
}, 180_000);
