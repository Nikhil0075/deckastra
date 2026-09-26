import type { PresentationDocument } from "@deckastra/presentation-schema";

/**
 * What a generation run reports about itself.
 *
 * `source: "stub"` is surfaced, not hidden: a deck composed without a key is
 * still a real deck and the user must know which they are looking at before they
 * wait for it. `attempts` is the maximum schema attempts for any structured
 * request, excluding provider transport retries.
 */
export interface GenerationDiagnostics {
  source: "model" | "stub";
  model: string;
  attempts: number;
  plan_valid_first_attempt: boolean;
  validation_errors: string[];
  warnings: string[];
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export interface GenerateRequest {
  instruction: string;
  audience: string;
  slide_count: number;
  repository_ids: string[];
  project_id?: string | null;
  use_graph?: boolean;
}

export interface GenerateResult {
  presentation_id: string;
  document: PresentationDocument;
  diagnostics: GenerationDiagnostics;
  version_id?: string;
  run_id?: string | null;
}

/** One slide of an outline under review: its words, never its geometry. */
export interface OutlineSlide {
  headline: string;
  key_message: string;
  layout: string;
}

export interface StoryOutline {
  title: string;
  narrative_arc: string;
  slides: OutlineSlide[];
  warnings: string[];
}

/**
 * A generation that stops at its outline for a person (editor Phase 6).
 *
 * `awaiting_story` carries the outline and the run to resume; `completed` the
 * deck, exactly as a plain generation returns it; `rejected` nothing, because
 * nothing was made.
 */
export interface ReviewedGeneration {
  run_id: string;
  status: "awaiting_story" | "completed" | "rejected";
  outline?: StoryOutline | null;
  generation?: GenerateResult | null;
}

/** What a person decided about a paused outline. A revision needs a note. */
export type StoryDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "revise"; note: string };
