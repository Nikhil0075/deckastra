/**
 * Slide transitions: pairing, deltas, kinds, compile, sample (D4.1).
 *
 * Six modules rather than one file, and the split is along the lines these
 * things actually fail on. Pairing can be wrong about *which* elements
 * correspond; deltas about *how far* one travels; a kind about *what it looks
 * like*; the compiler about *when*; the sampler about *interpolation*. Each is
 * a pure function with no knowledge of the others, so a test for one is a test
 * for one thing, and a new transition type is a new entry in a registry rather
 * than a branch in code four other concerns also read.
 */

export {
  TRANSITION_KINDS,
  TRANSITION_KIND_NAMES,
  resolveTransitionKind,
  type TransitionDirection,
  type TransitionKindContext,
  type TransitionKindDefinition,
  type TransitionKindResult,
} from "./kinds";

export {
  PAIR_THRESHOLD,
  resolvePairing,
  scorePair,
  type PairingInput,
} from "./pairing";

export { isMoving, pairDelta } from "./delta";

export {
  DEFAULT_TRANSITION_MS,
  compileTransition,
  entranceStartMs,
  type CompileTransitionOptions,
  type TransitionSpec,
} from "./compile";

export { isTransitionComplete, sampleTransition, type TransitionStyles } from "./sample";

export { transitionCss, transitionEasingCss } from "./css";

export type {
  CompiledTransition,
  ElementPair,
  MatchMode,
  PairDelta,
  PairOrigin,
  Pairing,
  RejectedPair,
  TransitionKeyframe,
  TransitionNode,
  TransitionSlide,
  TransitionTrack,
} from "./types";
