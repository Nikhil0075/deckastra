import type { PresentationDocument } from "@deckastra/presentation-schema";

/**
 * Languages and narration (integration plan 01 §3.7, §3.8).
 *
 * Both writes come back as proposals: `outcome` is "applied" for a change small
 * enough to land, "pending" for one a person must approve, "none" when there
 * was nothing to do.
 */

export interface ServiceStatus {
  /** "stub", "model", "google", or "none" when nothing is set up. */
  provider: string;
  available: boolean;
  /** What pressing the button will do, including what leaves the machine. */
  reason: string | null;
}

export interface LanguagesStatus {
  translation: ServiceStatus;
  speech: ServiceStatus;
}

export interface TranslateRequest {
  scope: "missing" | "outdated" | "slides";
  slide_ids?: string[];
  expected_version_id: string;
  /** Words never to translate: brand and product names. */
  glossary?: string[];
  /** Signed, short-lived approval of the exact paid request. Not needed by a local stand-in. */
  quote_token?: string;
}

export interface ServiceProposalResult {
  outcome: "applied" | "pending" | "none";
  transaction_id?: string;
  version_id?: string | null;
  document?: PresentationDocument | null;
  preview?: PresentationDocument | null;
  risk_tier?: string;
  reasons?: string[];
  expires_at?: string | null;
  provider?: string;
  message?: string;
  characters?: number;
}

export interface TranslateResult extends ServiceProposalResult {
  translated?: string[];
  refused?: { path: string; reason: string }[];
  /** Paragraphs whose mixed formatting became one run in translation. */
  simplified?: number;
}

export interface Voice {
  name: string;
  label: string;
  gender?: string;
}

export interface SynthesizeRequest {
  locale: string;
  /** Empty: every cue whose recording in this language is missing or stale. */
  cue_ids?: string[];
  voice?: string;
  rate?: number;
  expected_version_id: string;
  /** Names the voice should say differently from how they are spelled. */
  pronunciations?: Pronunciation[];
  /** Signed, short-lived approval of the exact paid request. Not needed by a local stand-in. */
  quote_token?: string;
}

export interface PaidServiceQuote {
  quote_token: string;
  expires_at: number;
  task: "image" | "translation" | "speech";
  provider: string;
  model?: string | null;
  units: number;
  estimated_usd: number;
  credit_cost: number;
}

/** Say `term` as `say` when voicing narration (plan 01 §7). */
export interface Pronunciation {
  term: string;
  say: string;
}

export interface SynthesizeResult extends ServiceProposalResult {
  voiced?: { cue_id: string; asset_id: string; duration_ms: number; voice?: string; word_timings?: number }[];
}
