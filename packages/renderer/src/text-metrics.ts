import type { RichTextDocument, TextFit, TypographyStyle } from "@deckastra/presentation-schema";

/**
 * Text measurement — pipeline stage 8 (doc 04 §6.1, §17.3).
 *
 * Phase 1 ships the *estimator* only. Real measurement needs a canvas or a DOM,
 * which the scene builder deliberately does not have: the scene must be
 * buildable in Node for the headless render service and for tests.
 *
 * The interface is what matters now. A measured implementation drops in behind it
 * in Phase 3 without the scene builder changing, and anything measured by the
 * estimator is flagged `metricsEstimated: true` so exports know to re-measure
 * rather than trusting a guess (doc 04 §6.4).
 */

export interface TextMetrics {
  width: number;
  height: number;
  lineCount: number;
  /** True when content exceeds the box at the applied font size. */
  overflow: boolean;
  /** Font size actually used after fit resolution, which shrinkToFit may reduce. */
  appliedFontSize: number;
  estimated: boolean;
}

export interface MeasureRequest {
  content: RichTextDocument;
  typography: TypographyStyle;
  maxWidth: number;
  maxHeight: number;
  fit: TextFit;
  minFontSize?: number;
  maxFontSize?: number;
}

export interface TextMeasurer {
  measure(request: MeasureRequest): TextMetrics;
}

/**
 * Average glyph advance as a fraction of font size, the fallback doc 04 §6.4
 * specifies. It is wrong for any specific string and close enough in aggregate to
 * keep a layout from collapsing while real metrics are unavailable.
 */
const AVERAGE_ADVANCE = 0.52;

/** Quantization step for fit results (doc 04 §17.3). Without it, two runs of the
 *  same shrink-to-fit search land on font sizes that differ in the eighth decimal
 *  and produce spurious diffs. */
const FONT_SIZE_STEP = 0.25;

export function quantizeFontSize(size: number): number {
  return Math.round(size / FONT_SIZE_STEP) * FONT_SIZE_STEP;
}

function plainLines(content: RichTextDocument): string[] {
  return content.blocks.map((block) => block.spans.map((span) => span.text).join(""));
}

/**
 * Estimating measurer. Deterministic given the same input, which matters more
 * than being right: a non-deterministic estimate would make the scene
 * non-reproducible and break byte-identical render tests.
 */
export class EstimatingTextMeasurer implements TextMeasurer {
  measure(request: MeasureRequest): TextMetrics {
    const { content, typography, maxWidth, maxHeight, fit } = request;
    const lineHeight = typography.lineHeight ?? 1.3;
    const letterSpacing = typography.letterSpacing ?? 0;

    const lines = plainLines(content);

    const layoutAt = (fontSize: number) => {
      const advance = fontSize * AVERAGE_ADVANCE + letterSpacing;
      const charsPerLine = Math.max(1, Math.floor(maxWidth / Math.max(advance, 0.01)));

      let wrapped = 0;
      let widest = 0;
      for (const line of lines) {
        const rows = Math.max(1, Math.ceil(line.length / charsPerLine));
        wrapped += rows;
        widest = Math.max(widest, Math.min(line.length, charsPerLine) * advance);
      }

      return { lineCount: wrapped, width: widest, height: wrapped * fontSize * lineHeight };
    };

    let fontSize = typography.fontSize;
    let layout = layoutAt(fontSize);

    if (fit === "shrinkToFit" && layout.height > maxHeight) {
      // A bounded search rather than a loop until it fits: a fixed iteration count
      // is what keeps the pipeline deterministic (doc 02 §2.1).
      const floor = request.minFontSize ?? Math.max(12, typography.fontSize * 0.5);
      let low = floor;
      let high = typography.fontSize;

      for (let i = 0; i < 12 && high - low > FONT_SIZE_STEP; i += 1) {
        const mid = quantizeFontSize((low + high) / 2);
        if (layoutAt(mid).height <= maxHeight) low = mid;
        else high = mid;
      }

      fontSize = quantizeFontSize(low);
      layout = layoutAt(fontSize);
    }

    const height = fit === "autoHeight" || fit === "growBox" ? layout.height : maxHeight;

    return {
      width: Math.min(layout.width, maxWidth),
      height,
      lineCount: layout.lineCount,
      overflow: layout.height > maxHeight + 0.5,
      appliedFontSize: quantizeFontSize(fontSize),
      estimated: true,
    };
  }
}

export const defaultTextMeasurer = new EstimatingTextMeasurer();
