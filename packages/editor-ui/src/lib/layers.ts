import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { isGroup } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

/**
 * The Layers panel's rows and toggles (2026-10-13), as pure functions.
 *
 * Rows run **front to back**, the way a person reads a stack and the way the
 * reference compositions are described: "Foreground annotation, Headline,
 * Subject cut-out, Yellow ring, Background photograph, Slide background". The
 * document's arrays run back to front (doc 02 §8.4), so each level is
 * reversed; a group's children follow the group, also front to back.
 */
export interface LayerRow {
  element: PresentationElement;
  depth: number;
}

export function layerRows(elements: readonly PresentationElement[], depth = 0): LayerRow[] {
  const rows: LayerRow[] = [];
  for (const element of [...elements].reverse()) {
    rows.push({ element, depth });
    if (isGroup(element)) rows.push(...layerRows(element.children, depth + 1));
  }
  return rows;
}

/**
 * Lock or unlock, as one patch. Locked objects still draw and export; they
 * cannot be picked on the canvas, only here (doc 02 §8.2).
 */
export function lockOperations(document: PresentationDocument, elementId: string, locked: boolean): PatchOperation[] {
  return setPropertyDeep(document, elementId, "locked", locked ? true : undefined);
}

/**
 * Hide or show, as one patch. Hidden is not transparent: a hidden object is left
 * out of layout and export, so an animation that fades something in starts from
 * opacity 0, never from hidden (doc 02 §8.2).
 */
export function visibilityOperations(document: PresentationDocument, elementId: string, visible: boolean): PatchOperation[] {
  return setPropertyDeep(document, elementId, "visible", visible ? undefined : false);
}
