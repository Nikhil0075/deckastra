import type { PatchOperation } from "@deckastra/presentation-schema";
import type { MotionStyleId } from "./presets";

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
  /** Release 8: every preset by category, for object motion. */
  categories?: Record<"entrance" | "emphasis" | "loop" | "exit", string[]>;
  loop_and_emphasis_timing?: Record<string, unknown>;
}

/** Motion on named objects: an entrance, an emphasis, a loop or an exit (release 8). */
export interface ObjectMotionRequest {
  slide_id: string;
  expected_version_id: string;
  element_ids?: string[];
  roles?: string[];
  category: "entrance" | "emphasis" | "loop" | "exit";
  preset: string;
  /** Entrances and exits only. */
  pacing?: "tight" | "measured" | "deliberate";
  /** Loops and emphasis only, like the timing fields below. */
  speed?: "slow" | "medium" | "fast";
  duration_ms?: number;
  delay_ms?: number;
  repeat?: number;
  direction?: "normal" | "reverse" | "alternate";
  easing?: string;
  trigger?: "slideEnter" | "withPrevious" | "afterPrevious" | "click";
  stagger_ms?: number;
  intent?: string;
  client_label?: string;
  dry_run?: boolean;
  in_reply_to?: string;
}

/** "Add subtle looping accents to these slides" (release 8). */
export interface AmbientMotionRequest {
  slide_ids: string[];
  expected_version_id: string;
  intensity?: "subtle" | "noticeable";
  intent?: string;
  client_label?: string;
  dry_run?: boolean;
  in_reply_to?: string;
}

export interface ObjectMotionResult {
  outcome: string;
  warnings: string[];
  transaction_id?: string;
  risk_tier?: string;
  reasons?: string[];
  operations?: unknown[];
  version_id?: string;
  refusal?: string;
  next?: string;
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
  /** The person's request this plan answers; a reply always waits for them. */
  in_reply_to?: string;
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

/** Apply one reviewed motion vocabulary to the whole deck. */
export interface MotionStyleRequest {
  expected_version_id: string;
  style: MotionStyleId;
  intent?: string;
  client_label?: string;
  /** Return editor-ready operations without creating a server proposal. */
  dry_run?: boolean;
}

export interface MotionStyleResult {
  outcome: string;
  risk_tier?: string;
  reasons?: string[];
  transaction_id?: string | null;
  version_id?: string | null;
  expires_at?: string | null;
  style: MotionStyleId;
  slides_changed: number;
  warnings: string[];
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
  kind?: "cut" | "fade" | "slide" | "cover" | "push" | "zoom" | "wipe" | "split" | "iris" | "flip" | "blurDissolve" | "morph";
  pacing?: "tight" | "measured" | "deliberate";
  /** Semantic roles that travel across the boundary. Only a morph carries them. */
  carry?: string[];
  intent?: string;
  client_label?: string;
  /** Plan without proposing: nothing is written, the operations come back. */
  dry_run?: boolean;
  /** The person's request this plan answers; a reply always waits for them. */
  in_reply_to?: string;
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
