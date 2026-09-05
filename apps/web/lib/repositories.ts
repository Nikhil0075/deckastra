/**
 * The repository HTTP surface, from the browser (Journey B).
 *
 * Kept apart from the components so the shapes are declared once. Two of them
 * matter beyond typing:
 *
 * - `Staleness.state` has an `"unknown"` member, and it is not `"fresh"`. A
 *   source whose version cannot be read is exactly the case where a deck
 *   silently drifts, so the UI must be able to say so.
 * - `SlideSource.url` is nullable. A local checkout has no public URL, and an
 *   offered link that 404s reads as a fabricated citation.
 */

import { getSession } from "./session";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = await getSession();

  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : (detail?.message ?? `Request failed (${response.status})`),
    );
  }

  return (await response.json()) as T;
}

export function listRepositories(): Promise<RepositoryList> {
  return request<RepositoryList>("/v1/repositories");
}

export function connectLocalRepository(path: string, label?: string): Promise<Repository> {
  return request<Repository>("/v1/repositories/local", {
    method: "POST",
    body: JSON.stringify({ path, label: label || null }),
  });
}

export function indexRepository(id: string): Promise<Repository & { index: unknown }> {
  return request(`/v1/repositories/${id}/index`, { method: "POST" });
}

export function disconnectRepository(id: string): Promise<{ status: string }> {
  return request(`/v1/repositories/${id}`, { method: "DELETE" });
}

export function slideSources(
  presentationId: string,
  slideId: string,
): Promise<{ slide_id: string; sources: SlideSource[] }> {
  return request(`/v1/presentations/${presentationId}/slides/${slideId}/sources`);
}

/** Colour and wording for a staleness state, in one place so they cannot diverge. */
export function stalenessTone(state: StalenessState): { colour: string; label: string } {
  switch (state) {
    case "fresh":
      return { colour: "var(--accent)", label: "Up to date" };
    case "stale":
      return { colour: "var(--warning)", label: "Out of date" };
    case "indexing":
    case "pending":
      return { colour: "var(--fg-subtle)", label: "Indexing" };
    case "failed":
      return { colour: "var(--danger)", label: "Failed" };
    case "revoked":
      return { colour: "var(--danger)", label: "Access withdrawn" };
    default:
      // Deliberately not styled as success. "We cannot tell" is closer to stale
      // than to fresh, and showing it as fine is how a deck drifts unnoticed.
      return { colour: "var(--fg-subtle)", label: "Unknown" };
  }
}
