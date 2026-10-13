import type { ImageElement, ImageTreatment, PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { parseColor } from "@deckastra/renderer";

import { resolveColorValue } from "./colors";

/**
 * A picture's treatment, as the inspector edits it (2026-10-13).
 *
 * The whole `treatment` object is written in one change, so a preset or a slider
 * is one undo step, and a treatment that no longer changes anything is removed
 * rather than left behind as a row of zeros. The photograph itself is never
 * touched: clearing the treatment is the original.
 */

export type TreatmentPreset = "none" | "mono" | "faded" | "dramatic" | "film" | "duotone";

export interface TreatmentPresetEntry {
  value: TreatmentPreset;
  label: string;
  treatment?: ImageTreatment;
}

const lightness = (document: PresentationDocument, token: string): number => {
  const rgb = parseColor(resolveColorValue(document, token));
  return rgb ? 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b : 0;
};

/**
 * The looks the inspector offers, for this deck. The duotone is in theme
 * colours, so it follows the deck when its theme changes, and its shadows take
 * whichever of the text and background colours is darker: on a dark theme the
 * text colour is near white, and putting it in the shadows inverts the picture.
 */
export function treatmentPresets(document: PresentationDocument): TreatmentPresetEntry[] {
  const darker =
    lightness(document, "token:colors.foreground") <= lightness(document, "token:colors.background")
      ? "token:colors.foreground"
      : "token:colors.background";
  return [
    { value: "none", label: "Original" },
    { value: "mono", label: "Black and white", treatment: { monochrome: 1, contrast: 0.1 } },
    { value: "faded", label: "Faded", treatment: { exposure: 0.05, contrast: -0.2, saturation: -0.35 } },
    { value: "dramatic", label: "Dramatic", treatment: { exposure: -0.1, contrast: 0.35, saturation: -0.15, vignette: 0.5 } },
    { value: "film", label: "Film", treatment: { contrast: 0.1, saturation: -0.1, vignette: 0.25, grain: 0.35 } },
    { value: "duotone", label: "Duotone", treatment: { duotone: [darker, "token:colors.accent"] } },
  ];
}

const NUMERIC = ["exposure", "contrast", "saturation", "monochrome", "vignette", "grain"] as const;
export type TreatmentAmount = (typeof NUMERIC)[number];

/** The treatment with `change` applied, without zeros; undefined when nothing is left. */
export function treatmentWith(current: ImageTreatment | undefined, change: Partial<ImageTreatment>): ImageTreatment | undefined {
  const merged: Record<string, unknown> = { ...(current ?? {}), ...change };
  const out: Record<string, unknown> = {};
  for (const key of NUMERIC) {
    const value = merged[key];
    if (typeof value === "number" && value !== 0) out[key] = Math.round(value * 1000) / 1000;
  }
  if (Array.isArray(merged.duotone) && merged.duotone.length === 2) out.duotone = merged.duotone;
  return Object.keys(out).length ? (out as ImageTreatment) : undefined;
}

export function treatmentOperations(document: PresentationDocument, elementId: string, treatment: ImageTreatment | undefined): PatchOperation[] {
  return setPropertyDeep(document, elementId, "treatment", treatment);
}

/** Which preset the picture's treatment is, if it is exactly one; "custom" otherwise. */
export function treatmentPreset(document: PresentationDocument, element: ImageElement): TreatmentPreset | "custom" {
  const current = treatmentWith(element.treatment, {});
  if (!current) return "none";
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const found = treatmentPresets(document).find((preset) => preset.treatment && same(treatmentWith(preset.treatment, {}), current));
  return found?.value ?? "custom";
}

/** A slider value in the inspector's units (-100 to 100, or 0 to 100). */
export function treatmentPercent(element: ImageElement, key: TreatmentAmount): number {
  return Math.round((element.treatment?.[key] ?? 0) * 100);
}

/**
 * What PowerPoint will do with this treatment, said before export rather than
 * after. Monochrome and duotone are PowerPoint's own; brightness, contrast and
 * saturation are its corrections and close; a vignette or grain makes the
 * picture a fixed copy.
 */
export function treatmentExportNote(treatment: ImageTreatment | undefined): string | undefined {
  if (!treatment) return undefined;
  if ((treatment.vignette ?? 0) > 0 || (treatment.grain ?? 0) > 0) {
    return "PowerPoint has no vignette or grain, so it gets this picture with the treatment applied, not adjustable there.";
  }
  if (treatment.exposure || treatment.contrast || treatment.saturation) {
    return "In PowerPoint these become its own picture corrections: still adjustable, and close to how the slide looks.";
  }
  return undefined;
}
