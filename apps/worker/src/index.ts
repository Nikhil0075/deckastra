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
import { sameLanguage, sourceLocale, type PresentationDocument } from "@deckastra/presentation-schema";
import { localeOperations } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";
import type { SlideScene } from "@deckastra/renderer";
import { buildPdf } from "@deckastra/export-pdf";
import { buildPptx } from "@deckastra/export-pptx";

import { RenderPool, captureEquations, renderDeadlineFor, renderPdfScene } from "./render";
import { buildBrowserScene } from "./text-measurement";
import { fontsNotEmbedded, pageFontCss } from "./fonts";
import { fontFilesInCss, repairPdfText } from "./pdf-unicode";
import { AssetLibrary, type InlineAsset } from "./assets";
import { renderVideo, type VideoExportOptions } from "./video";

export type ExportKind = "pdf" | "pptx" | "mp4";

export interface ExportJob {
  kind: ExportKind;
  document: PresentationDocument;
  options: VideoExportOptions;
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
  mp4: "video/mp4",
};

export async function runExport(
  job: ExportJob,
  onProgress: (progress: ExportProgress) => void = () => undefined,
  pool?: RenderPool,
): Promise<ExportOutcome> {
  onProgress({ progress: 0, stage: "resolving", message: "Resolving slides" });

  // The language to export (integration plan 01 §3.10): the deck with that
  // language's overlay applied, through the one applier, before anything is
  // measured — a Hindi headline shrinks to fit as Hindi, not as English.
  const locale = (job.options as { locale?: unknown }).locale;
  // Named after the deck's own title: a translated one in another script
  // would be all but stripped by `safeName`, and the tag says the language.
  const title = job.document.metadata.title;
  if (typeof locale === "string" && locale && !sameLanguage(locale, sourceLocale(job.document))) {
    if (!job.document.locales?.[locale]) throw new Error(`This deck has no ${locale} translation to export.`);
    job = { ...job, document: applyPatch(job.document, localeOperations(job.document, locale)).document };
  }

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
    const fontCss = await pageFontCss(job.document, library);
    const scene = await buildBrowserScene(job.document, page, fontCss);
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
      audio: library.audio(),
      videos: library.videos(),
    };

    const filename = `${safeName(title)}${typeof locale === "string" && locale ? `-${safeName(locale)}` : ""}.${job.kind}`;

    if (job.kind === "mp4") {
      onProgress({ progress: 0.2, stage: "rendering", message: "Rendering deterministic video frames" });
      const artifact = await renderVideo(job.document, scene, page, library, job.options as VideoExportOptions, fontCss, (done, total) => {
        onProgress({ progress: 0.2 + 0.65 * done / total, stage: "rendering", message: `Rendering video frame ${done} of ${total}` });
      });
      onProgress({ progress: 1, stage: "done", message: "Done" });
      return { bytes: artifact.bytes, report: artifact.report, filename, contentType: CONTENT_TYPES.mp4 };
    }

    if (job.kind === "pptx") {
      onProgress({ progress: 0.3, stage: "writing", message: "Building the PowerPoint package" });
      const equations = await captureEquations([...scenes.values()], page, fontCss);
      const artifact = buildPptx(
        equations.size ? { ...input, images: new Map([...input.images, ...equations]) } : input,
      );
      // Whatever the deck cites and the exporter was not given. PPTX draws its
      // own placeholder for one, which is reported by the adapter; this covers
      // the ones the API could not supply at all, with the reason it gave.
      for (const warning of library.problems([...scenes.values()])) {
        if (!artifact.result.report.warnings.some((one) => one.feature === warning.feature)) {
          artifact.result.report.warnings.push(warning);
        }
      }
      artifact.result.report.warnings.push(...fontsNotEmbedded(job.document));
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
      const rendered = await renderPdfScene(scene, slideIds, atTime, page, library, fontCss);
      // Chromium names only the glyphs a font's cmap names; the rest of a
      // Hindi or Arabic page copies out as U+0000. `repairPdfText` adds the
      // characters the fonts' own substitutions say those glyphs are.
      const repaired = await repairPdfText(rendered.bytes, fontFilesInCss(fontCss), rendered.paragraphs);
      // The warnings come back now, because whether a picture decoded is only
      // known once the browser has tried — see `DocumentRenderResult`.
      return { bytes: repaired.bytes, warnings: rendered.warnings };
    });

    // A PDF cannot carry sound (integration plan 01 §3.10). Said once per slide
    // that has narration or sounds, so nobody hands out a "narrated" PDF.
    for (const slide of job.document.slides) {
      if (!ids.includes(slide.id) || !(slide.narration?.cues.length || slide.soundCues?.length)) continue;
      artifact.result.report.warnings.push({
        severity: "info",
        slideId: slide.id,
        feature: "audio",
        action: "dropped",
        message: "A PDF cannot carry sound, so this slide's narration and sounds are not in the file. Export to PowerPoint to keep them.",
      });
    }

    onProgress({ progress: 1, stage: "done", message: "Done" });
    return {
      bytes: artifact.bytes,
      report: artifact.result.report,
      filename,
      contentType: CONTENT_TYPES.pdf,
    };
    }, job.kind === "mp4" ? 30 * 60 * 1_000 : renderDeadlineFor(slideCount));
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
export { compileVideoPlan, videoFrameAt, ffmpegArguments, renderVideo } from "./video";
export type { VideoPlan, VideoSlidePlan, VideoAudioEvent, VideoExportOptions } from "./video";
export type { CriticRenderReport, CriticSlideSignals } from "./critic-report";
