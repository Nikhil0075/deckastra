/**
 * The image-led export gate, in a real browser (item 8, 2026-10-14).
 *
 * The canvas a person edits on and the PNG an export writes are both
 * `SlideView` over one scene, and the claim is that they are the same
 * picture. This draws every slide of the `technical` fixture both ways, with
 * its picture masked, treated and stood behind a transparent cut-out, and
 * compares the pixels. A cut-out whose file never arrived is drawn as a named
 * placeholder, never as nothing, and the render says which picture it was.
 *
 *   npx playwright install chromium
 *   npm run test:browser --workspace @deckastra/worker
 */

import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { RenderPool, render, settle, slideHtml } from "../src/render";
import { AssetLibrary } from "../src/assets";
import { pageFontCss } from "../src/fonts";
import { buildBrowserScene } from "../src/text-measurement";

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 120_000 });
});
afterAll(async () => {
  await pool.close();
});

/** A PNG painted by `paint`, RGBA so a cut-out can be clear around its subject. */
function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): string {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set(paint(x, y), y * (1 + width * 4) + 1 + x * 4);
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
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const CUTOUT_ASSET = "ast_01JB8Z9K2QW4RN7F3XG5GATE10";
const CUTOUT = "el_01JB8Z9K2QW4RN7F3XG5GATE10";

/** The fixture with its picture masked and treated, and a cut-out standing in front of it. */
function gateDeck() {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const assets = document.assets as Record<string, unknown>[];
  for (const slide of document.slides) {
    const elements = slide.elements as (Record<string, unknown> & { id: string; type: string; assetId?: string })[];
    const image = elements.find((element) => element.type === "image");
    if (!image) continue;
    image.fit = "cover";
    image.mask = { type: "shape", shape: "arch" };
    image.treatment = { duotone: ["#102030", "#F0E0D0"], vignette: 0.4 };
    image.layerRole = "scene";
    assets.push({ id: CUTOUT_ASSET, type: "image", storageKey: "w/cutout.png", mimeType: "image/png", width: 32, height: 32, hasAlpha: true, derivedFrom: image.assetId });
    elements.splice(elements.indexOf(image) + 1, 0, {
      ...structuredClone(image),
      id: CUTOUT,
      assetId: CUTOUT_ASSET,
      altText: "The subject, cut out",
      layerRole: "subject",
      mask: undefined,
      treatment: undefined,
    });
    return {
      document,
      slideId: slide.id,
      assets: [
        { assetId: image.assetId!, mimeType: "image/png", data: png(16, 16, (x) => [40 + x * 10, 120, 200, 255]) },
        { assetId: CUTOUT_ASSET, mimeType: "image/png", data: png(32, 32, (x, y) => (x > 8 && x < 24 && y > 4 ? [220, 40, 60, 255] : [0, 0, 0, 0])) },
      ],
    };
  }
  throw new Error("The technical fixture no longer carries an image element.");
}

/** The share of pixels that differ visibly between two PNGs of one size. */
async function difference(left: Uint8Array, right: Uint8Array): Promise<number> {
  const urls = [left, right].map((bytes) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  return pool.withPage(1, (page) =>
    page.evaluate<number, string[]>(async (sources) => {
      const read = async (source: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [a, b] = await Promise.all(sources.map(read));
      if (a!.width !== b!.width || a!.height !== b!.height) return 1;
      let differing = 0;
      for (let i = 0; i < a!.data.length; i += 4) {
        for (let c = 0; c < 4; c += 1) {
          if (Math.abs(a!.data[i + c]! - b!.data[i + c]!) > 16) {
            differing += 1;
            break;
          }
        }
      }
      return differing / (a!.width * a!.height);
    }, urls),
  );
}

it("draws every slide on the canvas exactly as the export writes it", async () => {
  const { document, assets } = gateDeck();
  const exported = await render({ document, format: "png", scale: 1, assets }, pool);
  // Both pictures decoded: two placeholders would also compare equal.
  expect(exported.warnings.filter((warning) => warning.feature.startsWith("asset:"))).toEqual([]);
  const library = new AssetLibrary(assets);
  const canvas = await pool.withPage(1, async (page) => {
    const fontCss = await pageFontCss(document, library);
    const scene = await buildBrowserScene(document, page, fontCss);
    const shots: Uint8Array[] = [];
    for (const slide of scene.slides) {
      await page.setContent(slideHtml(slide, "final", [], library.resolve, fontCss, "editor"), { waitUntil: "load" });
      await settle(page);
      shots.push(new Uint8Array(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: slide.width, height: slide.height }, animations: "disabled" })));
    }
    return shots;
  });

  expect(canvas.length).toBe(exported.artifacts.length);
  for (const [index, artifact] of exported.artifacts.entries()) {
    expect(await difference(canvas[index]!, artifact.bytes), `slide ${index + 1}`).toBeLessThan(0.002);
  }
  // The control: two different slides are not "the same picture".
  expect(await difference(canvas[0]!, exported.artifacts[1]!.bytes)).toBeGreaterThan(0.01);
}, 300_000);

it("draws a missing cut-out as a named placeholder and reports which it was", async () => {
  const { document, slideId, assets } = gateDeck();
  const result = await render(
    { document, slideIds: [slideId], format: "png", scale: 1, assets: assets.filter((asset) => asset.assetId !== CUTOUT_ASSET) },
    pool,
  );
  expect(result.warnings.some((warning) => warning.feature === `asset:${CUTOUT_ASSET}`)).toBe(true);
  const text = await pool.withPage(1, async (page) => {
    const library = new AssetLibrary(assets.filter((asset) => asset.assetId !== CUTOUT_ASSET));
    const fontCss = await pageFontCss(document, library);
    const scene = await buildBrowserScene(document, page, fontCss);
    const slide = scene.slides.find((one) => one.slideId === slideId)!;
    await page.setContent(slideHtml(slide, "final", [], library.resolve, fontCss), { waitUntil: "load" });
    return page.evaluate<string, string>((id) => globalThis.document.querySelector(`[data-element-id="${id}"]`)?.textContent ?? "", CUTOUT);
  });
  expect(text).toBe("Cut-out missing: The subject, cut out");
}, 300_000);
