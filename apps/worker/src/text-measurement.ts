import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
// Either backend: Playwright in a checkout, Electron in the desktop app.
import type { RenderPage as Page } from "./render-page";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import {
  buildDocumentScene, defaultTextMeasurer,
  type MeasureRequest, type TextMeasurer, type TextMetrics,
} from "@deckastra/renderer";
import type * as BrowserMeasurement from "./measurement-browser";

// Cache whole requests: measuring shrinkToFit in the browser can visit different
// font sizes from the estimator. Caching its intermediate size probes is unsafe.
export function measurementKey(request: MeasureRequest): string {
  return JSON.stringify([
    request.content, request.typography, request.maxWidth, request.maxHeight,
    request.fit, request.minFontSize, request.maxFontSize,
  ]);
}

export class RecordingMeasurer implements TextMeasurer {
  readonly requests = new Map<string, MeasureRequest>();
  measure(request: MeasureRequest): TextMetrics {
    this.requests.set(measurementKey(request), structuredClone(request));
    return defaultTextMeasurer.measure(request);
  }
}

export class CachedMeasurer implements TextMeasurer {
  constructor(private readonly cache: ReadonlyMap<string, TextMetrics>) {}
  measure(request: MeasureRequest): TextMetrics {
    // A future layout dependency may introduce a new request on pass two. Keep
    // the fallback honest: its estimated flag reaches the scene/export report.
    return this.cache.get(measurementKey(request)) ?? defaultTextMeasurer.measure(request);
  }
}

let bundle: Promise<string> | undefined;

/**
 * The measurer, as a script to inject into the page.
 *
 * Built from source with esbuild in a checkout, so a change to the measurer is
 * in the next export with no build step. That is wrong in a packaged app twice
 * over: the TypeScript source is not shipped, and neither is esbuild. So a build
 * can hand the finished script over in `DECKASTRA_MEASURER_JS` and this reads it
 * instead — same string, produced earlier.
 *
 * Never generated into the repository. A committed build artifact of a source
 * file next to it is a second definition, and the two drift the first time
 * someone edits the source and does not regenerate.
 */
function browserBundle(): Promise<string> {
  const prebuilt = process.env.DECKASTRA_MEASURER_JS;
  if (prebuilt) {
    bundle ??= readFile(prebuilt, "utf8");
    return bundle;
  }

  // Imported here, not at the top of the module. A static import is resolved
  // before any of this file runs, so the packaged exporter — which never takes
  // this branch — still failed to load at all: "Cannot find package 'esbuild'",
  // before it had read a byte of its request. Only a checkout reaches this line,
  // and a checkout has esbuild.
  bundle ??= import("esbuild")
    .then(({ build }) =>
      build({
        entryPoints: [fileURLToPath(new URL("./measurement-browser.ts", import.meta.url))],
        bundle: true, write: false, platform: "browser", format: "iife",
        globalName: "DeckastraMeasurement", target: "es2022",
      }),
    )
    .then((result) => result.outputFiles[0]!.text);
  return bundle;
}

/** Doc 04 §31.2: one asynchronous batch between two synchronous scene builds. */
export async function buildBrowserScene(deck: PresentationDocument, page: Page) {
  const recording = new RecordingMeasurer();
  buildDocumentScene(deck, { measurer: recording });
  // Per-page/deck cache: font state must never leak between warm-pool jobs.
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  await page.addScriptTag({ content: await browserBundle() });
  const requests = [...recording.requests.entries()];
  const measured = await page.evaluate(async (batch) => {
    const service = (globalThis as unknown as {
      DeckastraMeasurement: typeof BrowserMeasurement;
    }).DeckastraMeasurement;
    return service.measureBatch(batch);
  }, requests.map(([, request]) => request));
  const cache = new Map<string, TextMetrics>();
  requests.forEach(([key], index) => {
    const metrics = measured.metrics[index];
    if (metrics) cache.set(key, metrics);
  });
  return buildDocumentScene(deck, {
    measurer: new CachedMeasurer(cache),
    fonts: { available: new Set(measured.fonts.available), unknown: measured.fonts.unknown },
  });
}
