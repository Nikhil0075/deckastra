import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { PresentationDocumentSchema } from "@deckastra/presentation-schema";
import { documentDigest } from "@deckastra/renderer";
import { sceneUsedEstimatedMetrics } from "@deckastra/export-core";
import { pdfPageCount } from "@deckastra/export-pdf";
import { RenderPool, render, runExport } from "../src/index";
import { buildBrowserScene } from "../src/text-measurement";
type EditorBrowser = { editorDigest(deck: ReturnType<typeof fixture>): string };

function fixture(name: string) {
  return PresentationDocumentSchema.parse(JSON.parse(readFileSync(new URL(
    `../../../packages/presentation-schema/fixtures/${name}.mydeck.json`, import.meta.url,
  ), "utf8")));
}

describe("real browser text measurement", () => {
  const pool = new RenderPool();
  afterAll(() => pool.close());

  it.each(["animation-test", "technical-deck", "repository-context"])(
    "%s matches the editor's resolved scene digest with no estimates", async (name) => {
      const deck = fixture(name);
      await pool.withPage(1, async (page) => {
        const worker = await buildBrowserScene(deck, page);
        expect(worker.slides.some(sceneUsedEstimatedMetrics)).toBe(false);
        const bundle = await build({
          entryPoints: [fileURLToPath(new URL("./editor-browser.js", import.meta.url))],
          bundle: true, write: false, format: "iife", globalName: "EditorComparison", platform: "browser",
        });
        await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
        const editor = await page.evaluate((document) => (globalThis as unknown as {
          EditorComparison: EditorBrowser;
        }).EditorComparison.editorDigest(document), deck);
        expect(documentDigest(worker)).toBe(editor);
      }, 60_000);
    }, 60_000,
  );

  it("matches the editor across wrapping, paragraphs, fit modes and font bounds", async () => {
    const deck = fixture("animation-test");
    deck.slides = [deck.slides[0]!];
    const template = deck.slides[0]!.elements[0]!;
    deck.slides[0]!.elements = ["fixed", "autoHeight", "growBox", "shrinkToFit"].map((fit, index) => ({
      ...structuredClone(template), id: `${template.id}_${index}`, fit,
      transform: { x: index * 300, y: 50, width: 230 + index, height: 85 },
      minFontSize: 12, maxFontSize: 64,
      typography: { fontFamily: "Arial", fontSize: 48, fontWeight: 400, lineHeight: 1.35 },
      content: { version: 1, blocks: [
        { id: "paragraph1", type: "paragraph", spans: [{ text: "WWW Illinois wrapping punctuation, café 中文. ".repeat(5) }] },
        { id: "paragraph2", type: "paragraph", spans: [{ text: "Second paragraph changes the height budget." }] },
      ] },
    }));
    await pool.withPage(1, async (page) => {
      const worker = await buildBrowserScene(deck, page);
      expect(worker.slides.some(sceneUsedEstimatedMetrics)).toBe(false);
      const bundle = await build({
        entryPoints: [fileURLToPath(new URL("./editor-browser.js", import.meta.url))],
        bundle: true, write: false, format: "iife", globalName: "EditorComparison", platform: "browser",
      });
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      const editor = await page.evaluate((document) => (globalThis as unknown as {
        EditorComparison: EditorBrowser;
      }).EditorComparison.editorDigest(document), deck);
      expect(documentDigest(worker)).toBe(editor);
    }, 60_000);
  }, 60_000);

  it("PNG, PDF and PPTX reports use measured scenes", async () => {
    const deck = fixture("animation-test");
    deck.slides = [deck.slides[0]!];
    const png = await render({ document: deck, format: "png" }, pool);
    expect(png.metricsEstimated).toBe(false);
    expect(png.artifacts[0]!.bytes.length).toBeGreaterThan(100);
    for (const kind of ["pdf", "pptx"] as const) {
      const artifact = await runExport({ kind, document: deck, options: {} }, undefined, pool);
      expect(artifact.report.metricsEstimated).toBe(false);
      expect(artifact.bytes.length).toBeGreaterThan(100);
      if (kind === "pdf") expect(pdfPageCount(artifact.bytes)).toBe(1);
    }
  }, 60_000);

  it("keeps overlapping renders isolated on the shared warm pool", async () => {
    const first = fixture("animation-test");
    const second = fixture("technical-deck");
    first.slides = [first.slides[0]!];
    second.slides = [second.slides[1]!];

    const [firstResult, secondResult] = await Promise.all([
      render({ document: first, format: "png" }, pool),
      render({ document: second, format: "png" }, pool),
    ]);

    expect(firstResult.artifacts[0]?.slideId).toBe(first.slides[0]!.id);
    expect(secondResult.artifacts[0]?.slideId).toBe(second.slides[0]!.id);
    expect(firstResult.artifacts[0]!.bytes.length).toBeGreaterThan(100);
    expect(secondResult.artifacts[0]!.bytes.length).toBeGreaterThan(100);
  }, 60_000);
});
