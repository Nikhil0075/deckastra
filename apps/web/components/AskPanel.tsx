"use client";

import { useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import {
  agentEdit,
  approveProposal,
  rejectProposal,
  revertTransaction,
  type AgentEditResult,
} from "../lib/agent";

/**
 * Journey C, as a panel (doc 01 §7.3, doc 03 §26).
 *
 * Select something, say what you want, see what would change, decide.
 *
 * The shape of this component is the argument: it never applies anything itself.
 * It sends the selection and the instruction, and the *server* decides — from the
 * operations, not from anything this panel or the agent claims — whether the
 * change is small enough to apply or has to wait for a person. A low-risk change
 * comes back already applied; anything more comes back as a preview and two
 * buttons.
 *
 * Making a user approve a typo fix trains them to approve without reading, which
 * is worse than not asking. That is why the tiering happens server-side and this
 * panel simply renders whichever answer it gets.
 */

export interface AskPanelProps {
  presentationId: string;
  token: string;
  selectedIds: string[];
  slideId: string | undefined;
  /** Called when the document changed, so the editor can adopt the new state. */
  onApplied: (document: PresentationDocument, versionId: string) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "review"; result: AgentEditResult }
  | { kind: "done"; message: string; transactionId?: string }
  | { kind: "error"; message: string };

export function AskPanel({
  presentationId,
  token,
  selectedIds,
  slideId,
  onApplied,
}: AskPanelProps) {
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const disabled = selectedIds.length === 0 || instruction.trim() === "" || phase.kind === "working";

  async function ask() {
    setPhase({ kind: "working" });
    try {
      const result = await agentEdit(presentationId, token, {
        instruction,
        scope: {
          kind: "elements",
          slide_ids: slideId ? [slideId] : [],
          element_ids: selectedIds,
          sources: [],
        },
      });

      if (result.outcome === "none") {
        setPhase({ kind: "error", message: result.refusal ?? "No change was proposed." });
        return;
      }

      if (result.outcome === "applied" && result.document && result.version_id) {
        onApplied(result.document as PresentationDocument, result.version_id);
        setInstruction("");
        setPhase({
          kind: "done",
          message: `Applied. ${result.changes[0]?.reason ?? ""}`.trim(),
          transactionId: result.transaction_id ?? undefined,
        });
        return;
      }

      setPhase({ kind: "review", result });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "The request failed.",
      });
    }
  }

  async function accept(result: AgentEditResult) {
    if (!result.transaction_id) return;
    setPhase({ kind: "working" });
    try {
      const applied = await approveProposal(presentationId, result.transaction_id, token);
      onApplied(applied.document as PresentationDocument, applied.version_id);
      setInstruction("");
      setPhase({ kind: "done", message: "Applied.", transactionId: applied.transaction_id });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not apply the change.",
      });
    }
  }

  async function decline(result: AgentEditResult) {
    if (!result.transaction_id) return;
    try {
      // The reason is the point: a Critic that proposes the same rejected change
      // every run is a Critic people stop reading.
      await rejectProposal(presentationId, result.transaction_id, token, "Not what I wanted");
    } catch {
      /* Declining is not worth failing over. */
    }
    setPhase({ kind: "idle" });
  }

  async function undoIt(transactionId: string) {
    setPhase({ kind: "working" });
    try {
      const reverted = await revertTransaction(presentationId, transactionId, token);
      onApplied(reverted.document as PresentationDocument, reverted.version_id);
      setPhase({ kind: "done", message: "Undone." });
    } catch (error) {
      // The usual reason is that a later edit moved what the inverse depends on,
      // and the server says so in the message. Refusing is the only safe answer;
      // the alternative is silently editing the wrong thing.
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not undo the change.",
      });
    }
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
      <div style={labelStyle}>ASK</div>

      <textarea
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is a newline. Stopped from reaching the
          // canvas, where every key is a shortcut.
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey && !disabled) {
            event.preventDefault();
            void ask();
          }
        }}
        rows={2}
        placeholder={
          selectedIds.length === 0
            ? "Select something first"
            : `Change the ${selectedIds.length} selected object(s)…`
        }
        style={inputStyle}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button onClick={() => void ask()} disabled={disabled} style={primaryStyle}>
          {phase.kind === "working" ? "Thinking…" : "Ask"}
        </button>
        <span style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
          {selectedIds.length} selected
        </span>
      </div>

      {phase.kind === "error" ? (
        <p style={{ ...noteStyle, color: "var(--warning)" }}>{phase.message}</p>
      ) : null}

      {phase.kind === "done" ? (
        <>
          <p style={noteStyle}>{phase.message}</p>
          {phase.transactionId ? (
            <button onClick={() => void undoIt(phase.transactionId!)} style={{ ...secondaryStyle, marginTop: 8 }}>
              Undo this change
            </button>
          ) : null}
        </>
      ) : null}

      {phase.kind === "review" ? (
        <div style={reviewStyle}>
          <div style={{ fontSize: 11, letterSpacing: 1.2, opacity: 0.6, marginBottom: 6 }}>
            {phase.result.risk_tier.toUpperCase()} RISK — NEEDS YOUR APPROVAL
          </div>

          {phase.result.changes.map((change) => (
            <p key={change.element_id} style={{ margin: "4px 0", fontSize: 13 }}>
              {change.reason}
            </p>
          ))}

          {phase.result.reasons.map((reason) => (
            <p key={reason} style={{ margin: "4px 0", fontSize: 12, opacity: 0.7 }}>
              {reason}
            </p>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={() => void accept(phase.result)} style={primaryStyle}>
              Apply
            </button>
            <button onClick={() => void decline(phase.result)} style={secondaryStyle}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === "review" || phase.kind === "done" ? (
        <p style={{ ...noteStyle, opacity: 0.55 }}>
          It is one transaction in the deck&apos;s history — undoing it leaves every
          other change in place.
        </p>
      ) : null}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.6,
  color: "var(--fg-subtle)",
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  resize: "vertical",
  color: "var(--fg)",
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

const reviewStyle: React.CSSProperties = {
  marginTop: 10,
  padding: 10,
  border: "1px solid var(--border)",
  borderLeft: "3px solid var(--warning)",
  borderRadius: 8,
  background: "var(--surface)",
};
