import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

import { resizeOperations } from "./resize-operations";

/**
 * Formatting several objects at once (design review, 2026-09-27). With more
 * than one object selected the inspector used to offer Arrange and nothing
 * else, so restyling six cards meant six trips through the panel and six undo
 * steps, and small differences crept in. A change here is one patch for every
 * selected object that has the property, and one step in the history.
 */

export interface Shared<T> {
  /** The value every object agrees on, or undefined when they differ or none has one. */
  value: T | undefined;
  mixed: boolean;
  /** How many of the selection this control applies to. */
  count: number;
}

export function sharedValue<T>(elements: readonly PresentationElement[], read: (element: PresentationElement) => T | undefined): Shared<T> {
  const values = elements.map(read);
  const first = values[0];
  const key = (value: unknown) => JSON.stringify(value ?? null);
  const mixed = values.some((value) => key(value) !== key(first));
  return { value: mixed ? undefined : first, mixed, count: elements.length };
}

/** The selection as elements, in selection order, skipping ids that no longer resolve and locked objects. */
export function selectedElements(document: PresentationDocument, ids: readonly string[], { includeLocked = false } = {}): PresentationElement[] {
  return ids.flatMap((id) => {
    const element = resolveElementById(document, id)?.element;
    if (!element) return [];
    if (!includeLocked && element.locked === true) return [];
    return [element];
  });
}

/**
 * Write one property on every element, as one patch. Each write is computed
 * against the document as the previous ones left it, so a value may depend on
 * the element (`value` as a function) without two writes colliding.
 */
export function setForAll(
  document: PresentationDocument,
  elements: readonly PresentationElement[],
  property: string,
  value: unknown | ((element: PresentationElement) => unknown),
): PatchOperation[] {
  let working = document;
  const operations: PatchOperation[] = [];
  for (const element of elements) {
    const next = typeof value === "function" ? (value as (element: PresentationElement) => unknown)(element) : value;
    const written = setPropertyDeep(working, element.id, property, next);
    if (written.length === 0) continue;
    working = applyPatch(working, written).document;
    operations.push(...written);
  }
  return operations;
}

/** Make every element as wide (or tall) as the first one selected, through the canvas's own resize. */
export function matchSize(document: PresentationDocument, elements: readonly PresentationElement[], dimension: "width" | "height"): PatchOperation[] {
  const [reference, ...rest] = elements;
  if (!reference) return [];
  const target = reference.transform[dimension];
  let working = document;
  const operations: PatchOperation[] = [];
  for (const element of rest) {
    const current = resolveElementById(working, element.id)?.element;
    if (!current || current.transform[dimension] === target) continue;
    const written = resizeOperations(working, element.id, { ...current.transform, [dimension]: target });
    if (written.length === 0) continue;
    working = applyPatch(working, written).document;
    operations.push(...written);
  }
  return operations;
}

// What each kind of object can take. A text box is not offered a fill because
// the renderer paints none; the same rule as the single-object inspector.
export const canFill = (element: PresentationElement) => element.type === "shape" || element.type === "group";
export const canOutline = (element: PresentationElement) => element.type === "shape" || element.type === "group" || element.type === "line";
export const canRound = (element: PresentationElement) =>
  (element.type === "shape" && (element as { shape?: string }).shape === "rectangle") || element.type === "group";
export const canShadow = (element: PresentationElement) => element.type !== "line";
export const hasText = (element: PresentationElement) =>
  element.type === "text" || (element.type === "shape" && (element as { text?: unknown }).text !== undefined);
export const isText = (element: PresentationElement) => element.type === "text";
export const isIcon = (element: PresentationElement) => element.type === "icon";
