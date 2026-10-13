import type { MaskDefinition, MaskShape } from "@deckastra/presentation-schema";
import { resolveImageMask } from "@deckastra/renderer";

/**
 * The inspector's image mask choices (2026-10-13), as pure functions so the
 * component only draws them.
 *
 * Changing the outline keeps the mask's rotation and inversion: someone who
 * turned an arch and then tried a blob wants the blob turned the same way.
 * Every change is one whole `mask` value, so it is one undo step.
 */

export type MaskChoice = "none" | "rounded" | MaskShape | "custom" | "compound";

export const MASK_CHOICES: readonly { value: Exclude<MaskChoice, "custom" | "compound">; label: string }[] = [
  { value: "none", label: "No mask" },
  { value: "circle", label: "Circle" },
  { value: "ellipse", label: "Ellipse" },
  { value: "pill", label: "Pill" },
  { value: "rounded", label: "Rounded corners" },
  { value: "arch", label: "Arch" },
  { value: "blob", label: "Blob" },
  { value: "torn", label: "Torn paper" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" },
  { value: "polygon", label: "Hexagon" },
  { value: "star", label: "Star" },
];

/** Which choice a stored mask is, for the picker to mark. */
export function maskChoice(mask: MaskDefinition | undefined): MaskChoice {
  if (!mask) return "none";
  switch (mask.type) {
    case "rounded":
      return "rounded";
    case "ellipse":
      return "ellipse";
    case "shape":
      return mask.shape as MaskShape;
    case "path":
      return "custom";
    case "compound":
      return "compound";
    default:
      return "custom";
  }
}

function common(current: MaskDefinition | undefined): { invert?: boolean; rotation?: number } {
  if (!current || current.type === "shapeRef") return {};
  return {
    ...(current.invert ? { invert: true } : {}),
    ...(current.rotation ? { rotation: current.rotation } : {}),
  };
}

/** The mask after choosing an outline. `none` removes it. */
export function maskWithChoice(current: MaskDefinition | undefined, choice: MaskChoice): MaskDefinition | undefined {
  const keep = common(current);
  switch (choice) {
    case "none":
      return undefined;
    case "rounded":
      return { type: "rounded", radius: current?.type === "rounded" ? current.radius : 24, ...keep };
    case "custom":
    case "compound":
      return current;
    default:
      return { type: "shape", shape: choice, ...keep };
  }
}

/** The mask with its rotation or inversion changed; nothing to change without a mask. */
export function maskWithOptions(
  current: MaskDefinition | undefined,
  options: { invert?: boolean; rotation?: number },
): MaskDefinition | undefined {
  if (!current || current.type === "shapeRef") return current;
  const next = { ...current } as MaskDefinition & { invert?: boolean; rotation?: number };
  if (options.invert !== undefined) {
    if (options.invert) next.invert = true;
    else delete next.invert;
  }
  if (options.rotation !== undefined) {
    const degrees = ((options.rotation % 360) + 360) % 360;
    if (degrees === 0) delete next.rotation;
    else next.rotation = degrees;
  }
  return next;
}

/**
 * A typed outline: an SVG path normalized 0..1 to the picture's box. Refused
 * with the reason when it is not one, because a mask that silently draws
 * nothing reads as the editor losing the picture.
 */
export function maskWithPath(
  current: MaskDefinition | undefined,
  pathData: string,
): { mask: MaskDefinition } | { error: string } {
  const text = pathData.trim();
  if (!text) return { error: "Type a path, such as M0,0 L1,0 L0.5,1 Z." };
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\-+\s]+$/.test(text)) {
    return { error: "A path may use only the letters M L H V C S Q T A Z, numbers, spaces and commas." };
  }
  const mask: MaskDefinition = { type: "path", pathData: text, ...common(current) };
  const resolved = resolveImageMask(mask, 100, 100);
  if (resolved.warning) return { error: "That path draws no outline. Use numbers from 0 to 1 across the picture's box." };
  return { mask };
}

/**
 * What PowerPoint will receive, said before anyone exports: a preset or a
 * custom crop stays an editable crop there; an inverted, combined or fitted
 * mask arrives as a picture already cut to shape.
 */
export function maskExportNote(mask: MaskDefinition | undefined, fit: string): string | undefined {
  if (!mask) return undefined;
  const parts = mask.type === "compound" ? mask.parts.length : 1;
  const inverted = mask.type !== "shapeRef" && mask.invert === true;
  if (inverted || parts > 1 || fit === "contain" || fit === "none") {
    return "PowerPoint receives this picture already cut to shape. It looks the same there, but the crop cannot be changed in PowerPoint.";
  }
  return undefined;
}
