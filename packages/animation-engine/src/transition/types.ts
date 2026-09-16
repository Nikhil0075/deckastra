/**
 * The vocabulary of a slide transition (doc 02 §26, doc 04 §27, §33.3).
 *
 * Kept in its own file because five modules share it and none of them should
 * have to import another's implementation to name a thing. Pairing does not know
 * how a morph is drawn; a kind does not know how pairs were found; the sampler
 * knows neither.
 *
 * One decision is encoded in these shapes rather than in prose, because it
 * decides everything downstream: **a transition owns its own clock.** `t = 0` is
 * the moment the incoming slide begins to arrive, not a position in either
 * slide's timeline. Both slides exist at once while it runs, so neither one's
 * clock can be the transition's — and the incoming slide's entrance animations
 * must not start until it ends, or they play underneath a slide that is still
 * moving.
 */

/** Just enough of a scene node to pair and measure. No renderer import needed. */
export interface TransitionNode {
  id: string;
  type: string;
  semanticRole?: string;
  /** World-space, after layout and container placement. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Flattened text, when the node has any. Used to recognise the same words. */
  text?: string;
  /** For images: the asset behind it, which is a far stronger signal than shape. */
  assetKey?: string;
  opacity?: number;
  rotation?: number;
}

/** A slide reduced to what a transition needs from it. */
export interface TransitionSlide {
  id: string;
  nodes: readonly TransitionNode[];
}

export type MatchMode = "position" | "positionAndScale" | "full";

/** How a pair was arrived at, which the editor shows and the author can confirm. */
export type PairOrigin = "explicit" | "auto";

export interface ElementPair {
  sourceId: string;
  destinationId: string;
  matchMode: MatchMode;
  origin: PairOrigin;
  /** 0–1. Always 1 for an explicit pair: the author said so. */
  confidence: number;
  /** Why the pair was made, in words an author can disagree with. */
  reason: string;
}

/** A candidate the engine considered and refused, so the refusal is inspectable. */
export interface RejectedPair {
  sourceId: string;
  destinationId: string;
  confidence: number;
  reason: string;
}

export interface Pairing {
  pairs: ElementPair[];
  rejected: RejectedPair[];
  warnings: string[];
}

/**
 * What one paired element does over the transition.
 *
 * Deltas, never destinations — the same rule the animation presets follow. An
 * element told to move by `dx` survives its slide being re-laid out; one told to
 * move *to* a coordinate silently animates to the wrong place the moment the
 * layout changes.
 */
export interface PairDelta {
  sourceId: string;
  destinationId: string;
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise positive, as everywhere else in this product. */
  rotate: number;
  fadeFrom: number;
  fadeTo: number;
}

export interface TransitionKeyframe {
  /** 0–1 within the transition. Absolute ms is the compiler's job. */
  offset: number;
  properties: Record<string, number | string>;
}

/** A layer the transition animates: the whole outgoing slide, the whole incoming one, or one paired element. */
export interface TransitionTrack {
  /** `slide:out`, `slide:in`, or the destination element id for a morph. */
  targetId: string;
  kind: "outgoing" | "incoming" | "paired";
  keyframes: TransitionKeyframe[];
  easing: string;
}

export interface CompiledTransition {
  type: string;
  requestedType: string;
  durationMs: number;
  easing: string;
  tracks: TransitionTrack[];
  pairing: Pairing;
  /** Stated whenever what is drawn is not what was asked for. */
  degraded?: string;
  warnings: string[];
}
