/**
 * Repository grounding, from the client's side (Journey B).
 *
 * Two shapes carry a decision rather than only a type:
 *
 * - `StalenessState` has an `"unknown"` member, and it is not `"fresh"`. A source
 *   whose version cannot be read is exactly the case where a deck silently drifts.
 * - `SlideSource.url` is nullable. A local checkout has no public URL, and an
 *   offered link that 404s reads as a fabricated citation.
 */
export type StalenessState =
  | "fresh"
  | "stale"
  | "unknown"
  | "pending"
  | "indexing"
  | "failed"
  | "revoked";

export interface Staleness {
  state: StalenessState;
  message: string;
  indexed_sha?: string;
  head_sha?: string;
}

export interface RepositoryProfile {
  languages?: Record<string, number>;
  frameworks?: string[];
  entry_points?: string[];
  important_files?: { path: string; why: string; score: number }[];
}

export interface Repository {
  id: string;
  full_name: string;
  source: "github" | "local";
  description: string;
  default_branch: string;
  index_status: string;
  file_count: number;
  chunk_count: number;
  /** "bm25" when no embedder is configured. Surfaced, not hidden. */
  embedding_model: string;
  /** False means the index matches wording, not meaning. Worth telling the user. */
  embedding_semantic: boolean;
  last_indexed_at: string | null;
  profile: RepositoryProfile;
  warnings: string[];
  staleness: Staleness;
}

export interface RepositoryList {
  repositories: Repository[];
  github: { configured: boolean; install_url: string | null };
  local_allowed: boolean;
}

export interface SlideSource {
  id: string;
  targetId: string;
  sourceType: string;
  sourceReference: string;
  excerpt?: string;
  confidence?: number;
  agentId?: string;
  createdAt?: string;
  url: string | null;
}

export interface SlideSources {
  slide_id: string;
  sources: SlideSource[];
}
