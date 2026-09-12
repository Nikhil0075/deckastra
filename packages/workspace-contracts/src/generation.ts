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
}
