/**
 * Editing how the deck moves into a slide (editor Phase 7, Figma frame
 * "agent-planned motion": transition type, duration, easing, shared elements).
 *
 * Pure, and every function returns operations rather than a document: a
 * transition edit is a patch through `editor.apply`, with ordinary undo, like a
 * text edit. The transition belongs to the slide it leads *into* (doc 02 §26),
 * so moving a slide carries its entrance with it.
 *
 * Two rules decide the shape:
 *
 * - **Cut is the absence of a transition.** Choosing it removes the property,
 *   so a deck with no motion between slides carries nothing to explain.
 * - **Pairs are only ever explicit in the document.** The engine can suggest
 *   pairs (auto-pairing, scored), but a suggestion reaches the document only
 *   when an author keeps it: two unrelated objects are never silently morphed.
 */

import {
  walkElements,
  type PatchOperation,
  type PresentationDocument,
  type PresentationElement,
  type SharedElementMapping,
  type Slide,
  type SlideTransition,
} from "@deckastra/presentation-schema";
import { setSlideProperty } from "@deckastra/presentation-core";
import { resolvePairing, transitionSlideFromScene } from "@deckastra/animation-engine";
import type { SlideScene } from "@deckastra/renderer";

import { labelFor } from "../components/inspector/labels";

/** The kinds the Figma offers, in its order. `push`, `mask`, … still round-trip. */
export const EDITABLE_KINDS = ["cut", "fade", "slide", "zoom", "morph"] as const;
export type EditableKind = (typeof EDITABLE_KINDS)[number];

/** Where a new transition of each kind starts. A morph travels, so it gets longer. */
export const KIND_DEFAULT_MS: Record<Exclude<EditableKind, "cut">, number> = {
  fade: 300,
  slide: 450,
  zoom: 450,
  morph: 600,
};

/** Past a few seconds a transition is a pause the room sits through. */
export const TRANSITION_MS = { min: 50, max: 3000 } as const;

export const DIRECTIONS = ["left", "right", "up", "down"] as const;

export interface TransitionState {
  /** Null when the slide carries a kind this editor does not offer. */
  kind: EditableKind | null;
  /** That kind's name ("push", or one from a newer build), shown as-is. */
  foreign: string | null;
  transition: SlideTransition | undefined;
}

export interface TransitionChange {
  operations: PatchOperation[];
  /** Something the change did that the person should be told. */
  notice?: string;
}

const NONE: TransitionChange = { operations: [] };

function slideOf(document: PresentationDocument, slideId: string): { slide: Slide; index: number } {
  const index = document.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new Error(`No slide ${slideId}.`);
  return { slide: document.slides[index]!, index };
}

export function transitionState(slide: Slide): TransitionState {
  const transition = slide.transition;
  if (!transition || transition.type === "cut") return { kind: "cut", foreign: null, transition };
  if ((EDITABLE_KINDS as readonly string[]).includes(transition.type)) {
    return { kind: transition.type as EditableKind, foreign: null, transition };
  }
  return { kind: null, foreign: transition.type, transition };
}

function write(document: PresentationDocument, slideId: string, next: SlideTransition | undefined): PatchOperation[] {
  const { slide } = slideOf(document, slideId);
  if (next === undefined) {
    return slide.transition === undefined ? [] : [{ op: "remove", path: `/slides/id:${slideId}/transition` }];
  }
  if (JSON.stringify(next) === JSON.stringify(slide.transition)) return [];
  return setSlideProperty(document, slideId, "transition", next);
}

function pairsLost(transition: SlideTransition | undefined): string | undefined {
  const count = transition?.sharedElements?.length ?? 0;
  if (!count) return undefined;
  return `${count} shared-element ${count === 1 ? "pair was" : "pairs were"} removed with the morph. Undo brings ${count === 1 ? "it" : "them"} back.`;
}

/**
 * Change the kind. Duration and easing carry over; a morph's pairs do not,
 * because only a morph draws them and a fade with hidden pairs is a document
 * that says more than the slide does.
 */
