import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { encodeWav } from "@deckastra/renderer";

import { runExport } from "../src/index";
import { RenderPool } from "../src/render";
import { bundledFamiliesUsed, pageFontCss } from "../src/fonts";
import { AssetLibrary } from "../src/assets";

/**
 * Exporting a deck in another language, with its narration (integration plan
 * 01 §3.10), in real Chromium: the overlay is applied before anything is
 * measured, the script's own face is declared on the render page, and the
 * PowerPoint carries the recordings for that language.
 */

let pool: RenderPool;
beforeAll(() => {
  pool = new RenderPool({ timeoutMs: 90_000 });
});
afterAll(async () => {
  await pool.close();
});

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : data);
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

function narrationAssets(document: ReturnType<typeof loadFixture>) {
  return document.assets
    .filter((asset) => asset.type === "audio")
    .map((asset) => {
      const samples = new Float32Array(Math.round(((asset.durationMs ?? 1000) / 1000) * 8000));
      return {
        assetId: asset.id,
        storageKey: asset.storageKey,
        mimeType: "audio/wav",
        data: Buffer.from(encodeWav(samples, 8000)).toString("base64"),
      };
    });
}

it("exports the Hindi deck to PowerPoint with Hindi words and the Hindi recordings", async () => {
  const document = loadFixture("multilingual");
  const outcome = await runExport(
    { kind: "pptx", document, options: { locale: "hi-IN" } as never, assets: narrationAssets(document) },
    undefined,
    pool,
  );
  expect(outcome.filename).toBe("Multilingual-Narrated-Deck-hi-IN.pptx");
  const files = unzip(outcome.bytes);
  const decode = (path: string) => new TextDecoder().decode(files.get(path));
  expect(decode("ppt/slides/slide1.xml")).toContain("एक डेक, हर भाषा");
  expect(decode("ppt/slides/slide1.xml")).not.toContain("One deck, every language");
  // Four Hindi lines and the pop: the English takes are not in the file.
  expect(decode("ppt/slides/slide2.xml").match(/<a:audioFile /g)).toHaveLength(5);
  const hindiTakes = document.slides[1]!.narration!.cues.map((cue) => cue.takes!["hi-IN"]!.assetId);
  const relationships = decode("ppt/slides/_rels/slide2.xml.rels");
  expect(relationships.match(/relationships\/audio"/g)).toHaveLength(5);
  expect(hindiTakes.length).toBe(4);
  expect(outcome.report.warnings.some((warning) => warning.feature === "narrated playback")).toBe(true);
}, 120_000);

it("declares the Devanagari face on the render page for a Hindi export", async () => {
  const document = loadFixture("multilingual");
  document.metadata.language = "hi-IN";
  expect(bundledFamiliesUsed(document).map((font) => font.family)).toContain("Noto Sans Devanagari");
  const css = await pageFontCss(document, new AssetLibrary([]));
  expect(css).toMatch(/font-family: 'Noto Sans Devanagari Variable'[\s\S]*unicode-range: U\+0900-097F/);
});

it("refuses a language the deck does not have, rather than exporting the original under its name", async () => {
  await expect(runExport({ kind: "pdf", document: loadFixture("multilingual"), options: { locale: "fr" } as never }, undefined, pool)).rejects.toThrow(/no fr translation/);
});

it("says a PDF cannot carry the narration", async () => {
  const document = loadFixture("multilingual");
  const outcome = await runExport({ kind: "pdf", document, options: { locale: "hi-IN" } as never }, undefined, pool);
  expect(outcome.report.warnings.some((warning) => warning.feature === "audio" && warning.action === "dropped")).toBe(true);
  expect(outcome.filename).toBe("Multilingual-Narrated-Deck-hi-IN.pdf");
}, 120_000);
