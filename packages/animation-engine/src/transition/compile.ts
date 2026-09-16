/**
 * Compile a slide transition, once (doc 04 §26.2).
 *
 * The same contract the clip compiler keeps, for the same reason: everything
 * relative — a direction, a pairing, a delta between two scenes — is resolved
 * here, and everything after this is a pure function of time. That is what makes
 * `seek(t)` and `play → pause at t` agree, and it is an acceptance criterion
 * rather than a preference.
 *
 * It also means the sampler never touches a scene. A morph's geometry comes from
 * two slides that both have to be laid out to be measured; doing that per frame
 * would put a layout pass inside a 60Hz loop, and doing it per frame *sometimes*
 * would make the transition depend on when it was asked.
 */

import { DEFAULT_EASING, round } from "../easing";
import { isMoving, pairDelta } from "./delta";
import { resolvePairing, type PairingInput } from "./pairing";
import { resolveTransitionKind, type TransitionDirection } from "./kinds";
import type { CompiledTransition, MatchMode, PairDelta, TransitionSlide } from "./types";

export interface TransitionSpec {
  type?: string;
  durationMs?: number;
  easing?: string;
  direction?: TransitionDirection;
  sharedElements?: readonly {
    sourceElementId: string;
    destinationElementId: string;
    matchMode?: MatchMode;
  }[];
}

export interface CompileTransitionOptions {
  /** `"reduced"` and `"none"` both cut. A shortened version of something someone asked not to see is not an accommodation. */
  motion?: "full" | "reduced" | "none";
  /** Score unpaired elements and pair the confident ones. Off by default. */
  autoPair?: boolean;
  pairThreshold?: number;
}

/** Doc 04 §27.1: long enough to read as continuous, short enough not to be waited on. */
export const DEFAULT_TRANSITION_MS = 300;

function cut(requestedType: string, degraded?: string): CompiledTransition {
  return {
    type: "cut",
    requestedType,
    durationMs: 0,
    easing: DEFAULT_EASING,
    tracks: [],
    pairing: { pairs: [], rejected: [], warnings: [] },
    degraded,
    warnings: [],
  };
}

export function compileTransition(
  spec: TransitionSpec | undefined,
  from: TransitionSlide | undefined,
  to: TransitionSlide,
  options: CompileTransitionOptions = {},
): CompiledTransition {
  const requestedType = spec?.type ?? "fade";
  const motion = options.motion ?? "full";

  if (motion !== "full") {
    return cut(
      requestedType,
      requestedType === "cut" ? undefined : "Reduced motion is on, so slides cut.",
    );
  }

  // The first slide has nothing to transition *from*. A fade from a blank
  // surface is a flash, not a transition.
  if (!from) return cut(requestedType);

  const { kind, degraded } = resolveTransitionKind(requestedType);
  const durationMs = Math.max(0, Math.round(spec?.durationMs ?? DEFAULT_TRANSITION_MS));
  if (kind.name === "cut" || durationMs === 0) return cut(requestedType, degraded);

  // The easing *name*, not its CSS. `easingAt` resolves names and answers
  // `linear` for anything it does not recognise — so storing `cubic-bezier(…)`
  // here would sample every transition linearly with nothing failing anywhere.
  // CSS is produced at the DOM boundary, by `transitionCss`.
  const easing = spec?.easing ?? DEFAULT_EASING;
  const warnings: string[] = [];

  // Pairing runs for every kind, not only morph: an author who switches a morph
  // to a push should not silently lose the mappings, and the editor wants to
  // show them either way. Only `morph` consumes the deltas.
  const pairingInput: PairingInput = {
    from,
    to,
    explicit: spec?.sharedElements,
    auto: options.autoPair,
    threshold: options.pairThreshold,
  };
  const pairing = resolvePairing(pairingInput);
  warnings.push(...pairing.warnings);

  const sources = new Map(from.nodes.map((node) => [node.id, node]));
  const destinations = new Map(to.nodes.map((node) => [node.id, node]));
  const deltas: PairDelta[] = [];
  for (const pair of pairing.pairs) {
    const source = sources.get(pair.sourceId);
    const destination = destinations.get(pair.destinationId);
    if (!source || !destination) continue;
    const delta = pairDelta(source, destination, pair.matchMode);
    // A pair that does not move is not drawn. Emitting a track that animates
    // nothing costs a compositor layer per element and buys no motion — and on a
    // slide where the title genuinely does not move, that is most of the slide.
    if (isMoving(delta)) deltas.push(delta);
  }

  const planned = kind.plan({ direction: spec?.direction ?? "left", deltas, easing });
  if (planned.warning) warnings.push(planned.warning);

  return {
    type: kind.name,
    requestedType,
    durationMs,
    easing,
    tracks: planned.tracks,
    pairing,
    degraded,
    warnings,
  };
}

/**
 * When the incoming slide's own entrance animations may start.
 *
 * After the transition, always. An entrance that begins while the slide is still
 * arriving is two motions competing for the same attention, and on a `push` it
 * is an element animating relative to a surface that is itself moving — which
 * looks like a bug rather than a build.
 */
export function entranceStartMs(transition: CompiledTransition): number {
  return round(transition.durationMs);
}
