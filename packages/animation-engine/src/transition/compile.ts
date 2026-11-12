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

import { DEFAULT_EASING, parseSpring, round, sampleSpring, type Spring } from "../easing";
import { isMoving, pairDelta } from "./delta";
import { resolvePairing, type PairingInput } from "./pairing";
import { resolveTransitionKind, type TransitionDirection } from "./kinds";
import { interpolate } from "./sample";
import type {
  CompiledTransition,
  MatchMode,
  PairDelta,
  TransitionKeyframe,
  TransitionNode,
  TransitionSlide,
  TransitionTrack,
} from "./types";

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
  // A group travels with everything in it, so a pair inside a paired group
  // would be drawn twice — once carried by its group and once on its own path.
  // The group's pairing wins: it is the larger object and the one the author
  // reads as moving.
  const pairedSources = new Set(pairing.pairs.map((pair) => pair.sourceId));
  const pairedDestinations = new Set(pairing.pairs.map((pair) => pair.destinationId));
  const deltas: PairDelta[] = [];
  for (const pair of pairing.pairs) {
    const source = sources.get(pair.sourceId);
    const destination = destinations.get(pair.destinationId);
    if (!source || !destination) continue;
    if (insidePaired(source, sources, pairedSources) || insidePaired(destination, destinations, pairedDestinations)) {
      warnings.push(
        `"${pair.sourceId}" moves with the group it is in, which is paired too, so it is not paired on its own.`,
      );
      continue;
    }
    const delta = pairDelta(source, destination, pair.matchMode);
    // A pair that does not move is not drawn. Emitting a track that animates
    // nothing costs a compositor layer per element and buys no motion — and on a
    // slide where the title genuinely does not move, that is most of the slide.
    if (isMoving(delta)) deltas.push(delta);
  }

  const planned = kind.plan({ direction: spec?.direction ?? "left", deltas, easing });
  if (planned.warning) warnings.push(planned.warning);

  const spring = parseSpring(easing);
  const tracks = spring ? springTracks(planned.tracks, easing, spring, durationMs, warnings) : planned.tracks;

  return {
    type: kind.name,
    requestedType,
    durationMs,
    easing,
    tracks,
    pairing,
    ...(kind.perspective ? { perspective: kind.perspective } : {}),
    degraded,
    warnings,
  };
}

/** Properties that may pass their end value and come back. */
const OVERSHOOTS = new Set(["translateX", "translateY", "scaleX", "scaleY", "scale", "rotate", "rotateX", "rotateY"]);

/**
 * A spring named as the transition's easing, sampled into keyframes here.
 *
 * The same rule the clip compiler keeps: past this point nothing knows what a
 * spring is. `easingAt` answers `linear` for a name it cannot resolve, so a
 * spring left on a track would have been sampled as a straight line with
 * nothing failing anywhere.
 *
 * Only movement overshoots. An opacity past 1, a negative blur or a clip swept
 * past a full turn are values outside their own domain, so those follow the
 * spring's progress held between its two ends. A track with more than two
 * keyframes has no single journey for a spring to describe; it keeps its shape
 * on the default easing, and says so.
 */
function springTracks(
  tracks: TransitionTrack[],
  easing: string,
  spring: Spring,
  durationMs: number,
  warnings: string[],
): TransitionTrack[] {
  const samples = sampleSpring(spring, durationMs);
  let reshaped = false;

  const out = tracks.map((track): TransitionTrack => {
    // A track on its own clock (a morph's crossfade, a swap's order) is not the
    // transition's easing and is left exactly as the kind wrote it.
    if (track.easing !== easing) return track;
    if (track.keyframes.length !== 2) {
      reshaped = true;
      return { ...track, easing: DEFAULT_EASING };
    }

    const [from, to] = track.keyframes as [TransitionKeyframe, TransitionKeyframe];
    const span = to.offset - from.offset;
    const names = new Set([...Object.keys(from.properties), ...Object.keys(to.properties)]);
    return {
      ...track,
      // Linear between samples: the curve is the samples, and easing between
      // them would apply the shape twice.
      easing: "linear",
      keyframes: samples.map((sample) => {
        const properties: Record<string, string | number> = {};
        for (const name of names) {
          const start = from.properties[name] ?? to.properties[name]!;
          const end = to.properties[name] ?? from.properties[name]!;
          const progress = OVERSHOOTS.has(name) ? sample.value : Math.min(1, Math.max(0, sample.value));
          properties[name] = interpolate(start, end, progress);
        }
        return { offset: round(from.offset + sample.offset * span), properties };
      }),
    };
  });

  if (reshaped) {
    warnings.push(
      "This transition moves in more than one stage, so the spring was not applied to it. It uses the default easing.",
    );
  }
  return out;
}

function insidePaired(
  node: TransitionNode,
  nodes: ReadonlyMap<string, TransitionNode>,
  paired: ReadonlySet<string>,
): boolean {
  let parent = node.parentId;
  while (parent) {
    if (paired.has(parent)) return true;
    parent = nodes.get(parent)?.parentId;
  }
  return false;
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
