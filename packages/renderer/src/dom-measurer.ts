import type { RichTextDocument } from "@deckastra/presentation-schema";
import {
  DomMeasurer,
  quantizeFontSize as quantizeToStep,
  type TextMeasurementService,
} from "@deckastra/layout-engine";

import { fontMetrics } from "./fonts";
import type { MeasureRequest, TextMeasurer, TextMetrics } from "./text-metrics";

/**
 * The measured text measurer (doc 04 §6.4, §17.3).
 *
 * The scene builder deliberately has no DOM — it must run in Node for the
 * headless render service and for tests — so it takes a `TextMeasurer` and the
 * caller decides which one. In Node that is the estimator; in a browser it is
 * this, which puts the real string in a real off-screen element and reads the
 * line boxes back.
 *
 * The difference is not cosmetic. The estimator predicts wrap points from a
 * width table; this one asks the engine that will actually do the wrapping. A
 * headline that the estimator thinks fits on two lines and the browser breaks
 * onto three overflows onto whatever is beneath it, and no amount of calibration
 * removes that class of error — only measuring does.
 *
 * Metrics from here are flagged `estimated: false`, which is what tells an
 * export it may trust them rather than re-measuring.
 */

/** One entry per block, since a block is a paragraph and wraps independently. */
function blockTexts(content: RichTextDocument): string[] {
  return content.blocks.map((block) => block.spans.map((span) => span.text).join(""));
}

class MeasuredTextMeasurer implements TextMeasurer {
  constructor(private readonly service: TextMeasurementService) {}

  measure(request: MeasureRequest): TextMetrics {
    const { content, typography, maxWidth, maxHeight, fit } = request;
    const texts = blockTexts(content);

    const layoutAt = (fontSize: number) => {
      // One batch per candidate size: the DOM measurer writes every element,
      // then reads every element, so a batch costs one layout instead of N.
      const results = this.service.measureBatch(
        texts.map((text) => ({
          text,
          typography: { ...typography, fontSize },
          maxWidth: Math.max(1, maxWidth),
        })),
      );

      return {
        lineCount: results.reduce((sum, result) => sum + result.lineCount, 0),
        width: Math.max(0, ...results.map((result) => result.width)),
        height: results.reduce((sum, result) => sum + result.height, 0),
        usedFontFamily: results[0]?.usedFontFamily ?? String(typography.fontFamily ?? ""),
      };
    };

    let fontSize = typography.fontSize;
    let layout = layoutAt(fontSize);

    if (fit === "shrinkToFit" && layout.height > maxHeight) {
      // The same bounded search the estimator runs, with the same quantization,
      // so a document that shrank to 93px in Node does not shrink to 93.0001 in
      // the browser and produce a spurious diff.
      const floor = request.minFontSize ?? Math.max(12, typography.fontSize * 0.5);
      let low = floor;
      let high = typography.fontSize;

      for (let i = 0; i < 8 && high - low > 0.25; i += 1) {
        const mid = quantizeToStep((low + high) / 2);
        if (layoutAt(mid).height <= maxHeight) low = mid;
        else high = mid;
      }

      fontSize = quantizeToStep(low);
      layout = layoutAt(fontSize);
    }

    const height = fit === "autoHeight" || fit === "growBox" ? layout.height : maxHeight;

    return {
      width: Math.min(layout.width, maxWidth),
      height,
      lineCount: layout.lineCount,
      overflow: layout.height > maxHeight + 0.5,
      appliedFontSize: quantizeToStep(fontSize),
      estimated: false,
    };
  }
}

/**
 * A measurer backed by a real document, or `undefined` when there is none.
 *
 * Returning `undefined` rather than silently falling back keeps the choice at
 * the call site: a caller that expects real metrics and gets estimates should
 * know, because the two disagree by exactly the margin that decides whether a
 * headline overflows.
 */
export function createDomMeasurer(doc?: Document): TextMeasurer | undefined {
  const target = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!target?.body) return undefined;
  return new MeasuredTextMeasurer(new DomMeasurer(target));
}

/** Exported for tests and for callers supplying their own service. */
export function measurerFor(service: TextMeasurementService): TextMeasurer {
  return new MeasuredTextMeasurer(service);
}

export { fontMetrics };
