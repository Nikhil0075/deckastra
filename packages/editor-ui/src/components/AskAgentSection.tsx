import { useCallback, useEffect, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AgentRequest, AgentRequestKind } from "@deckastra/workspace-contracts";

import type { EditorApi } from "../lib/useEditor";
import { Button, Select, StatusChip } from "../ui";

/**
 * Ask agent, for the deck as a whole (2026-10-17, release E2E step 9).
 *
 * Motion mode's Ask agent is about one object's movement. This one asks the
 * connected agent anything about the whole deck, this slide, or what is
 * selected — including a review that changes nothing, which the agent answers
 * in words. Requests and their findings are listed here and in Agent Tasks; a
 * reply that proposes changes waits in Review as before.
 */

type Scope = "deck" | "slide" | "selection";

const KINDS: { value: AgentRequestKind; label: string }[] = [
  { value: "review", label: "Review only" },
  { value: "content", label: "Words" },
  { value: "layout", label: "Layout" },
  { value: "style", label: "Style" },
  { value: "image", label: "Pictures" },
  { value: "other", label: "Something else" },
];

export function AskAgentSection({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const client = useWorkspaceClient();
  const selected = editor.selection?.selectedIds ?? [];
  const [scope, setScope] = useState<Scope>("deck");
  const [kind, setKind] = useState<AgentRequestKind>("review");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requests, setRequests] = useState<AgentRequest[]>([]);

  const load = useCallback(async () => {
    try {
      const listed = await client.agent.requests(presentationId, undefined, { fresh: true });
      setRequests([...listed].reverse().slice(0, 6));
    } catch {
      /* The list is a convenience; Agent Tasks keeps the full record. */
    }
  }, [client, presentationId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const effectiveScope: Scope = scope === "selection" && !selected.length ? "slide" : scope;

  const send = async () => {
    if (!message.trim()) return;
    if (!(await editor.saveNow())) {
      setNotice("Save your edits, then ask again.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const slide = editor.sourceDocument.slides[editor.slideIndex];
    const target =
      effectiveScope === "selection"
        ? { slide_ids: [], element_ids: selected }
        : effectiveScope === "slide" && slide
          ? { slide_ids: [slide.id], element_ids: [] }
          : kind === "review"
            ? { slide_ids: [], element_ids: [] }
            : { slide_ids: editor.sourceDocument.slides.slice(0, 50).map((one) => one.id), element_ids: [] };
    try {
      await client.agent.createRequest(presentationId, {
        target,
        kind,
        message: message.trim(),
        based_on_version_id: editor.currentVersionId(),
      });
      setMessage("");
      setNotice(
        kind === "review"
          ? "Sent. Your agent's findings will appear here and in Agent Tasks; nothing changes in the deck."
          : "Sent. Changes your agent proposes will wait in Review.",
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That request could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dk-askagent" data-testid="ask-agent-deck">
      <div className="dk-grid2">
        <Select
          label="About"
          value={effectiveScope}
          onChange={(value) => setScope(value as Scope)}
          options={[
            { value: "deck", label: "The whole deck" },
            { value: "slide", label: `Slide ${editor.slideIndex + 1}` },
            { value: "selection", label: selected.length ? `${selected.length} selected` : "Selection (none)", disabled: !selected.length },
          ]}
          data-testid="ask-agent-scope"
        />
        <Select label="Ask for" value={kind} onChange={(value) => setKind(value as AgentRequestKind)} options={KINDS} data-testid="ask-agent-kind" />
      </div>
      <label className="dk-field">
        <span className="dk-label">Message</span>
        <textarea
          className="dk-input"
          rows={3}
          maxLength={2000}
          value={message}
          placeholder={kind === "review" ? "Review for clarity, accessibility, repetition and weak evidence." : "What should your agent change?"}
          onChange={(event) => setMessage(event.target.value)}
          data-testid="ask-agent-deck-message"
        />
      </label>
      <Button size="sm" variant="primary" disabled={busy || !message.trim()} onClick={() => void send()} data-testid="ask-agent-deck-send">
        {busy ? "Sending…" : "Ask agent"}
      </Button>
      {notice ? <p className="dk-field__hint" role="status">{notice}</p> : null}

      {requests.length ? (
        <ul className="dk-askagent__list" aria-label="Recent requests">
          {requests.map((request) => (
            <li key={request.id} className="dk-askagent__item" data-testid="ask-agent-request" data-request-status={request.status}>
              <span className="dk-askagent__head">
                <StatusChip tone={request.status === "open" ? "waiting" : request.status === "answered" ? "action" : "neutral"}>
                  {request.status === "open" ? "Waiting for agent" : request.status === "answered" ? (request.findings && !request.proposal_ids.length ? "Findings ready" : "Answered") : "Closed"}
                </StatusChip>
              </span>
              <span className="dk-askagent__message">{request.message}</span>
              {request.findings ? (
                <div className="dk-askagent__findings" data-testid="ask-agent-findings">
                  {request.findings}
                </div>
              ) : null}
              {request.proposal_ids.length ? (
                <span className="dk-field__hint">
                  {request.proposal_ids.length} proposal{request.proposal_ids.length === 1 ? "" : "s"} waiting in Review.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