export function setTransitionKind(document: PresentationDocument, slideId: string, kind: EditableKind): TransitionChange {
  const { slide } = slideOf(document, slideId);
  const current = slide.transition;
  if (kind === "cut") {
    return { operations: write(document, slideId, undefined), notice: pairsLost(current) };
  }
  const base: SlideTransition = current && current.type !== "cut" ? { ...current } : ({} as SlideTransition);
  const next: SlideTransition = {
    ...base,
    type: kind,
    durationMs: base.durationMs && base.durationMs > 0 ? base.durationMs : KIND_DEFAULT_MS[kind],
  };
  if (kind === "slide") next.direction = base.direction ?? "left";
  else delete next.direction;
  let notice: string | undefined;
  if (kind !== "morph" && next.sharedElements?.length) {
    notice = pairsLost(next);
    delete next.sharedElements;
  }
  return { operations: write(document, slideId, next), notice };
}

function editExisting(
  document: PresentationDocument,
  slideId: string,
  change: (transition: SlideTransition) => SlideTransition,
): TransitionChange {
  const { slide } = slideOf(document, slideId);
  // A cut has no duration or easing to edit; the controls are not offered.
  if (!slide.transition || slide.transition.type === "cut") return NONE;
  return { operations: write(document, slideId, change({ ...slide.transition })) };
}

export function setTransitionDuration(document: PresentationDocument, slideId: string, ms: number): TransitionChange {
  const clamped = Math.round(Math.min(TRANSITION_MS.max, Math.max(TRANSITION_MS.min, ms)));
  return editExisting(document, slideId, (transition) => ({ ...transition, durationMs: clamped }));
}

export function setTransitionEasing(document: PresentationDocument, slideId: string, easing: string): TransitionChange {
  return editExisting(document, slideId, (transition) => ({ ...transition, easing }));
}

export function setTransitionDirection(
  document: PresentationDocument,
  slideId: string,
  direction: (typeof DIRECTIONS)[number],
): TransitionChange {
  return editExisting(document, slideId, (transition) => ({ ...transition, direction }));
}

// ---------------------------------------------------------------- pairs

export interface PairRow {
  sourceId: string;
  destinationId: string;
  sourceLabel: string;
  destinationLabel: string;
  /** `manual`: in the document. `auto`: the engine's suggestion, not written. */
  origin: "manual" | "auto";
  /** Position in `sharedElements`, for a manual pair. */
  index?: number;
  /** An auto pair's score and reason, which the author may disagree with. */
  confidence?: number;
  reason?: string;
  /** A manual pair naming an element that is no longer there. */
  missing?: boolean;
}

export interface ElementChoice {
  id: string;
  label: string;
}

/**
 * What a person calls an object. Its name or its words first; failing those, its
 * role ("decoration (shape)"), because "shape 1JB8Z9 → shape 1JB8Z9" tells nobody
 * which pair is which.
 */
export function objectLabel(element: PresentationElement): string {
  const role = (element as { semanticRole?: string }).semanticRole;
  if (!element.name && element.type !== "text" && role) return `${role} (${element.type})`;
  return labelFor(element);
}

function elementsOf(slide: Slide | undefined): Map<string, PresentationElement> {
  const found = new Map<string, PresentationElement>();
  if (!slide) return found;
  for (const { element } of walkElements(slide.elements)) found.set(element.id, element);
  return found;
}

/**
 * The pairs a morph into this slide would draw: the document's own, then the
 * engine's suggestions for what is left. Suggestions need both slides' scenes,
 * because the engine scores what is on screen, not what the document says.
 */
export function pairRows(
  document: PresentationDocument,
  slideId: string,
  scenes?: { from?: SlideScene; to?: SlideScene },
): PairRow[] {
  const { slide, index } = slideOf(document, slideId);
  const previous = index > 0 ? document.slides[index - 1] : undefined;
  const sources = elementsOf(previous);
  const destinations = elementsOf(slide);
  const label = (map: Map<string, PresentationElement>, id: string) => {
    const element = map.get(id);
    return element ? objectLabel(element) : "Removed object";
  };

  const explicit = slide.transition?.sharedElements ?? [];
  const rows: PairRow[] = explicit.map((mapping, position) => ({
    sourceId: mapping.sourceElementId,
    destinationId: mapping.destinationElementId,
    sourceLabel: label(sources, mapping.sourceElementId),
    destinationLabel: label(destinations, mapping.destinationElementId),
    origin: "manual",
    index: position,
    missing: !sources.has(mapping.sourceElementId) || !destinations.has(mapping.destinationElementId),
  }));

  if (scenes?.from && scenes.to) {
    const pairing = resolvePairing({
      from: transitionSlideFromScene(scenes.from),
      to: transitionSlideFromScene(scenes.to),
      explicit,
      auto: true,
    });
    for (const pair of pairing.pairs) {
      if (pair.origin !== "auto") continue;
      rows.push({
        sourceId: pair.sourceId,
        destinationId: pair.destinationId,
        sourceLabel: label(sources, pair.sourceId),
        destinationLabel: label(destinations, pair.destinationId),
        origin: "auto",
        confidence: pair.confidence,
        reason: pair.reason,
      });
    }
  }
  return rows;
}

