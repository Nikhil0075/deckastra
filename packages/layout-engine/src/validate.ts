import type { Rect } from "@deckastra/presentation-schema";

/**
 * Layout validation (doc 04 §16.4).
 *
 * The metrics the Layout Agent scores candidates with and the Critic routes
 * revisions from (doc 03 §11, §13). They are also what makes "this slide is too
 * dense" a measurement rather than an opinion.
 */

export interface ValidationElement {
  id: string;
  bounds: Rect;
  semanticRole?: string;
  /** True when the element paints a background — a card behind text. */
  hasFill?: boolean;
  overflow?: boolean;
  hidden?: boolean;
  fontSize?: number;
}

export interface LayoutValidation {
  overflowCount: number;
  overlapCount: number;
  overlappingPairs: [string, string][];
  outOfBoundsIds: string[];
  outsideSafeAreaIds: string[];
  brokenConstraintIds: string[];
  minFontSize: number;
  distinctFontSizes: number;
  warnings: string[];
}

export interface ValidateInput {
  elements: readonly ValidationElement[];
  slide: Rect;
  safeArea?: Rect;
  brokenConstraintIds?: readonly string[];
}

/**
 * Roles excluded from overlap checks (doc 02 §9.2).
 *
 * A background flourish overlapping a headline is intentional. Flagging it every
 * time trains people to ignore warnings, which costs more than the check saves.
 */
const OVERLAP_EXEMPT = new Set(["decoration"]);

export function validateLayout(input: ValidateInput): LayoutValidation {
  const { elements, slide, safeArea } = input;
  const visible = elements.filter((element) => !element.hidden);

  const overlappingPairs: [string, string][] = [];
  const outOfBoundsIds: string[] = [];
  const outsideSafeAreaIds: string[] = [];
  const warnings: string[] = [];

  for (const element of visible) {
    if (!intersects(element.bounds, slide)) {
      outOfBoundsIds.push(element.id);
      warnings.push(`"${element.id}" is entirely outside the slide.`);
    } else if (!contains(slide, element.bounds)) {
      outOfBoundsIds.push(element.id);
    }

    if (safeArea && !contains(safeArea, element.bounds) && element.semanticRole !== "decoration") {
      // Advisory, not an error: hero images and full-bleed backgrounds break the
      // safe area on purpose (doc 02 §6.3).
      outsideSafeAreaIds.push(element.id);
    }
  }

  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i]!;
      const b = visible[j]!;
      if (isIntentionalOverlap(a, b)) continue;
      if (intersects(a.bounds, b.bounds)) overlappingPairs.push([a.id, b.id]);
    }
  }

  const fontSizes = visible
    .map((element) => element.fontSize)
    .filter((size): size is number => typeof size === "number" && size > 0);

  const overflowCount = visible.filter((element) => element.overflow).length;
  for (const element of visible.filter((e) => e.overflow)) {
    warnings.push(`Text in "${element.id}" does not fit its box.`);
  }

  return {
    overflowCount,
    overlapCount: overlappingPairs.length,
    overlappingPairs,
    outOfBoundsIds,
    outsideSafeAreaIds,
    brokenConstraintIds: [...(input.brokenConstraintIds ?? [])],
    minFontSize: fontSizes.length > 0 ? Math.min(...fontSizes) : 0,
    distinctFontSizes: new Set(fontSizes).size,
    warnings,
  };
}

/**
 * Overlaps that are meant to be there.
 *
 * Two cases: either element is decoration, or one fully contains the other and
 * paints a background — text sitting on a card is the single most common layout
 * in any deck, and reporting it as a collision would make the metric useless.
 */
function isIntentionalOverlap(a: ValidationElement, b: ValidationElement): boolean {
  if (OVERLAP_EXEMPT.has(a.semanticRole ?? "") || OVERLAP_EXEMPT.has(b.semanticRole ?? "")) {
    return true;
  }
  if (a.hasFill && contains(a.bounds, b.bounds)) return true;
  if (b.hasFill && contains(b.bounds, a.bounds)) return true;
  return false;
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

export function contains(outer: Rect, inner: Rect): boolean {
  const EPSILON = 0.5;
  return (
    inner.x >= outer.x - EPSILON &&
    inner.y >= outer.y - EPSILON &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON
  );
}

/** Area of the intersection, for scoring how badly two elements collide. */
export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}
