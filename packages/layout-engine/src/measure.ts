import type { RichTextDocument, TextFit, TypographyStyle } from "@deckastra/presentation-schema";

/**
 * Text measurement (doc 04 §17.4, §17.5).
 *
 * The interface is the important part. The browser editor, the headless preview
 * service and the export adapters all measure through it, running the *same*
 * implementation inside the same engine — which is the reason a preview matches
 * the editor rather than approximating it.
 *
 * Never `CanvasRenderingContext2D.measureText` for multi-line text: it does not
 * wrap, and its bounding box differs from CSS line-box height.
 */

export interface LineMetrics {
  text: string;
  width: number;
  baseline: number;
}

export interface TextMetrics {
  width: number;
  height: number;
  lineCount: number;
  lines: LineMetrics[];
  firstBaseline: number;
  lastBaseline: number;
  overflow: boolean;
  /** The family that actually resolved. Compare against the requested one to
   *  detect a fallback, which invalidates cached metrics (doc 04 §18.3). */
  usedFontFamily: string;
  /** True when produced by the estimator rather than a real measurement, so
   *  exports know to re-measure instead of trusting a guess. */
  estimated: boolean;
}

export interface MeasureInput {
  text: string;
  typography: TypographyStyle;
  maxWidth: number;
  locale?: string;
  textTransform?: string;
}

export interface TextMeasurementService {
  measure(input: MeasureInput): TextMetrics;
  measureBatch(inputs: readonly MeasureInput[]): TextMetrics[];
  /** Bumped when fonts load, so metrics taken against a fallback are discarded. */
  readonly fontRevision: number;
}

/** Quantization step for fit results (doc 04 §17.3). */
export const FONT_SIZE_STEP = 0.25;

export function quantizeFontSize(size: number): number {
  // Floor, not round: rounding up can push the result back over the box it was
  // just measured to fit inside.
  return Math.floor(size * (1 / FONT_SIZE_STEP)) / (1 / FONT_SIZE_STEP);
}

/**
 * Cache key (doc 04 §17.5).
 *
 * Every input that changes the metrics belongs here. Leaving one out produces the
 * worst kind of bug: correct on a cold cache, wrong on a warm one.
 */
export function measurementKey(input: MeasureInput, fontRevision: number): string {
  const t = input.typography;
  return [
    input.text,
    t.fontFamily,
    t.fontWeight ?? 400,
    t.fontStyle ?? "normal",
    t.fontSize,
    t.letterSpacing ?? 0,
    t.lineHeight ?? 1.3,
    Math.round(input.maxWidth * 100),
    input.textTransform ?? t.textTransform ?? "none",
    input.locale ?? "en",
    fontRevision,
  ].join("");
}

/** LRU. Insertion order in a Map is the recency order once re-inserted on read. */
export class MeasurementCache {
  private readonly entries = new Map<string, TextMetrics>();

  constructor(private readonly limit = 2000) {}

  get(key: string): TextMetrics | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: TextMetrics): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Average glyph advance as a fraction of font size (doc 04 §6.4).
 *
 * Wrong for any specific string and close enough in aggregate to keep a layout
 * from collapsing while real metrics are unavailable.
 */
const AVERAGE_ADVANCE = 0.52;

/**
 * The estimator.
 *
 * Deterministic given the same input, which matters more than being right: a
 * non-deterministic estimate makes the scene non-reproducible and breaks
 * byte-identical render tests. Everything it produces is flagged `estimated`.
 */
export class EstimatingMeasurer implements TextMeasurementService {
  readonly fontRevision = 0;

  measure(input: MeasureInput): TextMetrics {
    const { typography, maxWidth } = input;
    const lineHeight = typography.lineHeight ?? 1.3;
    const advance = typography.fontSize * AVERAGE_ADVANCE + (typography.letterSpacing ?? 0);
    const charsPerLine = Math.max(1, Math.floor(maxWidth / Math.max(advance, 0.01)));

    const paragraphs = input.text.split("\n");
    const lines: LineMetrics[] = [];
    let widest = 0;

    for (const paragraph of paragraphs) {
      const rows = Math.max(1, Math.ceil(paragraph.length / charsPerLine));
      for (let i = 0; i < rows; i += 1) {
        const slice = paragraph.slice(i * charsPerLine, (i + 1) * charsPerLine);
        const width = slice.length * advance;
        widest = Math.max(widest, width);
        lines.push({
          text: slice,
          width,
          baseline: (lines.length + 0.8) * typography.fontSize * lineHeight,
        });
      }
    }

    const height = lines.length * typography.fontSize * lineHeight;

    return {
      width: Math.min(widest, maxWidth),
      height,
      lineCount: lines.length,
      lines,
      firstBaseline: lines[0]?.baseline ?? 0,
      lastBaseline: lines.at(-1)?.baseline ?? 0,
      overflow: false,
      usedFontFamily: typography.fontFamily,
      estimated: true,
    };
  }

