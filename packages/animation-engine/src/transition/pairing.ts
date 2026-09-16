/**
 * Which element becomes which, across a slide boundary (doc 02 §26).
 *
 * The schema states the rule this file implements: *"Explicit pairing wins.
 * Absent it the renderer auto-pairs with a scored heuristic and labels the
 * auto-pairs in the UI so the author can confirm or break them. Two unrelated
 * objects are never silently morphed."*
 *
 * The last sentence is the hard one, and it is why this scores rather than
 * matches. A morph between two things that are not the same thing is not a
 * lesser morph — it is an object visibly turning into an unrelated object in
 * front of an audience, which is worse than a cut. So a pair has to earn a
 * threshold, every refusal is kept and reportable, and the engine says how
 * confident it was rather than only what it did.
 *
 * Everything here is deterministic and has no opinion about drawing: candidates
 * are scored, sorted, and resolved greedily with document order as the tie-break
 * — the same rule the diagram force layout uses, for the same reason. Two runs
 * over one document must pair the same way, or a morph moves between opens.
 */

import { round } from "../easing";
import type { ElementPair, MatchMode, Pairing, RejectedPair, TransitionNode, TransitionSlide } from "./types";

/**
 * Below this, nothing is paired.
 *
 * Tuned to sit above "same type, similar size" — two unrelated cards on
 * consecutive slides — and below "same role" or "same words". A threshold that
 * let shape similarity alone through would morph every bullet into every other
 * bullet.
 */
export const PAIR_THRESHOLD = 0.6;

const DEFAULT_MATCH_MODE: MatchMode = "positionAndScale";

function normalizeText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 1 when identical, falling off with relative difference. Never negative. */
function similarity(a: number, b: number): number {
  const largest = Math.max(Math.abs(a), Math.abs(b));
  if (largest === 0) return 1;
  return Math.max(0, 1 - Math.abs(a - b) / largest);
}

/**
 * How alike two nodes are, and why — the reason travels with the score so the
 * editor can show it and an author can disagree with something specific rather
 * than with a number.
 */
export function scorePair(
  source: TransitionNode,
  destination: TransitionNode,
): { confidence: number; reason: string } {
  // A different kind of thing is never the same thing. Refused before scoring,
  // because no accumulation of size similarity should turn a chart into a
  // heading.
  if (source.type !== destination.type) {
    return { confidence: 0, reason: `different element types (${source.type} → ${destination.type})` };
  }

  // The same id on both slides is the author having literally reused the
  // element. Nothing outranks it.
  if (source.id === destination.id) {
    return { confidence: 1, reason: "the same element id appears on both slides" };
  }

  const text = normalizeText(source.text);
  const sameText = text.length > 0 && text === normalizeText(destination.text);
  const sameAsset =
    source.assetKey !== undefined && source.assetKey === destination.assetKey;
  const sameRole =
    source.semanticRole !== undefined && source.semanticRole === destination.semanticRole;

  // Identity signals first: the same words or the same image *is* the same
  // object as far as an audience is concerned, however much it moved or resized.
  if (sameAsset) return { confidence: 0.95, reason: "the same image" };
  if (sameText) {
    return {
      confidence: sameRole ? 0.95 : 0.85,
      reason: sameRole ? `the same text in the same role (${source.semanticRole})` : "the same text",
    };
  }

  if (!sameRole) {
    // Left deliberately below the threshold. Shape alone is not identity, and
    // the score is returned rather than zeroed so a UI can show a near miss.
    const shape =
      0.25 *
      (similarity(source.bounds.width, destination.bounds.width) +
        similarity(source.bounds.height, destination.bounds.height));
    return { confidence: round(shape), reason: "only a similar size, which is not identity" };
  }

  // Same role, different words: a title becoming another title. Real, but weaker
  // than sameness, so geometry decides whether it reads as one object moving.
  const geometry =
    (similarity(source.bounds.width, destination.bounds.width) +
      similarity(source.bounds.height, destination.bounds.height)) /
    2;
  return {
    confidence: round(0.55 + 0.4 * geometry),
    reason: `the same role (${source.semanticRole}) at a similar size`,
  };
}

