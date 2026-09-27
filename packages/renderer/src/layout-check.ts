import type { SceneNode, SlideScene } from "./scene";
import { CONTRAST_LARGE, CONTRAST_NORMAL, LARGE_TEXT_BOLD_PX, LARGE_TEXT_PX } from "./accessibility";
import { contrastRatio, parseColor, type SemanticIssue } from "./semantic";

/**
 * The layout half of the editor's Design Check (design review, 2026-09-27).
 *
 * A ten-slide stress deck produced icons over their labels, notes colliding with
 * big numbers, a button escaping its card and diagrams using a corner of their
 * frame, and nothing said so: the visible checks covered alt text, theme
 * contrast and reading order. These are the checks that would have caught it,
 * on the scene as drawn — applied font sizes after fit, world bounds after
 * group transforms, the fill actually painted behind a run of text.
 *
 * Deliberately separate from `validateScene`, which the Critic and export
 * reports read: these are advice for an author at a canvas, and folding them
 * into the export report would put "these two boxes touch" beside "this picture
 * could not be embedded".
 */

export interface LayoutIssue extends SemanticIssue {
  slideId: string;
  /** What a one-click fix needs, in slide coordinates. */
  detail?:
    | { kind: "overlap"; otherId: string; dx: number; dy: number }
    | { kind: "safeArea"; dx: number; dy: number; scale?: number; safe?: { x: number; y: number; width: number; height: number } }
    | { kind: "smallText"; size: number; minimum: number }
    | { kind: "contrast"; ratio: number; required: number; behind: string; foreground: string; target: "text" | "label" | "tableHeader" | "tableBody" | "chart" }
    | { kind: "contrastUnknown"; reason: "picture" }
    | { kind: "diagram"; coverage: number; labelSize: number; used: { x: number; y: number; width: number; height: number } };
}

export interface LayoutCheckOptions {
  /** Smallest readable text in slide pixels; defaults to 16px on a 1920-wide slide, scaled. */
  minTextPx?: number;
  /** Overlap smaller than this on either axis is a touch, not a collision. */
  overlapTolerance?: number;
}

const DIAGRAM_MIN_COVERAGE = 0.25;

export function minimumTextSize(slide: Pick<SlideScene, "width">, override?: number): number {
  if (override && override > 0) return override;
  return Math.round(16 * (slide.width / 1920) * 10) / 10;
}

