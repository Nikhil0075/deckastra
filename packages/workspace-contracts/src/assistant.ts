import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
export type AssistantTask = "generate" | "edit" | "tidy" | "alt_text" | "consistency" | "translation" | "narration" | "motion" | "organise" | "research" | "image" | "speech" | "export";
export interface AssistantRequest {
  task: AssistantTask; presentation_id: string; expected_version_id: string; operation_key: string;
  instruction?: string;
  scope: { kind: "deck" | "slide" | "elements"; slide_ids: string[]; element_ids: string[] };
  quality?: "quality"; locale?: string; voice?: string; slide_count?: number;
  source_asset_ids?: string[]; web_search?: boolean; export_kind?: "pdf" | "pptx";
  generation_mode?: "append" | "replace"; research_run_id?: string;
  motion_entrance?: string; motion_pacing?: "tight" | "measured" | "deliberate"; motion_click_reveals?: number;
  /** Replace a slide's existing animation tracks; otherwise those slides are kept. */
  motion_replace?: boolean;
}
export interface AssistantRun {
  id: string; presentation_id: string; task: AssistantTask;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  error: string | null;
  result: { document?: PresentationDocument; version_id?: string; transaction_id?: string; status?: string; summary?: string; clarification?: string; metadata_proposal?: { asset_id: string; tags: string[]; description: string }[]; warnings?: string[]; research?: string; sources?: { id?: string; url?: string; title?: string }[]; assets?: AssistantAsset[]; export?: { id: string } } | null;
  budget: { used_cost_usd?: number; reserved_cost_usd?: number; used_tokens?: number } | null;
  last_sequence: number; created_at: string; cancel_requested: boolean;
}
export interface AssistantEvent { sequence: number; status: string; message?: string; provider?: string; task?: string; reason?: string; at: string }
export interface AssistantCapabilities { provider: string; available: boolean; reason: string | null; spend?: { ceiling_usd: number; used_usd: number; reserved_usd: number; remaining_usd: number; calls: number } | null; tasks: Record<AssistantTask, { available: boolean; provider: string; model?: string | null; inputs?: string[]; reason: string | null; minimum_reservation_usd?: number | null }> }
export interface AssistantAsset { id: string; filename: string | null; kind?: string; content_type?: string | null; tags: string[]; description: string | null; metadata_version: number; sha256?: string | null; dhash64?: string | null; change_id?: string }
export interface AssetMetadataUpdate { expected_metadata_version: number; filename?: string | null; tags?: string[]; description?: string | null }
export interface DesignCheckResult { version_id: string; estimated: boolean; findings: { code: string; severity: string; slideId: string; elementId?: string; title: string; message: string; estimated: boolean; suggestedFix: PatchOperation[] }[] }
