"use client";

/**
 * The agent endpoints, from the browser.
 *
 * Thin on purpose. Every decision that matters — whether a change is safe to
 * apply, what it is allowed to touch, whether a proposal has expired — is made
 * on the server, because a decision a client makes is a decision a client can
 * skip. This file sends a request and reads the answer.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface EditScopePayload {
  kind: "deck" | "slide" | "elements";
  slide_ids: string[];
  element_ids: string[];
  sources: string[];
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
  risk_tier: string;
  reasons: string[];
  changes: { element_id: string; change: string; reason: string }[];
  warnings: string[];
  refusal?: string | null;
  expires_at?: string | null;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
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

  return response.json() as Promise<T>;
}

export function agentEdit(
  presentationId: string,
  token: string,
  body: { instruction: string; scope: EditScopePayload },
): Promise<AgentEditResult> {
  return request(`/v1/presentations/${presentationId}/agent/edit`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function approveProposal(
  presentationId: string,
  proposalId: string,
  token: string,
): Promise<{ transaction_id: string; version_id: string; document: unknown }> {
  return request(`/v1/presentations/${presentationId}/proposals/${proposalId}/approve`, token, {
    method: "POST",
  });
}

export function rejectProposal(
  presentationId: string,
  proposalId: string,
  token: string,
  reason?: string,
): Promise<unknown> {
  return request(`/v1/presentations/${presentationId}/proposals/${proposalId}/reject`, token, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });
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
  expires_at: string | null;
  operation_count: number;
}

export function listProposals(
  presentationId: string,
  token: string,
): Promise<PendingProposal[]> {
  return request(`/v1/presentations/${presentationId}/proposals`, token);
}

/**
 * Undo one agent change, server-side.
 *
 * The revert endpoint, not the editor's local undo. An agent change was applied
 * by the server and its inverse was computed there against the pre-state — the
 * browser never had it. Reverting through the same path is what makes "undo only
 * that transaction" true rather than approximately true.
 */
export function revertTransaction(
  presentationId: string,
  transactionId: string,
  token: string,
): Promise<{ transaction_id: string; version_id: string; document: unknown }> {
  return request(
    `/v1/presentations/${presentationId}/transactions/${transactionId}/revert`,
    token,
    { method: "POST" },
  );
}