export function checkLayout(slide: SlideScene, options: LayoutCheckOptions = {}): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const minimum = minimumTextSize(slide, options.minTextPx);
  const tolerance = options.overlapTolerance ?? 4;
  const paintIndex = new Map(slide.paintOrder.map((id, index) => [id, index]));
  const all = flatten(slide.nodes).filter((node) => !node.flags.hidden);

  // --- outside the safe area (W104), top-level objects only: a group's children
  // travel with it, and reporting both says the same thing twice.
  const safe = safeRect(slide);
  for (const node of slide.nodes) {
    if (node.flags.hidden || node.semanticRole === "decoration" || node.semanticRole === "background") continue;
    // An object bigger than the safe area cannot be moved inside it; it is
    // still outside, so it is still reported, with the scale that would fit.
    const tooBig = node.bounds.width > safe.width + 0.5 || node.bounds.height > safe.height + 0.5;
    const dx = shiftInto(node.bounds.x, node.bounds.width, safe.x, safe.width);
    const dy = shiftInto(node.bounds.y, node.bounds.height, safe.y, safe.height);
    if (dx === 0 && dy === 0 && !tooBig) continue;
    const scale = tooBig ? Math.min(safe.width / node.bounds.width, safe.height / node.bounds.height) : 1;
    issues.push({
      code: "W104",
      severity: "warning",
      slideId: slide.slideId,
      elementId: node.id,
      message: tooBig
        ? `This object is larger than the slide's ${slide.safeArea ? "safe area" : "edges"}, so part of it is always outside.`
        : slide.safeArea
          ? "This object reaches outside the slide's safe area."
          : "This object reaches past the edge of the slide.",
      suggestedFix: tooBig ? "Shrink it to fit inside." : "Move it inside.",
      detail: tooBig ? { kind: "safeArea", dx: 0, dy: 0, scale: Math.floor(scale * 1000) / 1000, safe } : { kind: "safeArea", dx, dy },
    });
  }

  // --- collisions (W110), between siblings.
  const visitSiblings = (siblings: SceneNode[], laidOut: boolean): void => {
    if (!laidOut) {
      const candidates = siblings.filter(collides);
      for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
          const a = candidates[i]!;
          const b = candidates[j]!;
          const overlapX = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x);
          const overlapY = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - Math.max(a.bounds.y, b.bounds.y);
          if (overlapX <= tolerance || overlapY <= tolerance) continue;
          // A card: a filled box that wholly holds the other object is a
          // background for it, which is the commonest deliberate overlap there is.
          if (isBacking(a) && contains(a, b)) continue;
          if (isBacking(b) && contains(b, a)) continue;
          const [under, over] = (paintIndex.get(a.id) ?? 0) <= (paintIndex.get(b.id) ?? 0) ? [a, b] : [b, a];
          // Move the upper one clear along whichever axis needs less travel.
          const right = under.bounds.x + under.bounds.width - over.bounds.x;
          const left = over.bounds.x + over.bounds.width - under.bounds.x;
          const down = under.bounds.y + under.bounds.height - over.bounds.y;
          const up = over.bounds.y + over.bounds.height - under.bounds.y;
          const moves = [
            { dx: right + tolerance, dy: 0 },
            { dx: -(left + tolerance), dy: 0 },
            { dx: 0, dy: down + tolerance },
            { dx: 0, dy: -(up + tolerance) },
          ].sort((m, n) => Math.abs(m.dx) + Math.abs(m.dy) - (Math.abs(n.dx) + Math.abs(n.dy)));
          const move = moves[0]!;
          issues.push({
            code: "W110",
            severity: "warning",
            slideId: slide.slideId,
            elementId: over.id,
            message: `${describe(over, "This")} overlaps ${describe(under, "a")} by ${Math.round(overlapX)} × ${Math.round(overlapY)}px.`,
            suggestedFix: "Move it clear, or mark the overlap as intended.",
            detail: { kind: "overlap", otherId: under.id, dx: Math.round(move.dx), dy: Math.round(move.dy) },
          });
        }
      }
    }
    for (const node of siblings) {
      if (node.children?.length) {
        const payload = node.renderPayload;
        visitSiblings(node.children, payload.kind === "group" && Boolean(payload.containerLayout));
      }
    }
  };
  visitSiblings(slide.nodes, false);

  const contrastReported = new Set<string>();
  const pictureReported = new Set<string>();
  for (const node of all) {
    const payload = node.renderPayload;

    // --- small text (W216)
    if (payload.kind === "text") {
      const size = payload.metrics.appliedFontSize;
      if (size + 0.05 < minimum && hasWords(payload.blocks)) {
        issues.push({
          code: "W216",
          severity: "warning",
          slideId: slide.slideId,
          elementId: node.id,
          message: `This text is ${round1(size)}px, below the ${round1(minimum)}px an audience can read from the back of a room.`,
          suggestedFix: `Make it at least ${round1(minimum)}px.`,
          detail: { kind: "smallText", size, minimum },
        });
      }
    }

    // --- contrast against what is actually painted behind (A102), or a
    // plain statement that it cannot be measured (W218). Every layer under
    // the text is composited: translucent fills blend, a gradient counts at
    // its weakest stop, and a picture makes the answer unknowable rather than
    // guessed.
    const judge = (
      target: "text" | "label" | "tableHeader" | "tableBody" | "chart",
      color: unknown,
      size: number,
      weight: unknown,
      backdrop: Backdrop,
    ) => {
      if (backdrop === "picture") {
        if (!pictureReported.has(node.id)) {
          pictureReported.add(node.id);
          issues.push({
            code: "W218",
            severity: "warning",
            slideId: slide.slideId,
            elementId: node.id,
            message: `${targetName(target)} sits on a picture, so its contrast cannot be measured. Check it by eye, or put a solid or translucent shape behind it.`,
            suggestedFix: "Check it by eye, or add a backing shape.",
            detail: { kind: "contrastUnknown", reason: "picture" },
          });
        }
        return;
      }
      const fg = parseColor(String(color ?? ""));
      if (!fg || backdrop.length === 0) return;
      const alpha = colorAlpha(String(color));
      let worst: { ratio: number; behind: Rgb } | undefined;
      for (const behind of backdrop) {
        const seen = alpha < 1 ? mix(fg, behind, alpha) : fg;
        const ratio = contrastRatio(seen, behind);
        if (!worst || ratio < worst.ratio) worst = { ratio, behind };
      }
      if (!worst) return;
      const bold = Number(weight ?? 400) >= 700;
      const large = size >= LARGE_TEXT_PX || (bold && size >= LARGE_TEXT_BOLD_PX);
      const required = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
      if (worst.ratio >= required) return;
      const key = `${node.id}:${target}`;
      if (contrastReported.has(key)) return;
      contrastReported.add(key);
      const gradient = backdrop.length > 1;
      issues.push({
        code: "A102",
        severity: "error",
        slideId: slide.slideId,
        elementId: node.id,
        message: `${targetName(target)} is ${worst.ratio.toFixed(2)}:1 against ${gradient ? "the weakest part of the gradient" : "the colour"} behind it; ${required}:1 is needed at ${Math.round(size)}px.`,
        suggestedFix: "Use a text colour that reads on it.",
        detail: { kind: "contrast", ratio: worst.ratio, required, behind: toHex(worst.behind), foreground: String(color), target },
      });
    };

    const centre = { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 };
    if (payload.kind === "text" && hasWords(payload.blocks)) {
      judge("text", payload.typography.color, payload.metrics.appliedFontSize, payload.typography.fontWeight, backdropAt(slide, all, paintIndex, node, centre, true));
    } else if (payload.kind === "shape" && payload.label?.length && hasWords(payload.label)) {
      judge("label", payload.labelTypography?.color, Number(payload.labelTypography?.fontSize ?? 24), payload.labelTypography?.fontWeight, backdropAt(slide, all, paintIndex, node, centre, true));
    } else if (payload.kind === "table") {
      const behindTable = backdropAt(slide, all, paintIndex, node, centre, true);
      payload.rows.forEach((row, rowIndex) => {
        const header = payload.headerRow && rowIndex === 0;
        row.cells.forEach((cell, columnIndex) => {
          if (!cell.text.trim()) return;
          const band = !header && ((payload.banding === "rows" && rowIndex % 2 === 1) || (payload.banding === "columns" && columnIndex % 2 === 1));
          const own = cell.fill ?? (header ? payload.headerFill : band ? payload.bandColor : undefined);
          const backdrop = own ? over(behindTable, own) : behindTable;
          const typography = header ? payload.headerTypography : payload.typography;
          judge(header ? "tableHeader" : "tableBody", typography.color, Number(typography.fontSize ?? 20), typography.fontWeight, backdrop);
        });
      });
    } else if (payload.kind === "chart" && !payload.notice) {
      const behindChart = backdropAt(slide, all, paintIndex, node, centre, true);
      for (const text of payload.texts) {
        // A data label sits on its bar when a bar holds its anchor.
        const bar = payload.rects.find((rect) => text.x >= rect.x && text.x <= rect.x + rect.width && text.y >= rect.y && text.y <= rect.y + rect.height);
        judge("chart", text.fill, text.fontSize, text.weight, bar ? over(behindChart, bar.fill) : behindChart);
      }
    }

    // --- diagrams that use a corner of their frame, or shrink their labels (W217)
    if (payload.kind === "diagram" && payload.nodes.length > 0) {
      const minX = Math.min(...payload.nodes.map((n) => n.x));
      const minY = Math.min(...payload.nodes.map((n) => n.y));
      const maxX = Math.max(...payload.nodes.map((n) => n.x + n.width));
      const maxY = Math.max(...payload.nodes.map((n) => n.y + n.height));
      const frame = node.localBounds.width * node.localBounds.height;
      const coverage = frame > 0 ? ((maxX - minX) * (maxY - minY)) / frame : 1;
      const labelSize = Math.min(...payload.nodes.map((n) => n.labelSize));
      if (coverage < DIAGRAM_MIN_COVERAGE || labelSize + 0.05 < minimum) {
        issues.push({
          code: "W217",
          severity: "warning",
          slideId: slide.slideId,
          elementId: node.id,
          message:
            coverage < DIAGRAM_MIN_COVERAGE
              ? `This diagram's boxes fill ${Math.round(coverage * 100)}% of its frame, so it reads small on the slide.`
              : `This diagram's labels are ${round1(labelSize)}px, below ${round1(minimum)}px.`,
          suggestedFix: coverage < DIAGRAM_MIN_COVERAGE ? "Fit the frame to the diagram." : "Give the diagram more room or fewer boxes.",
          detail: { kind: "diagram", coverage, labelSize, used: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } },
        });
      }
    }
  }

  return issues;
}

