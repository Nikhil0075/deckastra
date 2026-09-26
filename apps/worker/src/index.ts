/**
 * Export as a job (doc 04 §32.4, doc 05 §8).
 *
 * A 60-slide PDF at 2× takes tens of seconds, which is longer than any HTTP
 * request should live. So an export is a job: the API returns an id, the worker
 * does the work, and progress arrives as events. Doc 04 §43.4 notes this is also
 * the shape the MCP export tool needs, so building it request-bound now would
 * mean building it twice.
 *
 * The job runner here is deliberately a *function over a progress callback*
 * rather than a queue client. What lives in a queue is a deployment decision;
 * what the work does is not, and keeping them apart means the whole export path
 * is runnable in a test, from a CLI, or from a worker loop without changing.
 */

import {
  fontManifest,
  slidesToExport,
  type ExportOptions,
  type ExportReport,
} from "@deckastra/export-core";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { SlideScene } from "@deckastra/renderer";
import { buildPdf } from "@deckastra/export-pdf";
import { buildPptx } from "@deckastra/export-pptx";

import { RenderPool, renderDeadlineFor, renderPdfScene } from "./render";
import { buildBrowserScene } from "./text-measurement";
import { AssetLibrary, type InlineAsset } from "./assets";

export type ExportKind = "pdf" | "pptx";

export interface ExportJob {
  kind: ExportKind;
  document: PresentationDocument;
  options: ExportOptions;
  /**
   * The deck's pictures, as bytes.
   *
   * Handed in rather than fetched: the render host has no session and no network
   * (see `assets.ts`). Absent, every image in the deck exports as the renderer's
   * labelled placeholder — which is what every export did before this existed.
   */
  assets?: InlineAsset[];
}

export interface ExportProgress {
  /** 0..1. Coarse on purpose: three honest stages beat a fake smooth bar. */
  progress: number;
  stage: "resolving" | "rendering" | "writing" | "done";
  message: string;
}

export interface ExportOutcome {
  bytes: Uint8Array;
  report: ExportReport;
  /** The filename a browser should offer. */
  filename: string;
  contentType: string;
}

const CONTENT_TYPES: Record<ExportKind, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function runExport(
  job: ExportJob,
  onProgress: (progress: ExportProgress) => void = () => undefined,
  pool?: RenderPool,
): Promise<ExportOutcome> {
  onProgress({ progress: 0, stage: "resolving", message: "Resolving slides" });

  const owned = pool ?? new RenderPool();
  const library = new AssetLibrary(job.assets);
  try {
    // Sized to this deck, not to a constant: the lease covers measuring and
    // rendering every slide, and sixty of them do not fit in the twenty seconds
    // five of them did (item 30).
    const slideCount = Array.isArray((job.document as { slides?: unknown[] }).slides)
      ? (job.document as { slides: unknown[] }).slides.length
      : 1;
    return await owned.withPage(1, async (page) => {
    // Final measured scenes are shared with the adapter (doc 04 §32.1). An adapter
    // that resolved its own would be a second layout engine, free to disagree with
    // what the author approved on screen.
    const scene = await buildBrowserScene(job.document, page);
    const scenes = new Map<string, SlideScene>(
      scene.slides.map((slide) => [slide.slideId, slide]),
    );

    const input = {
      document: job.document,
      scenes,
      fontManifest: fontManifest(scenes.values()),
      options: job.options,
      // PDF reaches its pictures through the render page as `data:` URLs; PPTX
      // embeds them as parts, so it needs the bytes. Same library, two shapes.
      images: library.images(),
    };

    const filename = `${safeName(job.document.metadata.title)}.${job.kind}`;

    if (job.kind === "pptx") {
      onProgress({ progress: 0.3, stage: "writing", message: "Building the PowerPoint package" });
      const artifact = buildPptx(input);
      // Whatever the deck cites and the exporter was not given. PPTX draws its
      // own placeholder for one, which is reported by the adapter; this covers
      // the ones the API could not supply at all, with the reason it gave.
      for (const warning of library.problems([...scenes.values()])) {
        if (!artifact.result.report.warnings.some((one) => one.feature === warning.feature)) {
          artifact.result.report.warnings.push(warning);
        }
      }
      onProgress({ progress: 1, stage: "done", message: "Done" });
      return {
        bytes: artifact.bytes,
        report: artifact.result.report,
        filename,
        contentType: CONTENT_TYPES.pptx,
      };
    }

    const ids = slidesToExport(job.document, job.options);

    onProgress({
      progress: 0.2,
      stage: "rendering",
      message: `Rendering ${ids.length} slide${ids.length === 1 ? "" : "s"}`,
    });

    const artifact = await buildPdf(input, async ({ slideIds, atTime }) => {
      const rendered = await renderPdfScene(scene, slideIds, atTime, page, library);
      // The warnings come back now, because whether a picture decoded is only
      // known once the browser has tried — see `DocumentRenderResult`.
      return { bytes: rendered.bytes, warnings: rendered.warnings };
    });

    onProgress({ progress: 1, stage: "done", message: "Done" });
    return {
      bytes: artifact.bytes,
      report: artifact.result.report,
      filename,
      contentType: CONTENT_TYPES.pdf,
    };
    }, renderDeadlineFor(slideCount));
  } finally {
    // Only close a pool this call created. A caller that passed one is running
    // several exports through a warm browser, and closing it here would make
    // every export after the first pay the launch cost again.
    if (!pool) await owned.close();
  }
}

/**
 * A filename from a deck title.
 *
 * Conservative rather than clever: the result goes into a
 * `Content-Disposition` header and onto a filesystem, and a title is user
 * input. Anything outside a small allowlist becomes a hyphen.
 */
export function safeName(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);

  return cleaned || "presentation";
}

export {
  RenderPool,
  RenderTimeoutError,
  render,
  renderPdf,
  deckHtml,
  slideHtml,
  PREVIEW_SIZES,
} from "./render";
export type {
  PoolEntry,
  RenderPoolOptions,
  RenderRequest,
  RenderResponse,
  RenderArtifact,
} from "./render";
export { AssetLibrary, MAX_INLINE_ASSET_BYTES, MAX_INLINE_TOTAL_BYTES, neededAssets } from "./assets";
export type { InlineAsset } from "./assets";
export { buildCriticReport } from "./critic-report";
export type { CriticRenderReport, CriticSlideSignals } from "./critic-report";
