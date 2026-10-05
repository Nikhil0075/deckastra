"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { PendingProposal, ProposalDetail } from "@deckastra/workspace-contracts";

import { useAssetUrls } from "../lib/asset-urls";
import { useBrowserMeasurer } from "../lib/measurer";
import { groundingLabel, previewProposal, proposalSource } from "../lib/proposal-preview";
import { Button, IconButton, StatusChip } from "../ui";
import { FinalFrameSlide } from "./FinalFrameSlide";

/**
 * Changes waiting for a person (doc 02 §31.7, doc 03 §16; Figma frame
 * "previewing a proposal as an image").
 *
 * Anything proposed from elsewhere — an external agent over MCP, a generation
 * run's Critic — lands in the store as `pending`, and "a human stays in control"
 * requires the human to be able to find the decision. Each card shows the change
 * as Before and After pictures, drawn by the editor's own renderer from the deck
 * on screen with the proposal's operations applied to a copy.
 *
 * The panel never applies anything itself. Approval goes through the server,
 * which re-validates the proposal against the deck as it stands now, and the
 * editor adopts the document the server built.
 */

export interface ProposalsPanelProps {
  /** The version on screen, sent with an approval. See `approve` below. */
  currentVersionId: () => string;
  presentationId: string;
  /** The deck on screen: what Before shows, and what After is applied to. */
  document: PresentationDocument;
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
  /** How many are waiting, for the section heading. */
  onCount?: (count: number) => void;
  /** The language on screen (integration plan 01), so a picture matches the canvas. */
  locale?: string | null;
  /** Bumped by a caller that just made a proposal, so the list looks now rather than at the next tick. */
  refreshToken?: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "working"; id: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function ProposalsPanel({
  presentationId,
  document,
  onApplied,
  saveNow,
  currentVersionId,
  pollMs = 10_000,
  onCount,
  locale = null,
  refreshToken = 0,
}: ProposalsPanelProps) {
  const client = useWorkspaceClient();
  const [proposals, setProposals] = useState<PendingProposal[] | null>(null);
  // The last read failed. Kept apart from `proposals`, so a list already on
  // screen stays while a later poll fails, and a first read that failed says
  // so rather than "looking" for ever (roadmap 08 rule 5).
  const [readFailed, setReadFailed] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
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
    onCount?.(proposals?.length ?? 0);
  }, [proposals, onCount]);

  useEffect(() => {
    if (refreshToken) void refresh();
  }, [refreshToken, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Asked again on focus: coming back from the terminal where an agent was told
    // what to change is exactly when its proposal is expected to be here.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = pollMs > 0
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
      const applied = await client.agent.approve(presentationId, proposal.id, currentVersionId());
      if (!onApplied(applied.document as PresentationDocument, applied.version_id)) {
        throw new Error("The server applied the change, but newer local edits need reconciliation. Your local work has been retained.");
      }
      setProposals((list) => (list ?? []).filter((item) => item.id !== proposal.id));
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
      setProposals((list) => (list ?? []).filter((item) => item.id !== proposal.id));
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not decline the change." });
    }
  }

  return (
    <div className="dk-proposals" aria-label="Pending changes">
      {proposals === null && !readFailed ? <p className="dk-muted">Looking for pending changes…</p> : null}
      {proposals === null && readFailed ? (
        <p className="dk-muted" role="status" data-testid="proposals-unread">
          Pending changes could not be checked just now. Trying again shortly.
        </p>
      ) : null}
      {proposals?.length === 0 && status.kind !== "done" ? (
        <p className="dk-muted">Nothing is waiting for you. Changes an agent proposes appear here.</p>
      ) : null}
      {(proposals ?? []).map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          presentationId={presentationId}
          document={document}
          locale={locale}
          currentVersionId={currentVersionId}
          busy={status.kind === "working"}
          applying={status.kind === "working" && status.id === proposal.id}
          onApply={() => void approve(proposal)}
          onReject={() => void reject(proposal)}
        />
      ))}
      {status.kind === "error" ? (
        <p role="alert" className="dk-proposals__error">
          {status.message}
        </p>
      ) : null}
      {status.kind === "done" ? (
        <p role="status" className="dk-muted">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

/** Gap between the two pictures and each frame's border, in px (see shell.css). */
const PAIR_GAP = 8;
const FRAME_BORDER = 2;

/**
 * The width each picture gets: half the card, measured. A fixed width either
 * overflows a narrow panel or wastes a wide one, and the renderer scales a slide
 * from the width it is handed, so stretching the box with CSS would leave the
 * slide the wrong size.
 */
function usePairWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(0, Math.floor((node.clientWidth - PAIR_GAP) / 2) - FRAME_BORDER));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });
  return [ref, width] as const;
}

