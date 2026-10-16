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
  /** The persisted user question this alternative answers. */
  in_reply_to?: string | null;
}

export type AgentRequestKind = "motion" | "style" | "content" | "image" | "layout" | "review" | "other";

export interface AgentRequestTarget {
  slide_ids: string[];
  element_ids: string[];
}

export interface ResolvedAgentRequestTarget {
  slides: { id: string; name: string }[];
  elements: {
    id: string;
    slide_id: string;
    type?: string;
    name?: string | null;
    semantic_role?: string | null;
    text?: string | null;
    motion: unknown[];
  }[];
  missing_slide_ids: string[];
  missing_element_ids: string[];
}

export interface AgentRequest {
  id: string;
  presentation_id: string;
  target: AgentRequestTarget;
  kind: AgentRequestKind;
  message: string;
  based_on_version_id: string;
  status: "open" | "answered" | "closed";
  created_by: string;
  created_at: string;
  proposal_ids: string[];
  resolved_target: ResolvedAgentRequestTarget;
  /** What the agent found, in words, when it answered without (or beside) a change. */
  findings?: string | null;
}

export interface CreateAgentRequest {
  target: AgentRequestTarget;
  kind: AgentRequestKind;
  message: string;
  based_on_version_id: string;
}

export interface AgentTask {
  id: string;
  project_id: string;
  resource_type: "deck" | "draft";
  resource_id: string;
  resource_title: string;
  resource_deleted: boolean;
  kind: AgentRequestKind;
  message: string;
  status: "open" | "answered" | "closed";
  created_at: string;
  completed_at: string | null;
  target_summary: { slides: number; objects: number; cards: number };
  proposal_ids: string[];
  findings?: string | null;
}

export interface StyleOptionInput {
  label: string;
  design_language?: string;
  theme_key?: string;
  palette?: { background: string; text: string; accent: string; secondary?: string; series?: string[] };
  fonts?: { display?: string; body?: string };
  motion_style?: string;
  rationale: string;
}

export interface StyleOption {
  id: string;
  label: string;
  rationale: string;
  design_language?: string | null;
  theme_key?: string | null;
  motion_style?: string | null;
  notes: string[];
  preview_document: PresentationDocument;
}

export interface StyleOptionSet {
  id: string;
  presentation_id: string;
  based_on_version_id: string;
  slide_id: string;
  status: "open" | "chosen" | "expired";
  stale: boolean;
  chosen_option_id: string | null;
  created_at: string;
  expires_at: string;
  options: StyleOption[];
}

export interface StyleSuggestionRequest {
  expected_version_id: string;
  slide_id?: string;
  options: StyleOptionInput[];
  /** Which client suggested these, for the history row a choice writes. */
  client_label?: string;
}

/** Reserve direct storage for an image made by an external generation tool. */
export interface ImageImportPrepareRequest {
  expected_version_id: string;
  slide_id: string;
  filename: string;
  content_type: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
  width: number;
  height: number;
  prompt: string;
  style_source?: "deck" | "prompt";
}

export interface ImageImportPrepareResult {
  method: "PUT";
  upload_url: string;
  headers: Record<string, string>;
  upload_token: string;
  expires_at: number;
}

export interface ImageImportResult {
  asset: { id: string; filename: string | null; kind?: string; tags: string[]; description: string | null };
  proposal_id: string;
  status: "pending";
  risk_tier: string;
  slide_id: string;
  awaiting: string;
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
