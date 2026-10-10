"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { PendingProposal } from "@deckastra/workspace-contracts";

/**
 * The pending changes for a deck, and the two decisions a person can make about
 * one (doc 02 §31.7). Shared by the Assistant's "Waiting for you" list and the
 * Review view (UI audit 2026-10-10, unit 4), so there is one implementation of
 * the rules that make an approval safe, not two that drift:
 *
 * - **Save first.** Approving replaces the document with one the server built;
 *   a queued local edit authored against the superseded version could never be
 *   sent afterwards.
 * - **Say what was on screen.** The authority refuses an approval against a deck
 *   that has moved since the proposal was made, because that is a change nobody
 *   reviewed; sending the version shown is how a surface earns the yes.
 * - **Nothing applies here.** The editor adopts the document the server built.
 */

export interface ProposalsInput {
  presentationId: string;
  /** The version on screen, sent with an approval. */
  currentVersionId: () => string;
  /** Adopt the document the server built. False: local work needs reconciling first. */
  onApplied: (document: PresentationDocument, versionId: string) => boolean;
  /** Drain the autosave queue; resolves to whether it emptied. */
  saveNow: () => Promise<boolean>;
  /** How often to look while the window is visible. 0: only on focus and refresh. */
  pollMs?: number;
  /** Bumped by a caller that just made a proposal, so the list looks now. */
  refreshToken?: number;
}

export type ProposalStatus =
  | { kind: "idle" }
  | { kind: "working"; id: string }
  | { kind: "done"; message: string; appliedId?: string }
  | { kind: "error"; message: string };

export interface Proposals {
  /** Pending proposals, or null before the first answer. */
  proposals: PendingProposal[] | null;
  /** The last read failed; a list already shown is kept. */
  readFailed: boolean;
  status: ProposalStatus;
  refresh: () => Promise<void>;
  /**
   * Resolves to the transaction the approval committed, or null if nothing was
   * applied. That transaction, not the proposal's own id, is what an Undo
   * reverts: approving records a new change, and reverting the proposal's
   * pending record finds that change "later" and refuses (found in the app).
   */
  approve: (proposal: PendingProposal) => Promise<string | null>;
  reject: (proposal: PendingProposal) => Promise<boolean>;
}

export function useProposals({
  presentationId,
  currentVersionId,
  onApplied,
  saveNow,
  pollMs = 10_000,
  refreshToken = 0,
}: ProposalsInput): Proposals {
  const client = useWorkspaceClient();
  const [proposals, setProposals] = useState<PendingProposal[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [status, setStatus] = useState<ProposalStatus>({ kind: "idle" });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await client.agent.proposals(presentationId);
      if (mounted.current) {
        setProposals(list.filter((proposal) => proposal.status === "pending"));
        setReadFailed(false);
      }
    } catch {
      // Retried on the next tick and on focus; the list stays as it was.
      if (mounted.current) setReadFailed(true);
    }
  }, [client, presentationId]);

  useEffect(() => {
    if (refreshToken) void refresh();
  }, [refreshToken, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Asked again on focus: coming back from the terminal where an agent was
    // told what to change is exactly when its proposal is expected to be here.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer =
      pollMs > 0
        ? window.setInterval(() => {
            if (globalThis.document?.visibilityState !== "hidden") void refresh();
          }, pollMs)
        : undefined;
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  const approve = useCallback(
    async (proposal: PendingProposal) => {
      setStatus({ kind: "working", id: proposal.id });
      if (!(await saveNow())) {
        setStatus({ kind: "error", message: "Your latest edits are not saved yet. Save them, then try again." });
        return null;
      }
      try {
        const applied = await client.agent.approve(presentationId, proposal.id, currentVersionId());
        if (!onApplied(applied.document as PresentationDocument, applied.version_id)) {
          throw new Error("The server applied the change, but newer local edits need reconciliation. Your local work has been retained.");
        }
        setProposals((list) => (list ?? []).filter((item) => item.id !== proposal.id));
        setStatus({ kind: "done", message: `Applied: ${proposal.intent}`, appliedId: applied.transaction_id });
        return applied.transaction_id;
      } catch (error) {
        // Usually the proposal expired or no longer fits the deck; the server
        // says which. Re-read so a proposal that is gone stops being offered.
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not apply the change." });
        void refresh();
        return null;
      }
    },
    [client, currentVersionId, onApplied, presentationId, refresh, saveNow],
  );

  const reject = useCallback(
    async (proposal: PendingProposal) => {
      setStatus({ kind: "working", id: proposal.id });
      try {
        await client.agent.reject(presentationId, proposal.id, "Declined in the editor");
        setProposals((list) => (list ?? []).filter((item) => item.id !== proposal.id));
        setStatus({ kind: "idle" });
        return true;
      } catch (error) {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not decline the change." });
        return false;
      }
    },
    [client, presentationId],
  );

  return { proposals, readFailed, status, refresh, approve, reject };
}
