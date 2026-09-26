import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

export interface EditScopePayload {
  kind: "deck" | "slide" | "elements";
  slide_ids: string[];
  element_ids: string[];
  sources: string[];
}

export interface AgentChange {
  element_id: string;
  change: string;
  reason: string;
}

export interface AgentEditResult {
  run_id: string;
  status: string;
  /** "applied" when the risk tier allowed it, "pending" when a human must decide. */
  outcome: "applied" | "pending" | "none";
  transaction_id?: string | null;
  version_id?: string | null;
  document?: unknown;
  /** What the change would produce. Not stored anywhere — a stored preview goes stale. */
  preview?: unknown;
  /**
   * Computed server-side from the operations (doc 02 §31.7). Reported here, never
   * supplied: a caller-declared tier is a caller-controlled security boundary.
   */
  risk_tier: string;
  reasons: string[];
  changes: AgentChange[];
  warnings: string[];
  refusal?: string | null;
  expires_at?: string | null;
}

export interface PendingProposal {
  id: string;
  status: string;
  intent: string;
  reason: string | null;
  risk_tier: string | null;
  agent_id: string | null;
  run_id: string | null;
  created_at: string;
  /** 24 hours out. A proposal is re-validated against the head on approval. */
  expires_at: string | null;
  operation_count: number;
}

/**
 * One pending proposal with its operations (editor Phase 6). The AI panel draws
 * Before and After from these, applied to the deck on screen.
 */
export interface ProposalDetail extends PendingProposal {
  operations: PatchOperation[];
  /** The version the change was written against. */
  base_version_id: string | null;
}

/** What approving a proposal or reverting a transaction gives back. */
export interface AppliedChange {
  transaction_id: string;
  version_id: string;
  document: PresentationDocument;
}
