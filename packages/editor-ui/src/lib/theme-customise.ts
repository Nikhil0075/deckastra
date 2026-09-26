import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { newId } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

/**
 * Editing the whole design system, not only its colours (design review,
 * 2026-09-27): fonts and the type scale, spacing and the safe area, corners,
 * charts, diagrams, tables and the logo.
 *
 * Every write lands in the theme (or the viewport, for the safe area) through
 * one patch, so the elements that refer to a token follow it and Undo puts the
 * previous design back in one step. Nothing here touches an element's own
 * values: an object someone styled by hand keeps its look.
 */

/**
 * Write a value at a dotted path under the document, creating the outermost
 * missing object, replacing what is there, or removing it for `undefined`.
 * The same rule `setPropertyDeep` applies to an element.
 */
export function writePath(document: PresentationDocument, dotted: string, value: unknown): PatchOperation[] {
  const keys = dotted.split(".");
  let cursor: unknown = document;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const key = keys[depth]!;
    const container = cursor as Record<string, unknown> | undefined;
    const exists = container !== undefined && container !== null && typeof container === "object" && key in container && container[key] !== undefined;
    const path = "/" + keys.slice(0, depth + 1).map(escape).join("/");
    if (depth === keys.length - 1) {
      if (value === undefined) return exists ? [{ op: "remove", path }] : [];
      if (exists && JSON.stringify(container![key]) === JSON.stringify(value)) return [];
      return [{ op: exists ? "replace" : "add", path, value }];
    }
    if (!exists) {
      if (value === undefined) return [];
      // Build the rest of the path as one object: a single add whose inverse removes exactly it.
      const rest = keys.slice(depth + 1).reduceRight<unknown>((inner, next) => ({ [next]: inner }), value);
      return [{ op: "add", path, value: rest }];
    }
    cursor = container![key];
  }
  return [];
}

/** Several writes as one patch, each against the document the previous left. */
export function writeAll(document: PresentationDocument, writes: ReadonlyArray<[string, unknown]>): PatchOperation[] {
  let working = document;
  const operations: PatchOperation[] = [];
  for (const [path, value] of writes) {
    const next = writePath(working, path, value);
    if (!next.length) continue;
    working = applyPatch(working, next).document;
    operations.push(...next);
  }
  return operations;
}

// ------------------------------------------------------------------- type

const HEADING_TOKENS = ["display", "h1", "h2", "h3", "quote", "metric"] as const;
const BODY_TOKENS = ["body", "bodySmall", "caption"] as const;

/** Steps above and below the body size for each text style, on a modular scale. */
const SCALE_STEPS: Record<string, number> = { caption: -2, bodySmall: -1, body: 0, h3: 1, h2: 2, h1: 3, display: 5, metric: 4, quote: 1 };

export const SCALE_RATIOS = [
  { value: 1.2, label: "Minor third · 1.2" },
  { value: 1.25, label: "Major third · 1.25" },
  { value: 1.333, label: "Perfect fourth · 1.333" },
  { value: 1.5, label: "Perfect fifth · 1.5" },
] as const;

export function fontPairOperations(document: PresentationDocument, heading?: string, body?: string): PatchOperation[] {
  const writes: Array<[string, unknown]> = [];
  if (heading) for (const token of HEADING_TOKENS) writes.push([`theme.typography.${token}.fontFamily`, heading]);
  if (body) for (const token of BODY_TOKENS) writes.push([`theme.typography.${token}.fontFamily`, body]);
  return writeAll(document, writes);
}

/**
 * Every text style's size from one body size and one ratio: body × ratioⁿ,
 * rounded to whole pixels. The ratio is recorded as `scaleRatio`, which the
 * schema has always had for exactly this.
 */
export function typeScaleOperations(document: PresentationDocument, body: number, ratio: number): PatchOperation[] {
  const writes: Array<[string, unknown]> = [["theme.typography.scaleRatio", ratio]];
  for (const [token, step] of Object.entries(SCALE_STEPS)) {
    const typography = document.theme.typography as unknown as Record<string, unknown>;
    if (!typography[token]) continue;
    writes.push([`theme.typography.${token}.fontSize`, Math.round(body * ratio ** step)]);
  }
  return writeAll(document, writes);
}

