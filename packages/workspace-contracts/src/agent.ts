import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

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
