/**
 * The PDF export adapter (doc 04 §34).
 *
 * PDF is the fidelity target: what the author saw is what the reader gets. The
 * approach is doc 04 §34.1's — render each slide in headless Chromium and use
 * `printToPDF` — and the reason it is not a screenshot pipeline is worth stating
 * plainly, because a screenshot pipeline is easier and looks identical at first:
 * printing keeps **text as vector text**. The result is selectable, searchable,
 * and readable at any zoom. A rasterised page is a picture of a deck.
 *
 * This package owns the *assembly*: which slides, in what order, at what frame,
 * with what warnings. The Chromium half lives in `apps/worker` because it needs a
 * browser, and the split keeps the adapter contract testable without one — the
 * page renderer arrives as a function.
 *
 * Doc 04 §34.3's failure modes are handled where they occur, and every one of
 * them produces a file that looks fine until someone reads it closely:
 * fonts not settled (text shifted), decode not awaited (blank images), content a
 * pixel over the page (an extra blank page), `printBackground` off (no
 * background). The first three are the render service's; the last is here.
 */

import {
  DegradationLedger,
  slidesToExport,
  type ExportAdapter,
  type ExportCapability,
  type ExportInput,
  type ExportResult,
} from "@deckastra/export-core";

/**
 * Doc 04 §32.2.
 *
 * `supportsVectorText` and `supportsBlur` are both true and both matter: PDF is
 * the one target that reproduces the deck rather than approximating it. What it
 * cannot do is move — a PDF has no animation, so every slide is one frame, and
 * §34.2 says which frame by default.
 */
export const PDF_CAPABILITIES: ExportCapability = {
  supportsBlur: true,
  supportsMorph: false,
  supportsVideo: false,
  supportsAnimation: false,
  supportsVectorText: true,
  supportsInteractivity: false,
  maxImageDpi: 300,
};

/**
 * Renders the whole deck to one PDF.
 *
 * The whole deck, not a slide at a time. Chromium paginates a single page with
 * CSS page breaks, so one `printToPDF` call produces one document — where
 * rendering per slide would leave N single-page PDFs to merge, and merging means
 * parsing cross-reference tables and renumbering every object. The browser
 * already knows how to do this correctly.
 *
 * Injected rather than imported so this package does not depend on Playwright:
 * a caller with a browser supplies the real one, and a test supplies a stub.
 */
export type DocumentRenderer = (input: {
  slideIds: string[];
  atTime: "final" | "initial" | number;
}) => Promise<Uint8Array>;

export interface PdfArtifact {
  bytes: Uint8Array;
  result: ExportResult;
}

export async function buildPdf(
  input: ExportInput,
  renderDocument: DocumentRenderer,
): Promise<PdfArtifact> {
  const startedAt = Date.now();
  const ledger = new DegradationLedger();
  const { document, scenes, options } = input;

  const ids = slidesToExport(document, options);
  const atTime = options.atTime ?? "final";

  if (atTime !== "final") {
    ledger.record({
      severity: "info",
      slideId: "",
      feature: "animation",
      action: "flattened",
      message:
        atTime === "initial"
          ? "Slides were captured before their animations ran, so anything revealed on click is not in this PDF."
          : `Slides were captured at ${atTime}ms of their animation.`,
    });
  }

  const renderable: string[] = [];

  for (const slideId of ids) {
    input.signal?.throwIfAborted();

    const scene = scenes.get(slideId);
    if (!scene) {
      // Dropped from the page list rather than rendered blank: a blank page in a
      // PDF looks like a design choice, and the reader has no way to tell it
      // apart from one.
      ledger.record({
        severity: "warning",
        slideId,
        feature: "slide",
        action: "dropped",
        message: "This slide had no resolved scene and is missing from the PDF.",
      });
      continue;
    }

    // Every animated element is frozen; the reader gets a still. Reported once
    // per slide that animates rather than per element — a hundred lines saying
    // "PDFs do not animate" is a report nobody reads.
    if ((scene.animations ?? []).length > 0) {
      ledger.record({
        severity: "info",
        slideId,
        feature: "animation",
        action: "flattened",
        message: "Animation is not part of a PDF; this slide is a single frame.",
      });
    }

    renderable.push(slideId);
  }

  const bytes =
    renderable.length > 0
      ? await renderDocument({ slideIds: renderable, atTime })
      : new Uint8Array();

  for (const font of input.fontManifest) {
    if (font.available) continue;
    // Doc 04 §34.2 and §18.5: a face that is not there is substituted, and the
    // substitution changes the metrics. Saying so is the difference between a
    // reader noticing and a reader being surprised.
    ledger.record({
      severity: "warning",
      slideId: "",
      feature: `font:${font.family}`,
      action: "approximated",
      message: `"${font.family}" was not available, so a metric-matched substitute was embedded.`,
    });
  }

  return {
    bytes,
    result: {
      artifactUri: "",
      bytes: bytes.length,
      report: ledger.report(renderable.length, Date.now() - startedAt),
    },
  };
}

/**
 * A PDF's page count, read from its own object catalogue.
 *
 * Used to check that the file has one page per slide (doc 04 §34.2) — the "extra
 * blank page" failure mode in §34.3 is invisible in every other assertion, and
 * an off-by-one there ships a deck with a blank sheet between every slide.
 */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  const counts = [...text.matchAll(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/g)].map(
    (match) => Number(match[1]),
  );
  if (counts.length > 0) return Math.max(...counts);

  // No page tree found: fall back to counting page objects. A malformed PDF
  // reports 0 rather than throwing, because the caller's next move is a warning
  // either way.
  return [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
}

export function pdfAdapter(
  renderDocument: DocumentRenderer,
  write: (bytes: Uint8Array) => Promise<string>,
): ExportAdapter {
  return {
    id: "pdf",
    capabilities: PDF_CAPABILITIES,
    async export(input: ExportInput): Promise<ExportResult> {
      const artifact = await buildPdf(input, renderDocument);
      const artifactUri = await write(artifact.bytes);
      return { ...artifact.result, artifactUri };
    },
  };
}