export function lineHeightOperations(document: PresentationDocument, group: "headings" | "body", value: number): PatchOperation[] {
  const tokens = group === "headings" ? HEADING_TOKENS : BODY_TOKENS;
  return writeAll(document, tokens.map((token) => [`theme.typography.${token}.lineHeight`, value] as [string, unknown]));
}

export function letterSpacingOperations(document: PresentationDocument, group: "headings" | "body", value: number): PatchOperation[] {
  const tokens = group === "headings" ? HEADING_TOKENS : BODY_TOKENS;
  return writeAll(document, tokens.map((token) => [`theme.typography.${token}.letterSpacing`, value === 0 ? undefined : value] as [string, unknown]));
}

// ------------------------------------------------------------------- logo

export type LogoCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/** Marks the logo copies this places, so a later placement or removal finds exactly them. */
const LOGO_MARK = "brandLogo";

/**
 * Put a logo on every slide, in one corner, inside the safe area.
 *
 * The logo is an ordinary locked image on each slide rather than something the
 * renderer draws from the theme: every exporter already knows how to carry a
 * picture, the Design Check's size rule already recognises `semanticRole:
 * "logo"`, and a slide that should not carry it can simply have it deleted.
 * Placing again replaces the copies this placed before; nothing else is touched.
 */
export function placeLogoOperations(document: PresentationDocument, assetId: string, corner: LogoCorner, height: number): PatchOperation[] {
  const asset = document.assets.find((candidate) => candidate.id === assetId) as { width?: number; height?: number; fileName?: string } | undefined;
  if (!asset) return [];
  const ratio = asset.width && asset.height ? asset.width / asset.height : 3;
  const width = Math.round(height * ratio);
  const { width: slideWidth, height: slideHeight } = document.viewport;
  const inset = document.viewport.safeArea ?? { top: 40, right: 40, bottom: 40, left: 40 };
  const x = corner.endsWith("Left") ? inset.left : slideWidth - inset.right - width;
  const y = corner.startsWith("top") ? inset.top : slideHeight - inset.bottom - height;

  const operations = removeLogoOperations(document);
  for (const slide of document.slides) {
    const logo = {
      id: newId("el"),
      type: "image",
      name: "Logo",
      semanticRole: "logo",
      locked: true,
      assetId,
      fit: "contain",
      altText: asset.fileName ? `Logo (${asset.fileName})` : "Logo",
      transform: { x, y, width, height },
      metadata: { [LOGO_MARK]: true },
    } as unknown as PresentationElement;
    operations.push({ op: "add", path: `/slides/id:${slide.id}/elements/-`, value: logo });
  }
  const logoAssetIds = document.theme.logoAssetIds ?? [];
  if (!logoAssetIds.includes(assetId)) {
    operations.push(
      document.theme.logoAssetIds
        ? { op: "add", path: "/theme/logoAssetIds/-", value: assetId }
        : { op: "add", path: "/theme/logoAssetIds", value: [assetId] },
    );
  }
  return operations;
}

/** Take away the logo copies `placeLogoOperations` put on the slides. */
export function removeLogoOperations(document: PresentationDocument): PatchOperation[] {
  const operations: PatchOperation[] = [];
  for (const slide of document.slides) {
    for (const element of slide.elements) {
      if ((element.metadata as Record<string, unknown> | undefined)?.[LOGO_MARK] === true) {
        operations.push({ op: "remove", path: `/slides/id:${slide.id}/elements/id:${element.id}` });
      }
    }
  }
  return operations;
}

export function placedLogo(document: PresentationDocument): { assetId: string; count: number } | undefined {
  let found: { assetId: string; count: number } | undefined;
  for (const slide of document.slides) {
    for (const element of slide.elements) {
      if ((element.metadata as Record<string, unknown> | undefined)?.[LOGO_MARK] !== true) continue;
      const assetId = (element as { assetId?: string }).assetId ?? "";
      found = { assetId, count: (found?.count ?? 0) + 1 };
    }
  }
  return found;
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
