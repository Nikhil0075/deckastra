/**
 * The picture is actually in the file (2026-09-17).
 *
 * Everything else about this change can pass while an export still draws a
 * dashed box: the resolver can answer, the warnings can be empty, the job can
 * report success, and the PDF can arrive with a placeholder where a photograph
 * should be. The only statement worth making is about **pixels**, in a real
 * browser, read back out of the artifact the product would hand somebody.
 *
 * So this renders one slide of the `technical` fixture — which carries an image
 * element — twice: once with the bytes supplied and once without. The supplied
 * run must paint the colour at the element's centre; the control must not. A
 * test with only the first half would pass against a renderer that painted that
 * corner of every slide magenta.
 *
 * It is a `.browser.test.ts` because it needs Chromium:
 *
 *   npx playwright install chromium
 *   npm run test:browser --workspace @deckastra/worker
 */

import { deflateSync, crc32 } from "node:zlib";
import { beforeAll, afterAll, expect, it } from "vitest";
import { buildDocumentScene } from "@deckastra/renderer";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { RenderPool, render } from "../src/render";
import { neededAssets } from "../src/assets";

/** Unmistakable, and nothing in the theme is near it. */
const COLOUR = { r: 255, g: 0, b: 255 };

let pool: RenderPool;

beforeAll(() => {
  // Generous: this launches a browser and renders a 1920×1080 slide twice.
  pool = new RenderPool({ timeoutMs: 60_000 });
});

afterAll(async () => {
  await pool.close();
});

/**
 * A solid-colour PNG, written by hand.
 *
 * A literal base64 blob would work and would be a magic string nobody could
 * check; this is eighteen lines and says exactly what colour it is, which is the
 * thing the assertion turns on.
 */
function solidPng(width: number, height: number, colour: typeof COLOUR): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = colour.r;
      raw[row + 2 + x * 3] = colour.g;
      raw[row + 3 + x * 3] = colour.b;
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
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The fixture's image element: which asset, which slide, and where on it. */
function target(): { assetId: string; slideId: string; x: number; y: number } {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const scene = buildDocumentScene(document);

  for (const slide of scene.slides) {
    const [needed] = neededAssets(slide);
    if (!needed) continue;
    const [assetId, elementId] = needed;
    const node = slide.nodes.find((one) => one.id === elementId);
    if (!node) continue;
    return {
      assetId,
      slideId: slide.slideId,
      // The centre of the element's own box. `fit: "contain"` letterboxes a
      // square picture inside a wide box, so the centre is the one point the
      // image certainly covers whatever its aspect ratio.
      x: Math.round(node.bounds.x + node.bounds.width / 2),
      y: Math.round(node.bounds.y + node.bounds.height / 2),
    };
  }
  throw new Error("The technical fixture no longer carries an image element.");
}

/** The colour at one point of a rendered PNG, read back through the browser. */
async function pixelAt(png: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return pool.withPage(1, async (page) =>
    page.evaluate<[number, number, number], { dataUrl: string; x: number; y: number }>(
      async (input) => {
        const image = new Image();
        image.src = input.dataUrl;
        await image.decode();
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixel = context.getImageData(input.x, input.y, 1, 1).data;
        return [pixel[0]!, pixel[1]!, pixel[2]!];
      },
      { dataUrl, x, y },
    ),
  );
}

it("draws the supplied picture, and draws a placeholder without it", async () => {
  const { assetId, slideId, x, y } = target();
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const png = solidPng(8, 8, COLOUR);

  const withBytes = await render(
    {
      document,
      slideIds: [slideId],
      format: "png",
      scale: 1,
      assets: [
        {
          assetId,
          mimeType: "image/png",
          data: png.toString("base64"),
        },
      ],
    },
    pool,
  );

  const artifact = withBytes.artifacts[0]!;
  // The capture is at DPR 1 here, so PNG pixels are scene pixels.
  const drawn = await pixelAt(artifact.bytes, x, y);

  expect(drawn[0]).toBeGreaterThan(200);
  expect(drawn[1]).toBeLessThan(60);
  expect(drawn[2]).toBeGreaterThan(200);

  // And nothing was reported against a picture that arrived.
  expect(withBytes.warnings.filter((one) => one.feature.startsWith("asset:"))).toEqual([]);

  // The control. Without it, an assertion that a point is magenta says nothing
  // about whether the *image* put it there.
  const without = await render(
    { document, slideIds: [slideId], format: "png", scale: 1 },
    pool,
  );
  const placeholder = await pixelAt(without.artifacts[0]!.bytes, x, y);
  expect(placeholder).not.toEqual(drawn);

  // And the report names the picture it could not draw, rather than the export
  // finishing quietly with a dashed box in it.
  const reported = without.warnings.find((one) => one.feature === `asset:${assetId}`)!;
  expect(reported).toBeDefined();
  expect(reported.action).toBe("dropped");
}, 180_000);
