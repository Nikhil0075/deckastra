import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { newId, type PresentationDocument } from "@deckastra/presentation-schema";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { equationImageKey } from "@deckastra/export-pptx";

import { runExport } from "../src/index";
import { RenderPool, captureEquations } from "../src/render";
import { buildBrowserScene } from "../src/text-measurement";
import { pageFontCss } from "../src/fonts";
import { AssetLibrary } from "../src/assets";

/**
 * Equations in exports (Design tab review, 2026-09-26), in real Chromium: the
 * PDF draws them with KaTeX's own faces, and PowerPoint gets a transparent
 * picture of each, because it cannot read LaTeX.
 */

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 90_000 });
});
afterAll(async () => {
  await pool.close();
});

function deckWithEquation(): { document: PresentationDocument; id: string } {
  const document = structuredClone(loadFixture("technical"));
  const id = newId("el");
  document.slides[0]!.elements.push({
    id,
    type: "equation",
    latex: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
    color: "#ff00ff",
    altText: "The integral of x squared from 0 to 1 is one third",
    transform: { x: 200, y: 700, width: 640, height: 200 },
  } as never);
  return { document, id };
}

/** Alpha and colour of one pixel of an RGBA PNG, decoding only what that needs. */
function pixel(png: Uint8Array, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const bytes = Buffer.from(png);
  const width = bytes.readUInt32BE(16);
  expect(bytes[25], "colour type RGBA").toBe(6);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = 1 + width * 4;
  // Unfilter rows 0..y (Sub, Up, Average, Paeth), which is what a reader does.
  let previous = Buffer.alloc(width * 4);
  let row = Buffer.alloc(width * 4);
  for (let line = 0; line <= y; line += 1) {
    const filter = raw[line * stride]!;
    row = Buffer.from(raw.subarray(line * stride + 1, (line + 1) * stride));
    for (let i = 0; i < row.length; i += 1) {
      const left = i >= 4 ? row[i - 4]! : 0;
      const up = previous[i]!;
      const upLeft = i >= 4 ? previous[i - 4]! : 0;
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const add = [0, left, up, (left + up) >> 1, paeth][filter]!;
      row[i] = (row[i]! + add) & 0xff;
    }
    previous = row;
  }
  return { r: row[x * 4]!, g: row[x * 4 + 1]!, b: row[x * 4 + 2]!, a: row[x * 4 + 3]! };
}

it("captures an equation for PowerPoint as a transparent picture of the maths", async () => {
  const { document, id } = deckWithEquation();
  const images = await pool.withPage(1, async (page) => {
    const css = await pageFontCss(document, new AssetLibrary());
    expect(css).toContain("KaTeX_Main");
    const scene = await buildBrowserScene(document, page, css);
    return captureEquations(scene.slides, page, css);
  });
  const shot = images.get(equationImageKey(id))!;
  expect(shot.contentType).toBe("image/png");
  // Nothing behind the maths: the corner is empty.
  expect(pixel(shot.bytes, 0, 0).a).toBe(0);
  // And the maths is there, in its colour, somewhere across the middle row.
  const width = Buffer.from(shot.bytes).readUInt32BE(16);
  const middle = Math.floor(Buffer.from(shot.bytes).readUInt32BE(20) / 2);
  let inked = false;
  for (let x = 0; x < width && !inked; x += 1) {
    const at = pixel(shot.bytes, x, middle);
    if (at.a > 200 && at.r > 200 && at.b > 200 && at.g < 80) inked = true;
  }
  expect(inked).toBe(true);
}, 120_000); // a cold browser under a parallel suite takes longer than the 5s default

it("exports a deck with an equation to both formats, and says what PowerPoint got", async () => {
  const { document } = deckWithEquation();
  const pptx = await runExport({ kind: "pptx", document, options: {} as never }, undefined, pool);
  const zip = Buffer.from(pptx.bytes).toString("latin1");
  expect(zip).toContain("ppt/media/image1.png");
  expect(pptx.report.warnings).toEqual(
    expect.arrayContaining([expect.objectContaining({ feature: "equation", action: "rasterized" })]),
  );
  expect(pptx.report.warnings.some((warning) => warning.feature === "equation" && warning.action === "dropped")).toBe(false);

  const pdf = await runExport({ kind: "pdf", document, options: {} as never }, undefined, pool);
  expect(Buffer.from(pdf.bytes).subarray(0, 4).toString()).toBe("%PDF");
  // KaTeX's faces were embedded rather than fetched: the PDF names one.
  expect(Buffer.from(pdf.bytes).toString("latin1")).toMatch(/KaTeX/);
});
