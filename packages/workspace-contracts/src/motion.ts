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
}