/** What each side of "+ Add pair" can offer: anything not already paired. */
export function pairCandidates(
  document: PresentationDocument,
  slideId: string,
): { sources: ElementChoice[]; destinations: ElementChoice[] } {
  const { slide, index } = slideOf(document, slideId);
  const previous = index > 0 ? document.slides[index - 1] : undefined;
  const explicit = slide.transition?.sharedElements ?? [];
  const usedSource = new Set(explicit.map((mapping) => mapping.sourceElementId));
  const usedDestination = new Set(explicit.map((mapping) => mapping.destinationElementId));
  const choices = (map: Map<string, PresentationElement>, used: Set<string>) =>
    [...map.values()].filter((element) => !used.has(element.id)).map((element) => ({ id: element.id, label: objectLabel(element) }));
  return {
    sources: choices(elementsOf(previous), usedSource),
    destinations: choices(elementsOf(slide), usedDestination),
  };
}

function writePairs(document: PresentationDocument, slideId: string, pairs: SharedElementMapping[]): PatchOperation[] {
  const { slide } = slideOf(document, slideId);
  if (!slide.transition) return [];
  const next = { ...slide.transition, sharedElements: pairs };
  if (!pairs.length) delete (next as { sharedElements?: unknown }).sharedElements;
  return write(document, slideId, next);
}

/**
 * Pair two objects, or keep an auto suggestion. An object is in at most one
 * pair on each side: an element cannot travel to two places at once.
 */
export function addPair(
  document: PresentationDocument,
  slideId: string,
  sourceId: string,
  destinationId: string,
): TransitionChange {
  const { slide } = slideOf(document, slideId);
  if (slide.transition?.type !== "morph") {
    return { operations: [], notice: "Only a morph carries objects across. Choose Morph first." };
  }
  const explicit = slide.transition.sharedElements ?? [];
  if (explicit.some((mapping) => mapping.sourceElementId === sourceId || mapping.destinationElementId === destinationId)) {
    return { operations: [], notice: "One of those objects is already paired. Break that pair first." };
  }
  return { operations: writePairs(document, slideId, [...explicit, { sourceElementId: sourceId, destinationElementId: destinationId }]) };
}

/** Break a manual pair. Mappings have no id, so the whole array is replaced. */
export function removePair(document: PresentationDocument, slideId: string, index: number): TransitionChange {
  const { slide } = slideOf(document, slideId);
  const explicit = slide.transition?.sharedElements ?? [];
  if (index < 0 || index >= explicit.length) return NONE;
  return { operations: writePairs(document, slideId, explicit.filter((_, position) => position !== index)) };
}

/**
 * Drop every pair that names an object no longer on its slide (MA-27): a slide
 * was deleted or reordered, or one half was removed. One patch, so one Undo
 * brings them back. Pairs that still resolve are left exactly as they were.
 */
export function removeBrokenPairs(document: PresentationDocument, slideId: string): TransitionChange {
  const { slide, index } = slideOf(document, slideId);
  const explicit = slide.transition?.sharedElements ?? [];
  const sources = elementsOf(index > 0 ? document.slides[index - 1] : undefined);
  const destinations = elementsOf(slide);
  const kept = explicit.filter(
    (mapping) => sources.has(mapping.sourceElementId) && destinations.has(mapping.destinationElementId),
  );
  if (kept.length === explicit.length) return NONE;
  const dropped = explicit.length - kept.length;
  return {
    operations: writePairs(document, slideId, kept),
    notice: `Removed ${dropped} pair${dropped === 1 ? "" : "s"} whose objects are no longer on these slides.`,
  };
}
