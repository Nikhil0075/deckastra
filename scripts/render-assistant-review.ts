/** Render recorded review inputs with the production headless renderer; no inference. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PresentationDocumentSchema } from "@deckastra/presentation-schema";
import { flattenScene } from "@deckastra/renderer";
import { RenderPool, render, renderDeadlineFor } from "../apps/worker/src/render";
import { AssetLibrary, type InlineAsset } from "../apps/worker/src/assets";
import { pageFontCss } from "../apps/worker/src/fonts";
import { buildBrowserScene } from "../apps/worker/src/text-measurement";

async function main() {
const directory = resolve(process.argv[2] ?? "docs/evaluations/2026-10-05/repair-02");
const report = JSON.parse(readFileSync(join(directory, "critique.json"), "utf8"));
const fixture = resolve("docs/integrations/benchmarks/advanced-deck/advanced");
const fixtureIds = JSON.parse(readFileSync(join(fixture, "ids.json"), "utf8"));
const knownAssets = new Map([[fixtureIds.IMG_ID, "adoption.png"], [fixtureIds.DECO_ID, "swoosh.png"]]);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(join(directory, "previews"), { recursive: true });
const manifest: any = { version: 1, frame: "final", scale: 1, cases: {}, decks: {},
  notice: "Original source deck, with its existing defects. Static final-frame view; gold outlines mark the case selection. The AI did not see these renders or the supplied fixture images. Missing assets stay placeholders. Review motion and narration in the source data." };
const pool = new RenderPool({ timeoutMs: renderDeadlineFor(21) });
try {
  for (const recorded of report.cases) {
    const input = recorded.review_input.document;
    const document = PresentationDocumentSchema.parse(input);
    const documentHash = hash(JSON.stringify(input));
    manifest.cases[recorded.id] = { deck: documentHash, slide_id: recorded.slide_id,
      scope: recorded.review_input.request.scope };
    if (manifest.decks[documentHash]) continue;
    const assets: InlineAsset[] = [];
    const supplied = [];
    for (const entry of document.assets ?? []) {
      const name = knownAssets.get(entry.id);
      if (!name) continue;
      const bytes = readFileSync(join(fixture, name));
      assets.push({ assetId: entry.id, storageKey: entry.storageKey, mimeType: "image/png", data: bytes.toString("base64") });
      supplied.push({ asset_id: entry.id, filename: name, sha256: hash(bytes) });
    }
    const response = await render({ document, assets, format: "png", scale: 1, atTimeMs: "final" }, pool);
    const library = new AssetLibrary(assets);
    const scene = await pool.withPage(1, async page => buildBrowserScene(document, page, await pageFontCss(document, library)));
    const slides = response.artifacts.map((artifact, index) => {
      const path = "previews/" + hash(artifact.bytes).slice(0, 24) + ".png";
      writeFileSync(join(directory, path), artifact.bytes);
      const source = document.slides.find(slide => slide.id === artifact.slideId)!;
      const resolved = scene.slides.find(slide => slide.slideId === artifact.slideId)!;
      return { id: artifact.slideId, number: index + 1, name: source.name ?? `Slide ${index + 1}`,
        image: path, image_sha256: hash(artifact.bytes), width: artifact.width, height: artifact.height,
        elements: flattenScene(resolved).map(node => ({ id: node.id, name: node.name ?? node.type, bounds: node.bounds })) };
    });
    manifest.decks[documentHash] = { title: document.metadata.title, slides, supplied_assets: supplied,
      warnings: response.warnings, metrics_estimated: response.metricsEstimated };
    process.stdout.write(`Rendered ${slides.length} source slides for ${recorded.id}\n`);
  }
} finally { await pool.close(); }
writeFileSync(join(directory, "preview-manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(`Prepared previews for ${Object.keys(manifest.cases).length} recorded critique cases.\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
