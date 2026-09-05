import type { RichTextDocument, TextFit, TypographyStyle } from "@deckastra/presentation-schema";

import { fontMetrics } from "./fonts";

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
 * Fallback average glyph advance, as a fraction of font size (doc 04 §6.4).
 *
 * Used only when the family is unknown to the font registry. A curated family
 * carries its own measured advance, which is a materially better estimate — a
 * monospace face advances at 0.60 and Times at 0.49, and treating both as 0.52
 * mis-wraps a code block one way and a serif quote the other.
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
 * Per-character width, as a multiple of the family's average advance.
 *
 * A flat average is wrong in a way that matters: "Illinois" and "WWWWWWWW" have
 * the same character count and nearly double the width between them. Since the
 * estimator's whole job is deciding whether a line wraps, that difference is the
 * difference between a headline that fits and one that spills over the subtitle.
 *
 * These are ratios, not measurements of any particular face — a narrow glyph is
 * narrow in every Latin font. They are close enough to get the wrap count right
 * far more often than a flat average, and they cost one table lookup.
 *
 * Calibrated against canvas measurements of Inter at 96px so that the weighted
 * mean lands on 1.0 for ordinary prose. That step is not optional: a table whose
 * mean is 0.88 makes every estimate 12% narrow, which is exactly the margin that
 * turns a three-line headline into a predicted two-line one and lets it overflow.
 */
const NARROW = new Set([..."ijlIftr.,;:!|'`()[]{}/\\ "]);
const WIDE = new Set([..."mwMW@%&"]);
const DIGIT = /[0-9]/;

function characterWidth(char: string): number {
  if (NARROW.has(char)) return 0.55;
  if (WIDE.has(char)) return 1.75;
  if (DIGIT.test(char)) return 1.15;
  // An uppercase letter is meaningfully wider than a lowercase one.
  if (char >= "A" && char <= "Z") return 1.36;
  return 1.13;
}

/** Bold is wider. Small, but it is the difference on a line that only just fits. */
function weightFactor(weight: number | undefined): number {
  return (weight ?? 400) >= 600 ? 1.03 : 1;
}

/** Estimated width of a string, in the same units the caller's advance is in. */
function textWidth(text: string, advance: number): number {
  let total = 0;
  for (const char of text) total += characterWidth(char) * advance;
  return total;
}

/**
 * Greedy word wrap.
 *
 * Browsers break on whitespace and only break inside a word when a single word
 * exceeds the line, which is what this does. Counting characters and dividing —
 * the previous approach — systematically *under*-counts lines for real prose,
 * because it assumes a break can happen anywhere.
 */
function wrapCount(text: string, maxWidth: number, advance: number): { rows: number; widest: number } {
  if (text === "") return { rows: 1, widest: 0 };

  const words = text.split(/(\s+)/).filter((part) => part !== "");
  let rows = 1;
  let current = 0;
  let widest = 0;

  for (const word of words) {
    const width = textWidth(word, advance);

    // Trailing whitespace does not push a line over; browsers hang it.
    if (/^\s+$/.test(word)) {
      if (current > 0) current += width;
      continue;
    }

    if (current > 0 && current + width > maxWidth) {
      widest = Math.max(widest, current);
      rows += 1;
      current = width;
    } else {
      current += width;
    }

    // A single word longer than the line breaks inside itself.
    while (current > maxWidth) {
      widest = Math.max(widest, maxWidth);
      rows += 1;
      current -= maxWidth;
    }
  }

  return { rows, widest: Math.max(widest, current) };
}

/**
 * Estimating measurer. Deterministic given the same input, which matters more
 * than being right: a non-deterministic estimate would make the scene
 * non-reproducible and break byte-identical render tests.
 *
 * Still an estimate, and still flagged `estimated: true` — a real measurement
 * needs a DOM, which the scene builder deliberately does not have so that scenes
 * stay buildable in Node for the headless render service.
 */
export class EstimatingTextMeasurer implements TextMeasurer {
  measure(request: MeasureRequest): TextMetrics {
    const { content, typography, maxWidth, maxHeight, fit } = request;
    const lineHeight = typography.lineHeight ?? fontMetrics(typography.fontFamily).lineHeight;
    const letterSpacing = typography.letterSpacing ?? 0;

    const lines = plainLines(content);
    const metrics = fontMetrics(typography.fontFamily);
    const advanceRatio = metrics.averageAdvance || AVERAGE_ADVANCE;

    const weight = weightFactor(typography.fontWeight);

    const layoutAt = (fontSize: number) => {
      const advance = (fontSize * advanceRatio + letterSpacing) * weight;

      let wrapped = 0;
      let widest = 0;
      for (const line of lines) {
        const { rows, widest: lineWidth } = wrapCount(line, maxWidth, advance);
        wrapped += rows;
        widest = Math.max(widest, lineWidth);
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
