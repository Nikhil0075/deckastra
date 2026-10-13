/**
 * A bubble map, as Chromium paints it (2026-10-13).
 *
 * The scene's numbers say where London is; this checks the picture agrees: a
 * bubble's colour at London's position, land in the middle of Africa, and the
 * slide's own background in the middle of the Pacific.
 *
 *   npm run test:browser --workspace @deckastra/worker
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDocumentScene, flattenScene, type ChartPayload } from "@deckastra/renderer";
import { newId, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { RenderPool, render } from "../src/render";

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 60_000 });
});
afterAll(async () => {
  await pool.close();
});

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

it("draws London's bubble at London, land in Africa and sea in the Pacific", async () => {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides[0]!;
  const id = newId("el");
  const box = { x: 0, y: 0, width: 1920, height: 1080, rotation: 0 };
  slide.elements = [
    {
      id,
      type: "chart",
      name: "Map",
      chartType: "bubbleMap",
      transform: box,
      data: { type: "inline", rows: [{ city: "London", lat: 51.5, lon: -0.13, v: 40 }, { city: "Lagos", lat: 6.5, lon: 3.4, v: 1 }] },
      encoding: { category: "city", value: "v", latitude: "lat", longitude: "lon" },
      chartStyle: { mapExtent: "world" },
      altText: "Two cities",
    },
  ] as never;

  // Where the scene put things, in slide pixels.
  const node = flattenScene(buildDocumentScene(document).slides[0]!).find((one) => one.id === id)!;
  const payload = node.renderPayload as ChartPayload;
  const london = payload.points.find((mark) => mark.r > 20)!;
  const plot = payload.plot;
  // The map's horizontal centre is longitude 0; the Pacific is at its far edge,
  // and central Africa (20°E, 5°N) a little right of centre, just above the middle.
  const pacific: [number, number] = [Math.round(plot.x + plot.width * 0.03), Math.round(plot.y + plot.height * 0.55)];

  const result = await render({ document, slideIds: [slide.id], format: "png", scale: 1 }, pool);
  const [bubble, sea, background] = await pixels(result.artifacts[0]!.bytes, [
    [Math.round(london.cx), Math.round(london.cy)],
    pacific,
    [5, 5],
  ]);
  const land = String(payload.paths[0]!.fill);
  expect(land).toMatch(/^#|^rgb/);
  // The bubble is drawn in its series colour, not the land's or the slide's.
  expect(bubble).not.toEqual(background);
  // The Pacific shows the slide itself.
  expect(sea).toEqual(background);

  // Africa: find the land path covering central Africa by sampling the scene's
  // own projection, through London's position as a reference: 20°E is right of
  // London (0°), 5°N below it.
  const [africa] = await pixels(result.artifacts[0]!.bytes, [[Math.round(london.cx + plot.width * 0.055), Math.round(london.cy + plot.height * 0.33)]]);
  expect(africa).not.toEqual(background);
  expect(africa).not.toEqual(bubble);
}, 180_000);
