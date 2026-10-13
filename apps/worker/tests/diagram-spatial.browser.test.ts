/**
 * Diagrams with depth, as Chromium paints them (2026-10-13).
 *
 * The scene says where each block's top and faces are; this checks the picture
 * agrees: the top in the node's own colour, its faces darker, both where the
 * scene put them.
 *
 *   npm run test:browser --workspace @deckastra/worker
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDocumentScene, flattenScene, type DiagramPayload } from "@deckastra/renderer";
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
    page.evaluate<number[], { dataUrl: string; points: [number, number][] }>(
      async (input) => {
        const image = new Image();
        image.src = input.dataUrl;
        await image.decode();
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        // Lightness, 0 to 255.
        return input.points.map(([x, y]) => {
          const [r, g, b] = context.getImageData(x, y, 1, 1).data;
          return Math.round(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
        });
      },
      { dataUrl, points },
    ),
  );
}

const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** The middle of a closed polygon path: the mean of its corners. */
function inside(d: string): [number, number] {
  const values = numbers(d);
  let x = 0;
  let y = 0;
  for (let i = 0; i < values.length; i += 2) {
    x += values[i]!;
    y += values[i + 1]!;
  }
  const count = values.length / 2;
  return [Math.round(x / count), Math.round(y / count)];
}

it("paints a block's top in its own colour and its faces darker", async () => {
  const document = structuredClone(loadFixture("technical")) as PresentationDocument;
  const slide = document.slides[0]!;
  const id = newId("el");
  const [a, b] = ["dn_01JB8Z9K2QW4RN7F3XG5HTMD0A", "dn_01JB8Z9K2QW4RN7F3XG5HTMD0B"];
  slide.elements = [
    {
      id,
      type: "diagram",
      name: "Blocks",
      diagramType: "architecture",
      transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0 },
      nodes: [
        { id: a, label: "Light", style: { fill: { type: "solid", color: "#E8ECF2" } } },
        { id: b, label: "Also light", style: { fill: { type: "solid", color: "#E8ECF2" } } },
      ],
      edges: [{ id: "de_01JB8Z9K2QW4RN7F3XG5HTMD0C", from: a, to: b }],
      layoutHint: { projection: "isometric" },
    },
  ] as never;

  const node = flattenScene(buildDocumentScene(document).slides[0]!).find((one) => one.id === id)!;
  const payload = node.renderPayload as DiagramPayload;
  const block = payload.nodes[0]!;
  // Just inside the top's left corner (clear of the label), and the middle of each face.
  const top = inside(block.outline!);
  const corner: [number, number] = [Math.round(block.x + block.width * 0.2), Math.round(top[1])];
  const faces = block.sides!.map((side) => inside(side.d));

  const result = await render({ document, slideIds: [slide.id], format: "png", scale: 1 }, pool);
  const [topLight, ...faceLight] = await pixels(result.artifacts[0]!.bytes, [corner, ...faces]);
  expect(topLight!).toBeGreaterThan(200);
  for (const light of faceLight) expect(light).toBeLessThan(topLight! - 20);
  // And the two faces differ from each other, so the block reads as lit from one side.
  expect(Math.abs(faceLight[0]! - faceLight[1]!)).toBeGreaterThan(5);
}, 180_000);