function ProposalCard({
  proposal,
  presentationId,
  document,
  locale,
  currentVersionId,
  busy,
  applying,
  onApply,
  onReject,
}: {
  proposal: PendingProposal;
  presentationId: string;
  document: PresentationDocument;
  locale: string | null;
  currentVersionId: () => string;
  busy: boolean;
  applying: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  const client = useWorkspaceClient();
  const measurer = useBrowserMeasurer();
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [pairRef, thumb] = usePairWidth();

  useEffect(() => {
    let cancelled = false;
    client.agent
      .proposal(presentationId, proposal.id)
      .then((body) => {
        if (!cancelled) setDetail(body);
      })
      .catch((error: unknown) => {
        // The card still works without pictures: the words and both buttons.
        if (!cancelled) setDetailError(error instanceof Error ? error.message : "Could not load this change.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, presentationId, proposal.id]);

  const preview = useMemo(
    () => (detail ? previewProposal(document, detail.operations, locale) : null),
    [detail, document, locale],
  );
  // Drawn in the language the change is about: a translation shows its words.
  const beforeScene = useMemo(() => buildDocumentScene(preview?.shownBefore ?? document, { measurer }), [preview, document, measurer]);
  const afterScene = useMemo(
    () => (preview?.shownAfter ? buildDocumentScene(preview.shownAfter, { measurer }) : null),
    [preview, measurer],
  );
  const resolveBefore = useAssetUrls(document);
  const resolveAfter = useAssetUrls(preview?.after ?? null);

  // The slides worth showing: what the change alters, then what it removes. A
  // deck-wide change with no slide of its own (a theme) shows the first slide,
  // where the difference is visible.
  const shown = preview
    ? [...preview.changedSlideIds, ...preview.removedSlideIds].length
      ? [...preview.changedSlideIds, ...preview.removedSlideIds]
      : preview.deckWide && document.slides[0]
        ? [document.slides[0].id]
        : []
    : [];
  const slideId = shown[Math.min(at, Math.max(0, shown.length - 1))];
  const before = slideId ? beforeScene.slides.find((slide) => slide.slideId === slideId) : undefined;
  const after = slideId ? afterScene?.slides.find((slide) => slide.slideId === slideId) : undefined;
  // Numbered as the deck will be after the change; a removed slide keeps the
  // number it has now.
  const afterIndex = slideId ? (preview?.after?.slides.findIndex((slide) => slide.id === slideId) ?? -1) : -1;
  const position = afterIndex >= 0 ? afterIndex + 1 : document.slides.findIndex((slide) => slide.id === slideId) + 1;
  const rebased = Boolean(detail?.base_version_id && detail.base_version_id !== currentVersionId());

  return (
    <article className="dk-proposal" data-testid="proposal-card" data-proposal-id={proposal.id}>
      <header className="dk-proposal__head">
        <StatusChip tone="waiting">Pending</StatusChip>
        <span className="dk-proposal__who">
          {(proposal.risk_tier ?? "unknown").replace(/^./, (letter) => letter.toUpperCase())} risk ·{" "}
          {proposalSource(proposal.agent_id)}
        </span>
      </header>
      <p className="dk-proposal__intent">{proposal.intent}</p>
      {proposal.reason ? <p className="dk-proposal__reason">{proposal.reason}</p> : null}

      {preview?.error ? (
        <p className="dk-proposal__warning" role="status">
          This change no longer applies to the deck as it is now. Rejecting it clears it. ({preview.error})
        </p>
      ) : shown.length ? (
        <>
          <div className="dk-proposal__pair" ref={pairRef}>
            <figure className="dk-proposal__figure" data-testid="proposal-before">
              <figcaption>Before</figcaption>
              {before ? (
                <span className="dk-proposal__frame">
                  {thumb > 0 ? <FinalFrameSlide scene={before} width={thumb} resolveAssetUrl={resolveBefore} /> : null}
                </span>
              ) : (
                <span className="dk-proposal__gap">New slide</span>
              )}
            </figure>
            <figure className="dk-proposal__figure" data-testid="proposal-after">
              <figcaption>After</figcaption>
              {after ? (
                <span className="dk-proposal__frame">
                  {thumb > 0 ? <FinalFrameSlide scene={after} width={thumb} resolveAssetUrl={resolveAfter} /> : null}
                </span>
              ) : (
                <span className="dk-proposal__gap">Removed</span>
              )}
            </figure>
          </div>
          <div className="dk-proposal__meta">
            <span>
              Slide {position}
              {shown.length > 1 ? ` · ${at + 1} of ${shown.length} changed` : ""}
              {preview?.deckWide ? " · deck settings change too" : ""}
            </span>
            {shown.length > 1 ? (
              <span className="dk-proposal__step">
                <IconButton
                  icon="chevronLeft"
                  label="Previous changed slide"
                  size="sm"
                  variant="secondary"
                  disabled={at === 0}
                  onClick={() => setAt((index) => Math.max(0, index - 1))}
                />
                <IconButton
                  icon="chevronRight"
                  label="Next changed slide"
                  size="sm"
                  variant="secondary"
                  disabled={at >= shown.length - 1}
                  onClick={() => setAt((index) => Math.min(shown.length - 1, index + 1))}
                />
              </span>
            ) : null}
          </div>
        </>
      ) : detail ? (
        <p className="dk-muted">This change does not alter anything on the slides.</p>
      ) : detailError ? (
        <p className="dk-muted">{detailError}</p>
      ) : (
        <p className="dk-muted">Drawing the change…</p>
      )}

      {preview?.groundedIn.length ? (
        <p className="dk-proposal__grounded">Grounded in {groundingLabel(preview.groundedIn)}</p>
      ) : null}
      {rebased ? (
        <p className="dk-proposal__reason">
          Written against an earlier version. The pictures show it applied to the deck as it is now.
        </p>
      ) : null}

      <div className="dk-proposal__actions">
        <Button size="sm" variant="secondary" disabled={busy} onClick={onReject} data-testid="proposal-reject">
          Reject
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={onApply} data-testid="proposal-apply">
          {applying ? "Applying…" : "Apply"}
        </Button>
      </div>
    </article>
  );
}
