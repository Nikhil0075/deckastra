import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PresentationDocumentSchema } from "@deckastra/presentation-schema";
import { buildDocumentScene, defaultTextMeasurer, type MeasureRequest } from "@deckastra/renderer";
import { buildPdf } from "@deckastra/export-pdf";
import { CachedMeasurer, measurementKey, RecordingMeasurer } from "../src/text-measurement";

const deck = PresentationDocumentSchema.parse(JSON.parse(readFileSync(
  new URL("../../../packages/presentation-schema/fixtures/animation-test.mydeck.json", import.meta.url), "utf8",
)));

describe("batch text cache", () => {
  const recording = new RecordingMeasurer();
  buildDocumentScene(deck, { measurer: recording });
  const request = [...recording.requests.values()][0]!;

  it("records distinct complete requests and reuses duplicate requests", () => {
    const recorder = new RecordingMeasurer();
    recorder.measure(request);
    recorder.measure(structuredClone(request));
    const variants: Partial<MeasureRequest>[] = [
      { maxWidth: request.maxWidth + 1 }, { maxHeight: request.maxHeight + 1 },
      { fit: "shrinkToFit" }, { minFontSize: 11 }, { maxFontSize: 97 },
      { typography: { ...request.typography, fontWeight: 300 } },
      { content: { version: 1, blocks: [] } },
    ];
    for (const variant of variants) recorder.measure({ ...request, ...variant });
    expect(recorder.requests.size).toBe(variants.length + 1);
  });

  it("uses cached DOM metrics and honestly marks a new request as estimated", () => {
    const measured = { ...defaultTextMeasurer.measure(request), estimated: false, lineCount: 42 };
    const cache = new CachedMeasurer(new Map([[measurementKey(request), measured]]));
    expect(cache.measure(structuredClone(request))).toEqual(measured);
    expect(cache.measure({ ...request, maxHeight: request.maxHeight + 1 }).estimated).toBe(true);
  });

  it("propagates real cache misses to the PDF report", async () => {
    const scene = buildDocumentScene(deck, { measurer: new CachedMeasurer(new Map()) });
    const artifact = await buildPdf({
      document: deck, scenes: new Map(scene.slides.map((slide) => [slide.slideId, slide])),
      fontManifest: [], options: {},
    }, async () => new Uint8Array([1]));
    expect(artifact.result.report.metricsEstimated).toBe(true);
  });
});
