import {
  isGroup,
  newId,
  walkElements,
  type IdPrefix,
  type PatchOperation,
  type PresentationDocument,
  type PresentationElement,
} from "@deckastra/presentation-schema";
import { addElement, resolveElementById } from "@deckastra/presentation-core";

/**
 * Clipboard (doc 05 §13).
 *
 * Copy captures elements; paste mints fresh ids for everything and rewrites
 * internal references. Reusing ids would make the paste indistinguishable from
 * the original to every animation target, constraint and connector in the
 * document — and duplicate ids are validation error E001 for that reason.
 */

export const CLIPBOARD_MIME = "application/vnd.deckastra.elements+json";

export interface ClipboardPayload {
  version: 1;
  /** Where the copy came from, so a paste into the same slide can offset. */
  sourceSlideId: string;
  elements: PresentationElement[];
}

export function copy(
  document: PresentationDocument,
  elementIds: readonly string[],
): ClipboardPayload | undefined {
  if (elementIds.length === 0) return undefined;

  const located = elementIds
    .map((id) => resolveElementById(document, id))
    .filter((found): found is NonNullable<typeof found> => found !== undefined);

  if (located.length === 0) return undefined;

  // A group already carries its children, so selecting a group *and* something
  // inside it must not paste that thing twice. This applies whether the inner
  // selection is a leaf or a nested group.
  const contained = new Set<string>();
  for (const { element } of located) {
    if (!isGroup(element)) continue;
    for (const { element: descendant } of walkElements(element.children)) {
      contained.add(descendant.id);
    }
  }

  const roots = located.filter(({ element }) => !contained.has(element.id));

  return {
    version: 1,
    sourceSlideId: roots[0]!.slide.id,
    elements: roots.map(({ element }) => structuredClone(element) as PresentationElement),
  };
}

/** Offset applied when pasting into the slide the copy came from, so the copy is
 *  visibly a copy rather than sitting exactly on top of the original. */
export const PASTE_OFFSET = 24;

export interface PasteOptions {
  targetSlideId: string;
  /** Paste inside this group instead of at slide level. */
  parentGroupId?: string;
  /** Place the paste here instead of offsetting from the original. */
  at?: { x: number; y: number };
}

export interface PasteResult {
  operations: PatchOperation[];
  /** Ids of the pasted roots, so the caller can select them. */
  elementIds: string[];
}

export function paste(
  document: PresentationDocument,
  payload: ClipboardPayload,
  options: PasteOptions,
): PasteResult {
  const samSlide = payload.sourceSlideId === options.targetSlideId;
  const operations: PatchOperation[] = [];
  const elementIds: string[] = [];

  // Anchor a multi-element paste on the top-left of the set, so relative
  // positions survive.
  const originX = Math.min(...payload.elements.map((element) => element.transform.x));
  const originY = Math.min(...payload.elements.map((element) => element.transform.y));

  for (const source of payload.elements) {
    const fresh = withFreshIds(source);

    if (options.at) {
      fresh.transform = {
        ...fresh.transform,
        x: round(options.at.x + (source.transform.x - originX)),
        y: round(options.at.y + (source.transform.y - originY)),
      };
    } else if (samSlide) {
      fresh.transform = {
        ...fresh.transform,
        x: round(fresh.transform.x + PASTE_OFFSET),
        y: round(fresh.transform.y + PASTE_OFFSET),
      };
    }

    operations.push(
      ...addElement(document, {
        slideId: options.targetSlideId,
        element: fresh,
        parentGroupId: options.parentGroupId,
      }),
    );
    elementIds.push(fresh.id);
  }

  return { operations, elementIds };
}

/**
 * Deep copy with new ids throughout, rewriting internal references.
 *
 * The rewrite is the part that is easy to miss: a connector anchored to a
 * duplicated node must anchor to the *copy*, or the pasted diagram reaches back
 * across the slide to the original.
 */
export function withFreshIds(element: PresentationElement): PresentationElement {
  const copyOf = structuredClone(element) as PresentationElement;
  const remap = new Map<string, string>();

  const mint = (oldId: string, prefix: IdPrefix): string => {
    const existing = remap.get(oldId);
    if (existing) return existing;
    const fresh = newId(prefix);
    remap.set(oldId, fresh);
    return fresh;
  };

  copyOf.id = mint(element.id, "el");
  if (isGroup(copyOf)) {
    for (const { element: child } of walkElements(copyOf.children)) {
      child.id = mint(child.id, "el");
    }
  }

  // Second pass, once every new id is known — a single pass would miss forward
  // references.
  rewrite(copyOf, remap);
  return copyOf;
}

function rewrite(element: PresentationElement, remap: ReadonlyMap<string, string>): void {
  const swap = (value: unknown): unknown =>
    typeof value === "string" && remap.has(value) ? remap.get(value) : value;

  const visit = (node: PresentationElement): void => {
    for (const constraint of node.constraints ?? []) {
      const c = constraint as { targetId?: string; containerId?: string };
      if (c.targetId) c.targetId = swap(c.targetId) as string;
      if (c.containerId) c.containerId = swap(c.containerId) as string;
    }

    for (const end of ["from", "to"] as const) {
      const endpoint = (node as Record<string, unknown>)[end];
      if (endpoint && typeof endpoint === "object" && "elementId" in endpoint) {
        const anchor = endpoint as { elementId: string };
        anchor.elementId = swap(anchor.elementId) as string;
      }
    }

    if (isGroup(node)) for (const child of node.children) visit(child);
  };

  visit(element);
}

/** Duplicate in place — the same machinery as copy-then-paste, in one step. */
export function duplicate(
  document: PresentationDocument,
  elementIds: readonly string[],
): PasteResult {
  const payload = copy(document, elementIds);
  if (!payload) return { operations: [], elementIds: [] };
  return paste(document, payload, { targetSlideId: payload.sourceSlideId });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
