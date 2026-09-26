import type { PatchOperation } from "@deckastra/presentation-schema";

/**
 * Motion, as an agent may describe it (doc 03 §12, doc 04 §24).
 *
 * Roles, a preset and one word of pacing — never durations, delays or easing.
 * That is the same division the Story Architect lives under, applied to time,
 * and it is what makes the per-slide entrance budget enforceable: code computes
 * the numbers, so a plan cannot quietly over-run by naming its own.
 */

export interface MotionCapabilities {
  /** Presets the composer will emit. Anything else falls back to `fade`. */
  presets: string[];
  /** Pacing word to the durations it produces, so a caller can see the effect. */
  pacing: Record<string, { durationMs: number; gapMs: number }>;
  /** The role vocabulary a sequence is written in. */
  roles: string[];
  entrance_budget_ms: number;
  read_immediately_words: number;
  notes: string[];
}

export interface MotionRequest {
  slide_id: string;
  /** The version the plan was authored against. A moved deck is a 409. */
  expected_version_id: string;
  /** Reveal order by semantic role. Roles left out are there from the first frame. */
  sequence: string[];
  entrance?: string;
  pacing?: "tight" | "measured" | "deliberate";
  /** How many later steps wait for a click rather than running on entry. */
  click_reveals?: number;
  intent?: string;
  client_label?: string;
  /** Plan without proposing: nothing is written, the operations come back. */
  dry_run?: boolean;
}

export interface MotionResult {
  /** "applied", "pending" when a human must approve, or "none" when nothing matched. */
  outcome: string;
  risk_tier?: string;
  reasons?: string[];
  transaction_id?: string | null;
  version_id?: string | null;
  expires_at?: string | null;
  /** Tracks the slide ended up with. */
  track_count?: number;
  /** What the composer left alone, and why. Never silent. */
  warnings: string[];
  refusal?: string;
  /** A dry run's plan, against `version_id`. Absent when anything was written. */
  operations?: PatchOperation[];
}

/**
 * How the deck moves *into* a slide (doc 02 §26).
 *
 * Roles rather than element ids, for the reason the entrance plan uses roles: a
 * caller plans before a composer has minted ids, and a pairing written in roles
 * survives the slide being re-laid out.
 */
export interface TransitionRequest {
  slide_id: string;
  expected_version_id: string;
  kind?: "cut" | "fade" | "slide" | "push" | "zoom" | "morph";
  pacing?: "tight" | "measured" | "deliberate";
  /** Semantic roles that travel across the boundary. Only a morph carries them. */
  carry?: string[];
  intent?: string;
  client_label?: string;
  /** Plan without proposing: nothing is written, the operations come back. */
  dry_run?: boolean;
}

export interface TransitionResult {
  outcome: string;
  risk_tier?: string;
  reasons?: string[];
  transaction_id?: string | null;
  version_id?: string | null;
  expires_at?: string | null;
  /** How many objects were paired across the boundary. */
  paired?: number;
  warnings: string[];
  refusal?: string;
  /** A dry run's plan, against `version_id`. Absent when anything was written. */
  operations?: PatchOperation[];
}