/** A colour the given candidates read on best: the first reaching 4.5:1, else the strongest. */
export function readableColor(background: string, candidates: readonly string[]): string | undefined {
  const to = parseColor(background);
  if (!to) return candidates[0];
  let best: string | undefined;
  let bestRatio = -1;
  for (const candidate of candidates) {
    const from = parseColor(candidate);
    if (!from) continue;
    const ratio = contrastRatio(from, to);
    if (ratio >= CONTRAST_NORMAL) return candidate;
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}

// ------------------------------------------------------------------ helpers

function flatten(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (list: SceneNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function collides(node: SceneNode): boolean {
  if (node.flags.hidden) return false;
  if (node.semanticRole === "decoration" || node.semanticRole === "background") return false;
  const kind = node.renderPayload.kind;
  return kind !== "line" && kind !== "placeholder";
}

/** Something that reads as a surface other things sit on. */
function isBacking(node: SceneNode): boolean {
  const kind = node.renderPayload.kind;
  if (kind === "image") return true;
  if (kind !== "shape" && kind !== "group") return false;
  return Boolean(node.resolvedStyle.fill || node.resolvedStyle.stroke);
}

function contains(outer: SceneNode, inner: SceneNode): boolean {
  const a = outer.bounds;
  const b = inner.bounds;
  return b.x >= a.x - 1 && b.y >= a.y - 1 && b.x + b.width <= a.x + a.width + 1 && b.y + b.height <= a.y + a.height + 1;
}

function safeRect(slide: SlideScene): { x: number; y: number; width: number; height: number } {
  const inset = slide.safeArea;
  const left = inset?.left ?? 0;
  const top = inset?.top ?? 0;
  return {
    x: left,
    y: top,
    width: slide.width - left - (inset?.right ?? 0),
    height: slide.height - top - (inset?.bottom ?? 0),
  };
}

/** How far to move a span so it sits inside a range; 0 when it does or cannot. */
function shiftInto(start: number, size: number, rangeStart: number, rangeSize: number): number {
  if (size > rangeSize) return 0;
  if (start < rangeStart - 0.5) return Math.round(rangeStart - start);
  const end = start + size;
  const rangeEnd = rangeStart + rangeSize;
  if (end > rangeEnd + 0.5) return Math.round(rangeEnd - end);
  return 0;
}

/**
 * What is painted under a point, as the colours text there could sit on:
 * one colour for a flat backdrop, several for a gradient (each stop), or
 * "picture" when a picture shows through and no colour can be claimed.
 *
 * Built bottom up from the slide background through every filled object
 * painted before `node` whose box holds the point, then `node`'s own fill when
 * `includeOwn`. A translucent layer blends over what is beneath it; an opaque
 * one replaces it, which is also how a solid card over a photograph makes the
 * text on it measurable again.
 */
type Backdrop = Rgb[] | "picture";

function backdropAt(
  slide: SlideScene,
  all: SceneNode[],
  paintIndex: Map<string, number>,
  node: SceneNode,
  point: { x: number; y: number },
  includeOwn: boolean,
): Backdrop {
  let result: Backdrop = slideBackdrop(slide);
  const index = paintIndex.get(node.id) ?? 0;
  const layers = all
    .filter((other) => other.id !== node.id && (paintIndex.get(other.id) ?? 0) < index && !other.flags.hidden)
    .filter((other) => point.x >= other.bounds.x && point.y >= other.bounds.y && point.x <= other.bounds.x + other.bounds.width && point.y <= other.bounds.y + other.bounds.height)
    .sort((a, b) => (paintIndex.get(a.id) ?? 0) - (paintIndex.get(b.id) ?? 0));
  if (includeOwn) layers.push(node);
  for (const layer of layers) result = paint(result, layer);
  return result;
}

function slideBackdrop(slide: SlideScene): Backdrop {
  const background = slide.background;
  let result: Backdrop = [parseColor(background?.color) ?? { r: 255, g: 255, b: 255 }];
  if (background?.gradientStops) result = gradientOver(result, background.gradientStops.stops, 1);
  if (background?.assetId) result = "picture";
  if (background?.overlay) result = over(result, background.overlay);
  return result;
}

function paint(under: Backdrop, layer: SceneNode): Backdrop {
  const kind = layer.renderPayload.kind;
  const opacity = layer.resolvedStyle.opacity ?? 1;
  if (kind === "image") return "picture";
  if (layer.resolvedStyle.gradient) return gradientOver(under, layer.resolvedStyle.gradient.stops, opacity);
  const fill = layer.resolvedStyle.fill;
  if (!fill || /url\(/i.test(fill)) return under;
  return over(under, fill, opacity);
}

/** A colour laid over a backdrop, at its own alpha times `opacity`. */
function over(under: Backdrop, color: string, opacity = 1): Backdrop {
  const rgb = parseColor(color);
  if (!rgb) return under;
  const alpha = colorAlpha(color) * opacity;
  if (alpha >= 0.98) return [rgb];
  if (under === "picture") return "picture";
  return under.map((behind) => mix(rgb, behind, alpha));
}

/** Every stop of a gradient over every colour beneath it, each at its own alpha. */
function gradientOver(under: Backdrop, stops: ReadonlyArray<{ color: string }>, opacity: number): Backdrop {
  const out: Rgb[] = [];
  for (const stop of stops) {
    const layered = over(under, stop.color, opacity);
    if (layered === "picture") return "picture";
    out.push(...layered);
  }
  return out.slice(0, 16);
}

type Rgb = { r: number; g: number; b: number };

function mix(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  };
}

function colorAlpha(value: string): number {
  const text = value.trim();
  const hex = /^#([0-9a-f]{8})$/i.exec(text);
  if (hex) return parseInt(hex[1]!.slice(6), 16) / 255;
  const short = /^#([0-9a-f]{4})$/i.exec(text);
  if (short) return parseInt(short[1]![3]! + short[1]![3]!, 16) / 255;
  const rgba = /^rgba\(([^)]+)\)$/i.exec(text);
  if (rgba) {
    const part = rgba[1]!.split(/[\s,/]+/).filter(Boolean)[3];
    if (part !== undefined) return part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part);
  }
  return 1;
}

function toHex({ r, g, b }: Rgb): string {
  const two = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}`.toUpperCase();
}

function targetName(target: "text" | "label" | "tableHeader" | "tableBody" | "chart"): string {
  return {
    text: "This text",
    label: "This shape's label",
    tableHeader: "This table's heading text",
    tableBody: "Text in this table",
    chart: "A label in this chart",
  }[target];
}


function hasWords(blocks: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }>): boolean {
  return blocks.some((block) => block.spans.some((span) => span.text.trim().length > 0));
}

function describe(node: SceneNode, article: "This" | "a"): string {
  return node.name ? `"${node.name}"` : `${article} ${node.type}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
