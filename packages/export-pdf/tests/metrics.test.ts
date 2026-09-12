import { expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene, defaultTextMeasurer } from "@deckastra/renderer";
import { buildPdf } from "../src/index";

it.each([true, false])("reports the supplied scene's estimated=%s metrics", async (estimated) => {
  const document = loadFixture("animation");
  const scene = buildDocumentScene(document, {
    measurer: { measure: (request) => ({ ...defaultTextMeasurer.measure(request), estimated }) },
  });
  const artifact = await buildPdf({
    document, scenes: new Map(scene.slides.map((slide) => [slide.slideId, slide])),
    fontManifest: [], options: {},
  }, async () => new Uint8Array([1]));
  expect(artifact.result.report.metricsEstimated).toBe(estimated);
});
