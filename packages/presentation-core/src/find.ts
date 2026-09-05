import {
  isGroup,
  walkElements,
  type PresentationDocument,
  type PresentationElement,
  type Slide,
} from "@deckastra/presentation-schema";

/**
 * Locating things in a document (doc 05 §10).
 *
 * Every lookup returns the *path* alongside the value. A caller that finds an
 * element almost always wants to change it next, and a change is expressed as a
 * patch path — so returning the value alone just means the caller searches again.
 */

export interface ElementLocation {
  element: PresentationElement;
  slide: Slide;
  slideIndex: number;
  /** Ancestor groups, outermost first. Empty for a top-level element. */
  ancestors: PresentationElement[];
  /** Index within its immediate parent's array. */
  index: number;
  /** Id-addressed patch path to the element itself. */
  path: string;
}

export function resolveSlideById(
  document: PresentationDocument,
  slideId: string,
): { slide: Slide; index: number } | undefined {
  const index = document.slides.findIndex((slide) => slide.id === slideId);
  return index === -1 ? undefined : { slide: document.slides[index]!, index };
}

/**
 * Find an element anywhere in the document, including inside nested groups.
 *
 * Returns undefined rather than throwing: "is this id still here" is a question
 * callers ask routinely — after an agent edit, when restoring a selection — and
 * an exception is the wrong shape for a routine negative answer.
 */
export function resolveElementById(
  document: PresentationDocument,
  elementId: string,
): ElementLocation | undefined {
  for (let slideIndex = 0; slideIndex < document.slides.length; slideIndex += 1) {
    const slide = document.slides[slideIndex]!;
    const found = searchElements(slide.elements, elementId, []);
    if (found) {
      return {
        ...found,
        slide,
        slideIndex,
        path: elementPath(slide.id, found.ancestors, found.element),
      };
    }
  }
  return undefined;
}

function searchElements(
  elements: readonly PresentationElement[],
  elementId: string,
  ancestors: PresentationElement[],
): { element: PresentationElement; ancestors: PresentationElement[]; index: number } | undefined {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    if (element.id === elementId) return { element, ancestors: [...ancestors], index };

    if (isGroup(element)) {
      const nested = searchElements(element.children, elementId, [...ancestors, element]);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Id-addressed path to an element, threading through any ancestor groups. */
export function elementPath(
  slideId: string,
  ancestors: readonly PresentationElement[],
  element: PresentationElement,
): string {
  const parts = [`/slides/id:${slideId}/elements`];
  for (const ancestor of ancestors) {
    parts.push(`id:${ancestor.id}`, "children");
  }
  parts.push(`id:${element.id}`);
  return parts.join("/");
}

/** Path to the array an element lives in — where a sibling would be inserted. */
export function containerPath(
  slideId: string,
  ancestors: readonly PresentationElement[],
): string {
  const parts = [`/slides/id:${slideId}/elements`];
  for (const ancestor of ancestors) {
    parts.push(`id:${ancestor.id}`, "children");
  }
  return parts.join("/");
}

export function slidePath(slideId: string): string {
  return `/slides/id:${slideId}`;
}

/** Every element on a slide, depth-first in document order. */
export function allElements(slide: Slide): PresentationElement[] {
  return [...walkElements(slide.elements)].map(({ element }) => element);
}

/** Every element in the document, with the slide it belongs to. */
export function allDocumentElements(
  document: PresentationDocument,
): { element: PresentationElement; slide: Slide; depth: number }[] {
  const out: { element: PresentationElement; slide: Slide; depth: number }[] = [];
  for (const slide of document.slides) {
    for (const { element, depth } of walkElements(slide.elements)) {
      out.push({ element, slide, depth });
    }
  }
  return out;
}

export function elementsByRole(
  document: PresentationDocument,
  role: string,
): PresentationElement[] {
  return allDocumentElements(document)
    .filter(({ element }) => element.semanticRole === role)
    .map(({ element }) => element);
}

/** Collect every id in the document, for uniqueness checks and id remapping. */
export function collectIds(document: PresentationDocument): Set<string> {
  const ids = new Set<string>([document.id, document.theme.id]);

  for (const asset of document.assets) ids.add(asset.id);
  for (const component of document.components) ids.add(component.id);
  for (const source of document.dataSources) ids.add(source.id);

  for (const slide of document.slides) {
    ids.add(slide.id);
    for (const { element } of walkElements(slide.elements)) ids.add(element.id);
    for (const track of slide.animations ?? []) {
      ids.add(track.id);
      for (const clip of track.clips) ids.add(clip.id);
    }
  }

  return ids;
}