  measureBatch(inputs: readonly MeasureInput[]): TextMetrics[] {
    return inputs.map((input) => this.measure(input));
  }
}

/**
 * Browser measurement: a hidden element with identical CSS, read with
 * `Range.getClientRects()` for real line boxes.
 *
 * Reads and writes are separated deliberately (`measureBatch` writes every
 * pending input, then reads every result). Interleaving them forces a layout
 * flush per item, which is the difference between a 60-object slide measuring in
 * one frame and in twenty.
 */
export class DomMeasurer implements TextMeasurementService {
  private readonly cache = new MeasurementCache();
  private host: HTMLElement | null = null;
  private revision = 0;

  constructor(private readonly document: Document) {
    // Metrics taken against a fallback font are wrong once the real font
    // arrives, so a font load invalidates everything.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.addEventListener?.("loadingdone", () => {
      this.revision += 1;
      this.cache.clear();
    });
  }

  get fontRevision(): number {
    return this.revision;
  }

  private container(): HTMLElement {
    if (this.host && this.host.isConnected) return this.host;

    const host = this.document.createElement("div");
    host.setAttribute("data-deckastra-measure", "");
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "absolute",
      // Off-screen rather than display:none — a hidden element has no line boxes
      // to read, and visibility:hidden still reserves layout.
      top: "-100000px",
      left: "-100000px",
      visibility: "hidden",
      pointerEvents: "none",
      contain: "layout style",
    } satisfies Partial<CSSStyleDeclaration>);

    this.document.body.appendChild(host);
    this.host = host;
    return host;
  }

  private applyStyle(element: HTMLElement, input: MeasureInput): void {
    const t = input.typography;
    Object.assign(element.style, {
      position: "absolute",
      whiteSpace: "pre-wrap",
      wordBreak: "normal",
      overflowWrap: "break-word",
      width: `${input.maxWidth}px`,
      fontFamily: t.fontFamily,
      fontSize: `${t.fontSize}px`,
      fontWeight: String(t.fontWeight ?? 400),
      fontStyle: t.fontStyle ?? "normal",
      lineHeight: String(t.lineHeight ?? 1.3),
      letterSpacing: t.letterSpacing ? `${t.letterSpacing}px` : "normal",
      textTransform: (input.textTransform ?? t.textTransform ?? "none") as string,
      margin: "0",
      padding: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    element.textContent = input.text;
  }

  measure(input: MeasureInput): TextMetrics {
    return this.measureBatch([input])[0]!;
  }

  measureBatch(inputs: readonly MeasureInput[]): TextMetrics[] {
    const results: (TextMetrics | undefined)[] = new Array(inputs.length);
    const pending: { index: number; input: MeasureInput; key: string }[] = [];

    for (let i = 0; i < inputs.length; i += 1) {
      const key = measurementKey(inputs[i]!, this.revision);
      const hit = this.cache.get(key);
      if (hit) results[i] = hit;
      else pending.push({ index: i, input: inputs[i]!, key });
    }

    if (pending.length > 0) {
      const host = this.container();
      const nodes: HTMLElement[] = [];

      // Write phase: every element created and styled before anything is read.
      for (const { input } of pending) {
        const node = this.document.createElement("div");
        this.applyStyle(node, input);
        host.appendChild(node);
        nodes.push(node);
      }

      // Read phase: one layout flush for the whole batch.
      for (let i = 0; i < pending.length; i += 1) {
        const { index, input, key } = pending[i]!;
        const metrics = this.read(nodes[i]!, input);
        this.cache.set(key, metrics);
        results[index] = metrics;
      }

      for (const node of nodes) node.remove();
    }

    return results as TextMetrics[];
  }

  private read(node: HTMLElement, input: MeasureInput): TextMetrics {
    const range = this.document.createRange();
    range.selectNodeContents(node);

    const rects = Array.from(range.getClientRects());
    const nodeRect = node.getBoundingClientRect();

    const lines: LineMetrics[] = rects.map((rect) => ({
      text: "",
      width: rect.width,
      baseline: rect.bottom - nodeRect.top,
    }));

    const computed = this.document.defaultView?.getComputedStyle(node);

    return {
      width: Math.min(Math.max(0, ...lines.map((line) => line.width)), input.maxWidth),
      height: nodeRect.height,
      lineCount: Math.max(1, lines.length),
      lines,
      firstBaseline: lines[0]?.baseline ?? 0,
      lastBaseline: lines.at(-1)?.baseline ?? 0,
      overflow: false,
      usedFontFamily: computed?.fontFamily ?? input.typography.fontFamily,
      estimated: false,
    };
  }

  dispose(): void {
    this.host?.remove();
    this.host = null;
    this.cache.clear();
  }
}

export interface FitInput {
  content: RichTextDocument | string;
  typography: TypographyStyle;
  box: { width: number; height: number };
  fit: TextFit;
  minFontSize?: number;
  maxWidth?: number;
}

export interface FitResult {
  fontSize: number;
  metrics: TextMetrics;
  /** Height the box should take, for autoHeight and growBox. */
  height: number;
  width: number;
  overflow: boolean;
}

function plainText(content: RichTextDocument | string): string {
  if (typeof content === "string") return content;
  return content.blocks.map((block) => block.spans.map((span) => span.text).join("")).join("\n");
}

/**
 * Resolve a fit mode to a concrete font size and box (doc 04 §17.3).
 *
 * Shrink-to-fit is a binary search with a fixed iteration count rather than a
 * loop until it fits: bounded iteration is what makes the result deterministic,
 * and the 0.25px quantization is what stops two runs on slightly different float
 * paths producing 47.9994 and 48.0001 and flapping the visual regression suite.
 */
export function resolveFit(input: FitInput, measurer: TextMeasurementService): FitResult {
  const text = plainText(input.content);
  const { typography, box } = input;

  const measureAt = (fontSize: number, maxWidth: number): TextMetrics =>
    measurer.measure({
      text,
      typography: { ...typography, fontSize },
      maxWidth,
    });

  switch (input.fit) {
    case "autoHeight": {
      const metrics = measureAt(typography.fontSize, box.width);
      return {
        fontSize: typography.fontSize,
        metrics,
        width: box.width,
        height: metrics.height,
        overflow: false,
      };
    }

    case "growBox": {
      const maxWidth = input.maxWidth ?? box.width;
      const metrics = measureAt(typography.fontSize, maxWidth);
      return {
        fontSize: typography.fontSize,
        metrics,
        width: Math.min(metrics.width, maxWidth),
        height: metrics.height,
        overflow: false,
      };
    }

    case "shrinkToFit": {
      const max = typography.fontSize;
      const min = input.minFontSize ?? Math.max(12, max * 0.5);

      let atMax = measureAt(max, box.width);
      if (atMax.height <= box.height) {
        return { fontSize: max, metrics: atMax, width: box.width, height: box.height, overflow: false };
      }

      let lo = min;
      let hi = max;
      let best = min;
      let bestMetrics = measureAt(min, box.width);

      for (let i = 0; i < 8; i += 1) {
        const mid = (lo + hi) / 2;
        const metrics = measureAt(mid, box.width);
        if (metrics.height <= box.height) {
          best = mid;
          bestMetrics = metrics;
          lo = mid;
        } else {
          hi = mid;
        }
      }

      const fontSize = quantizeFontSize(best);
      const metrics = measureAt(fontSize, box.width);

      return {
        fontSize,
        metrics,
        width: box.width,
        height: box.height,
        // Flagged only when the floor was reached and it still does not fit.
        overflow: metrics.height > box.height + 0.5,
      };
    }

    case "fixed":
    default: {
      const metrics = measureAt(typography.fontSize, box.width);
      return {
        fontSize: typography.fontSize,
        metrics,
        width: box.width,
        height: box.height,
        // Never silently clipped: a deck that looks fine in the editor and
        // truncates in a PDF is the failure this rule exists to prevent.
        overflow: metrics.height > box.height + 0.5,
      };
    }
  }
}
