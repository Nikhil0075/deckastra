import type { ComposedDeckResult, StoryPlanSlide } from "./presets";
import type { StyleOptionInput } from "./agent";

export type DraftBlockRole = "headline" | "subtitle" | "body" | "bullet" | "metric" | "quote" | "chart" | "diagram" | "timeline" | "image";

export interface DraftBlock {
  role: DraftBlockRole;
  text?: string;
  data?: unknown;
  image?: { subject: string; style_source: "deck" | "prompt" };
}

export interface DraftCard {
  id: string;
  /** A StoryPlan layout or reviewed pattern key. Never geometry. */
  layout: StoryPlanSlide["layout"] | string;
  blocks: DraftBlock[];
  alternatives?: DraftBlock[][];
  motion?: { pacing: string; emphasis_roles: string[] };
  notes?: string;
  locked?: boolean;
  /** The linked deck's slide this card came from. Kept through edits; the server decides what it means. */
  source_slide_id?: string;
  source_fingerprint?: string;
}

export interface DraftBody {
  brief?: string;
  /** An A1 option id, or an inline validated option. */
  style?: string | StyleOptionInput;
  cards: DraftCard[];
}

export interface DraftBoard {
  id: string;
  project_id: string;
  presentation_id: string | null;
  title: string;
  body: DraftBody;
  revision: number;
  built_version_id: string | null;
  built_revision: number | null;
  changed_since_build: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  density_warnings: Record<string, string[]>;
}

export type DraftOperation =
  | { op: "add"; card: DraftCard; index?: number }
  | { op: "remove"; card_id: string }
  | { op: "move"; card_id: string; index: number }
  | { op: "set_blocks"; card_id: string; blocks: DraftBlock[] }
  | { op: "add_alternative"; card_id: string; alternative: DraftBlock[] }
  | { op: "choose_alternative"; card_id: string; alternative_index: number }
  | { op: "set_locked"; card_id: string; locked: boolean };

export interface DraftBuildResult extends Partial<ComposedDeckResult> {
  kind: "deck" | "proposal";
  presentation_id: string;
  transaction_id?: string;
  status?: string;
  warnings: string[];
}

export interface DraftAgentRequest {
  id: string;
  draft_id: string;
  presentation_id: string | null;
  target: { card_ids: string[]; block_ids: string[] };
  kind: "motion" | "style" | "content" | "image" | "layout" | "other";
  message: string;
  based_on_draft_revision: number;
  status: "open" | "answered" | "closed";
  created_by: string;
  created_at: string;
  resolved_target: { cards: Array<{ id: string; layout: string; blocks: DraftBlock[]; locked: boolean }>; missing_card_ids: string[] };
}
