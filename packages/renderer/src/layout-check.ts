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
    | { kind: "safeArea"; dx: number; dy: number }
    | { kind: "smallText"; size: number; minimum: number }
    | { kind: "contrast"; ratio: number; required: number; behind: string; foreground: string; target: "text" | "label" }
    | { kind: "diagram"; coverage: number; labelSize: number };
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
    const dx = shiftInto(node.bounds.x, node.bounds.width, safe.x, safe.width);
    const dy = shiftInto(node.bounds.y, node.bounds.height, safe.y, safe.height);
    if (dx === 0 && dy === 0) continue;
    issues.push({
      code: "W104",
      severity: "warning",
      slideId: slide.slideId,
      elementId: node.id,
      message: slide.safeArea ? "This object reaches outside the slide's safe area." : "This object reaches past the edge of the slide.",
      suggestedFix: "Move it inside.",
      detail: { kind: "safeArea", dx, dy },
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

    // --- contrast against what is actually painted behind (A102)
    const text =
      payload.kind === "text"
        ? { color: payload.typography.color, size: payload.metrics.appliedFontSize, weight: payload.typography.fontWeight, target: "text" as const }
        : payload.kind === "shape" && payload.label?.length && hasWords(payload.label)
          ? { color: payload.labelTypography?.color, size: Number(payload.labelTypography?.fontSize ?? 24), weight: payload.labelTypography?.fontWeight, target: "label" as const }
          : undefined;
    if (text?.color) {
      const behind = text.target === "label" ? solid(node.resolvedStyle.fill) : (solid(node.resolvedStyle.fill) ?? paintedBehind(node, all, paintIndex) ?? solid(slide.background?.color));
      const from = parseColor(String(text.color));
      const to = parseColor(behind);
      if (from && to && behind) {
        const ratio = contrastRatio(from, to);
        const bold = Number(text.weight ?? 400) >= 700;
        const large = text.size >= LARGE_TEXT_PX || (bold && text.size >= LARGE_TEXT_BOLD_PX);
        const required = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
        if (ratio < required) {
          issues.push({
            code: "A102",
            severity: "error",
            slideId: slide.slideId,
            elementId: node.id,
            message: `${text.target === "label" ? "This shape's label" : "This text"} is ${ratio.toFixed(2)}:1 against the colour behind it; ${required}:1 is needed at ${Math.round(text.size)}px.`,
            suggestedFix: "Use a text colour that reads on it.",
            detail: { kind: "contrast", ratio, required, behind, foreground: String(text.color), target: text.target },
          });
        }
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
          detail: { kind: "diagram", coverage, labelSize },
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
 * The fill of the topmost filled object painted before `node` whose box holds
 * the middle of it. A gradient or a picture is not a colour and answers
 * undefined, which skips the check rather than guessing.
 */
function paintedBehind(node: SceneNode, all: SceneNode[], paintIndex: Map<string, number>): string | undefined {
  const index = paintIndex.get(node.id) ?? 0;
  const cx = node.bounds.x + node.bounds.width / 2;
  const cy = node.bounds.y + node.bounds.height / 2;
  let best: { index: number; fill: string | undefined; image: boolean } | undefined;
  for (const other of all) {
    if (other.id === node.id) continue;
    const at = paintIndex.get(other.id) ?? 0;
    if (at >= index) continue;
    const b = other.bounds;
    if (cx < b.x || cy < b.y || cx > b.x + b.width || cy > b.y + b.height) continue;
    const image = other.renderPayload.kind === "image";
    const fill = image ? undefined : other.resolvedStyle.fill;
    if (!image && !fill) continue;
    if (!best || at > best.index) best = { index: at, fill, image };
  }
  if (!best || best.image) return undefined;
  return solid(best.fill);
}

function solid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/gradient|url\(/i.test(text)) return undefined;
  // A translucent fill shows what is behind it; only an opaque one is the colour.
  const hex = /^#([0-9a-f]{8})$/i.exec(text);
  if (hex && parseInt(hex[1]!.slice(6), 16) < 250) return undefined;
  const rgba = /^rgba\(([^)]+)\)$/i.exec(text);
  if (rgba) {
    const alpha = Number(rgba[1]!.split(/[\s,/]+/).filter(Boolean)[3] ?? 1);
    if (alpha < 0.98) return undefined;
  }
  return parseColor(text) ? text : undefined;
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
