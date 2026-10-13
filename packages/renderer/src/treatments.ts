import type { ImageTreatment } from "@deckastra/presentation-schema";

import { resolveValue, type ResolvedTheme } from "./theme";
import { round } from "./scale";
import { parseColor } from "./semantic";

/**
 * A picture's treatment, resolved once in the scene build (2026-10-13).
 *
 * Every number is the document's, rounded; every colour is a resolved hex. The
 * canvas, thumbnails and the PDF draw it with CSS filters and two overlays, and
 * PowerPoint writes its own picture adjustments from the same numbers, so
 * nothing downstream re-reads the document or the theme.
 */
export interface ResolvedTreatment {
  exposure: number;
  contrast: number;
  saturation: number;
  monochrome: number;
  /** Shadow then highlight, as `#rrggbb`. */
  duotone?: [string, string];
  vignette: number;
  grain: number;
}

const hex = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");

function resolveColor(theme: ResolvedTheme, value: string): string | undefined {
  const rgb = parseColor(resolveValue<string>(theme, value));
  return rgb ? `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}` : undefined;
}

/**
 * Undefined when the treatment changes nothing, so an untouched picture carries
 * no payload and no digest line. A duotone whose colours do not resolve is
 * left out rather than drawn in a guessed colour; the validator already names
 * an unresolved token (E202).
 */
export function resolveTreatment(treatment: ImageTreatment | undefined, theme: ResolvedTheme): ResolvedTreatment | undefined {
  if (!treatment) return undefined;
  const amount = (value: number | undefined): number => round(value ?? 0);
  const shadow = treatment.duotone?.[0] ? resolveColor(theme, treatment.duotone[0]) : undefined;
  const highlight = treatment.duotone?.[1] ? resolveColor(theme, treatment.duotone[1]) : undefined;
  const resolved: ResolvedTreatment = {
    exposure: amount(treatment.exposure),
    contrast: amount(treatment.contrast),
    saturation: amount(treatment.saturation),
    monochrome: amount(treatment.monochrome),
    ...(shadow && highlight ? { duotone: [shadow, highlight] as [string, string] } : {}),
    vignette: amount(treatment.vignette),
    grain: amount(treatment.grain),
  };
  const changes =
    resolved.exposure !== 0 ||
    resolved.contrast !== 0 ||
    resolved.saturation !== 0 ||
    resolved.monochrome !== 0 ||
    resolved.duotone !== undefined ||
    resolved.vignette !== 0 ||
    resolved.grain !== 0;
  return changes ? resolved : undefined;
}

/**
 * The id of a duotone's SVG filter. Derived from its two colours, so two
 * pictures with the same duotone share one definition and a thumbnail and the
 * canvas never disagree about which colours an id means.
 */
export function duotoneFilterId(duotone: readonly [string, string]): string {
  return `dk-duotone-${duotone[0].slice(1)}-${duotone[1].slice(1)}`;
}

/** The CSS `filter` for a treatment, duotone included as a reference to its SVG filter. */
export function treatmentFilterCss(treatment: ResolvedTreatment): string | undefined {
  const parts: string[] = [];
  if (treatment.exposure !== 0) parts.push(`brightness(${round(1 + treatment.exposure)})`);
  if (treatment.contrast !== 0) parts.push(`contrast(${round(1 + treatment.contrast)})`);
  if (treatment.saturation !== 0) parts.push(`saturate(${round(1 + treatment.saturation)})`);
  if (treatment.monochrome !== 0) parts.push(`grayscale(${treatment.monochrome})`);
  if (treatment.duotone) parts.push(`url(#${duotoneFilterId(treatment.duotone)})`);
  return parts.length ? parts.join(" ") : undefined;
}

const channel = (value: string, at: number): number => round(parseInt(value.slice(at, at + 2), 16) / 255);

/**
 * The duotone as SVG filter primitives: the picture's lightness (Rec. 709
 * weights), then each channel mapped from the shadow colour at black to the
 * highlight colour at white. sRGB interpolation, so the two ends are exactly
 * the colours a person chose.
 */
export function duotoneFilterMarkup(duotone: readonly [string, string]): {
  matrix: string;
  tables: { r: string; g: string; b: string };
} {
  const [shadow, highlight] = duotone;
  const row = "0.2126 0.7152 0.0722 0 0";
  return {
    matrix: `${row} ${row} ${row} 0 0 0 1 0`,
    tables: {
      r: `${channel(shadow, 1)} ${channel(highlight, 1)}`,
      g: `${channel(shadow, 3)} ${channel(highlight, 3)}`,
      b: `${channel(shadow, 5)} ${channel(highlight, 5)}`,
    },
  };
}

/** Corners darkened towards black; the centre is untouched. */
export function vignetteCss(amount: number): string {
  const clear = round(70 - amount * 35);
  return `radial-gradient(ellipse at center, rgba(0,0,0,0) ${clear}%, rgba(0,0,0,${round(0.85 * amount)}) 100%)`;
}

/**
 * Film grain as a tile of seeded fractal noise. The seed is fixed, so the same
 * picture grains the same way in every render and every export.
 *
 * The noise becomes black specks where it falls below its middle and white
 * specks where it rises above, each as opaque as it is far from the middle,
 * and the tile is laid over the picture normally. Grain is then as visible in
 * a night sky as in a white wall: an `overlay` blend of grey noise scales with
 * the picture's own brightness and all but vanished on a dark photograph.
 */
export const GRAIN_TILE =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">' +
      '<filter id="g" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/>' +
      '<feColorMatrix type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0"/>' +
      '<feComponentTransfer>' +
      '<feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/>' +
      '<feFuncA type="table" tableValues="1 0 1"/>' +
      "</feComponentTransfer></filter>" +
      '<rect width="160" height="160" filter="url(#g)"/></svg>',
  );

/** How strongly the grain tile shows over the picture. */
export function grainOpacity(amount: number): number {
  return round(0.6 * amount);
}
