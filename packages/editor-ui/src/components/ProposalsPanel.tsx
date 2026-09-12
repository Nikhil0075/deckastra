"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { PendingProposal } from "@deckastra/workspace-contracts";

/**
 * Changes waiting for a person (doc 02 §31.7, doc 03 §16).
 *
 * The Ask panel reviews only the proposal it just created. Anything proposed from
 * elsewhere — an external agent over MCP, a generation run's Critic — lands in the
 * store as `pending` and, before this panel, had nowhere to be seen: the server
 * refused to apply it without a human, and the editor offered the human no button.
 * "A human stays in control" requires the human to be able to find the decision.
 *
 * The panel never applies anything itself. Approval goes through the server,
 * which re-validates the proposal against the deck as it stands now, and the
 * editor adopts the document the server built.
 */

export interface ProposalsPanelProps {
  /** The version on screen, sent with an approval. See `approve` below. */
  currentVersionId: () => string;
  presentationId: string;
  /** Called when the document changed, so the editor can adopt the new state. */
  onApplied: (document: PresentationDocument, versionId: string) => boolean;
  /**
   * Drain the autosave queue. Resolves to whether it emptied.
   *
   * Approving replaces the document with one the server built; a queued local
   * edit authored against the superseded version could never be sent.
   */
  saveNow: () => Promise<boolean>;
  /** How often to look for new proposals while the window is visible. */
  pollMs?: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "working"; id: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function ProposalsPanel({
  presentationId,
  onApplied,
  saveNow,
  currentVersionId,
  pollMs = 10_000,
}: ProposalsPanelProps) {
  const client = useWorkspaceClient();
  const [proposals, setProposals] = useState<PendingProposal[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await client.agent.proposals(presentationId);
      if (mounted.current) setProposals(list.filter((proposal) => proposal.status === "pending"));
    } catch {
      /* A failed poll is retried on the next tick; the list stays as it was. */
    }
  }, [client, presentationId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Asked again on focus: coming back from the terminal where an agent was told
    // what to change is exactly when its proposal is expected to be here.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = pollMs > 0
      ? window.setInterval(() => {
          if (document.visibilityState !== "hidden") void refresh();
        }, pollMs)
      : undefined;
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  async function approve(proposal: PendingProposal) {
    setStatus({ kind: "working", id: proposal.id });
    if (!(await saveNow())) {
      setStatus({ kind: "error", message: "Your latest edits are not saved yet. Save them, then try again." });
      return;
    }
    try {
      // The version this panel is showing beside the proposal. The authority
      // refuses an approval against a deck that has moved since the proposal was
      // made, because that is a change nobody reviewed; saying what was on screen
      // is how a surface earns the yes.
      const applied = await client.agent.approve(
        presentationId,
        proposal.id,
        currentVersionId(),
      );
      if (!onApplied(applied.document as PresentationDocument, applied.version_id)) {
        throw new Error("The server applied the change, but newer local edits need reconciliation. Your local work has been retained.");
      }
      setProposals((list) => list.filter((item) => item.id !== proposal.id));
      setStatus({ kind: "done", message: `Applied: ${proposal.intent}` });
    } catch (error) {
      // Usually the proposal expired or no longer fits the deck; the server says
      // which. Re-read the list so a proposal that is gone stops being offered.
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not apply the change." });
      void refresh();
    }
  }

  async function reject(proposal: PendingProposal) {
    setStatus({ kind: "working", id: proposal.id });
    try {
      await client.agent.reject(presentationId, proposal.id, "Declined in the editor");
      setProposals((list) => list.filter((item) => item.id !== proposal.id));
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not decline the change." });
    }
  }

  if (proposals.length === 0 && status.kind !== "done" && status.kind !== "error") return null;

  return (
    <section aria-label="Pending changes" style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
      <div style={labelStyle}>PENDING CHANGES</div>

      {proposals.map((proposal) => {
        const busy = status.kind === "working";
        return (
          <div key={proposal.id} style={cardStyle}>
            <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.6, marginBottom: 6 }}>
              {(proposal.risk_tier ?? "unknown").toUpperCase()} RISK · {sourceLabel(proposal.agent_id)}
            </div>
            <p style={{ margin: "4px 0", fontSize: 13, fontWeight: 600 }}>{proposal.intent}</p>
            {proposal.reason ? (
              <p style={{ margin: "4px 0", fontSize: 12, opacity: 0.75 }}>{proposal.reason}</p>
            ) : null}
            <p style={{ margin: "4px 0", fontSize: 11, opacity: 0.55 }}>
              {proposal.operation_count} operation{proposal.operation_count === 1 ? "" : "s"}
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => void approve(proposal)} disabled={busy} style={primaryStyle}>
                {status.kind === "working" && status.id === proposal.id ? "Applying…" : "Approve"}
              </button>
              <button onClick={() => void reject(proposal)} disabled={busy} style={secondaryStyle}>
                Reject
              </button>
            </div>
          </div>
        );
      })}

      {status.kind === "error" ? (
        <p role="alert" style={{ ...noteStyle, color: "var(--warning)" }}>{status.message}</p>
      ) : null}
      {status.kind === "done" ? <p role="status" style={noteStyle}>{status.message}</p> : null}
    </section>
  );
}

/**
 * Who proposed it, in words. An external client's label is prefixed `mcp:` by the
 * server, so it can never pass itself off as the product's own agent.
 */
function sourceLabel(agentId: string | null): string {
  if (!agentId) return "from an agent";
  if (agentId.startsWith("mcp:")) return `from ${agentId.slice(4)} via MCP`;
  return `from ${agentId}`;
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.6,
  color: "var(--fg-subtle)",
  marginBottom: 8,
};

const cardStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderLeft: "3px solid var(--warning)",
  borderRadius: 8,
  background: "var(--surface)",
};

const primaryStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg)",
  border: "none",
  borderRadius: 8,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
};

const secondaryStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--fg-muted)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "6px 14px",
  fontSize: 13,
};

const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--fg-muted)",
  margin: "8px 0 0",
  lineHeight: 1.45,
};