export interface PairingInput {
  from: TransitionSlide;
  to: TransitionSlide;
  /** Author-declared mappings. Always honoured, never scored. */
  explicit?: readonly { sourceElementId: string; destinationElementId: string; matchMode?: MatchMode }[];
  /** Off by default: a deck should not start morphing because someone reordered slides. */
  auto?: boolean;
  threshold?: number;
}

/**
 * Resolve the pairs for one transition.
 *
 * Auto-pairing is **opt-in**. The schema allows it and the editor will offer it,
 * but a deck that silently began morphing because two slides happen to share a
 * heading role would be changing a presentation nobody edited.
 */
export function resolvePairing(input: PairingInput): Pairing {
  const threshold = input.threshold ?? PAIR_THRESHOLD;
  const sources = new Map(input.from.nodes.map((node) => [node.id, node]));
  const destinations = new Map(input.to.nodes.map((node) => [node.id, node]));

  const pairs: ElementPair[] = [];
  const rejected: RejectedPair[] = [];
  const warnings: string[] = [];
  const takenSource = new Set<string>();
  const takenDestination = new Set<string>();

  for (const mapping of input.explicit ?? []) {
    const source = sources.get(mapping.sourceElementId);
    const destination = destinations.get(mapping.destinationElementId);
    if (!source || !destination) {
      // Named and dropped rather than silently ignored: an author who deleted
      // one half of a pair should be told which mapping stopped working, not
      // left wondering why the morph went away.
      warnings.push(
        `A shared-element mapping names ${!source ? mapping.sourceElementId : mapping.destinationElementId}, ` +
          "which is not on its slide any more, so that pair was dropped.",
      );
      continue;
    }
    pairs.push({
      sourceId: source.id,
      destinationId: destination.id,
      matchMode: mapping.matchMode ?? DEFAULT_MATCH_MODE,
      origin: "explicit",
      confidence: 1,
      reason: "the author paired these",
    });
    takenSource.add(source.id);
    takenDestination.add(destination.id);
  }

  if (input.auto) {
    const candidates: { source: TransitionNode; destination: TransitionNode; confidence: number; reason: string }[] = [];
    for (const source of input.from.nodes) {
      if (takenSource.has(source.id)) continue;
      for (const destination of input.to.nodes) {
        if (takenDestination.has(destination.id)) continue;
        const { confidence, reason } = scorePair(source, destination);
        if (confidence > 0) candidates.push({ source, destination, confidence, reason });
      }
    }

    // Highest first; ties broken by document order so the result cannot depend
    // on Map iteration or on which slide was loaded first.
    const order = new Map(input.from.nodes.map((node, index) => [node.id, index]));
    const destinationOrder = new Map(input.to.nodes.map((node, index) => [node.id, index]));
    candidates.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (order.get(a.source.id) ?? 0) - (order.get(b.source.id) ?? 0) ||
        (destinationOrder.get(a.destination.id) ?? 0) - (destinationOrder.get(b.destination.id) ?? 0),
    );

    for (const candidate of candidates) {
      if (takenSource.has(candidate.source.id) || takenDestination.has(candidate.destination.id)) continue;
      if (candidate.confidence < threshold) {
        rejected.push({
          sourceId: candidate.source.id,
          destinationId: candidate.destination.id,
          confidence: candidate.confidence,
          reason: candidate.reason,
        });
        continue;
      }
      pairs.push({
        sourceId: candidate.source.id,
        destinationId: candidate.destination.id,
        matchMode: DEFAULT_MATCH_MODE,
        origin: "auto",
        confidence: candidate.confidence,
        reason: candidate.reason,
      });
      takenSource.add(candidate.source.id);
      takenDestination.add(candidate.destination.id);
    }
  }

  return { pairs, rejected, warnings };
}
