"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { PendingProposal, ProposalDetail } from "@deckastra/workspace-contracts";

import { useAssetUrls } from "../lib/asset-urls";
import { useBrowserMeasurer } from "../lib/measurer";
import { groundingLabel, previewProposal, proposalSource } from "../lib/proposal-preview";
import { useProposals } from "../lib/use-proposals";
import type { EditorApi } from "../lib/useEditor";
import { Button, IconButton, Segmented, StatusChip } from "../ui";
import { cx } from "../ui/cx";
import { FinalFrameSlide } from "./FinalFrameSlide";

/**
 * Reviewing what an agent proposed, with the slide as the largest thing on
 * screen (UI audit 2026-10-10, unit 4).
 *
 * The Assistant's "Waiting for you" list draws Before and After in a column a
 * few hundred pixels wide, which is fine for a typo and no way to read a
 * restyle of six slides. Here the centre is the comparison, side by side or as
 * a wipe; the left is the slides the change touches, to step through one at a
 * time; the right is the queue, with Approve, Reject, and Undo for what was
 * approved this session.
 *
 * No chat, deliberately: the product's agents bring their own intelligence over
 * MCP, and what a person needs here is to see the change and decide. Approval
 * stays whole-proposal, because a proposal is one transaction the server
 * re-validates as a whole; taking half of one would be a change nobody proposed.
 */

export interface ReviewWorkspaceProps {
  editor: EditorApi;
  presentationId: string;
  /** Open on this proposal; otherwise the first waiting. */
  initialProposalId?: string;
  onClose: () => void;
  /** How many are waiting, for the bar's button. */
  onCount?: (count: number) => void;
}

type Compare = "side" | "wipe";

interface Applied {
  /** The proposal, for the row's identity. */
  id: string;
  /** The transaction the approval committed: what Undo reverts. */
  transactionId: string;
  intent: string;
  undone?: boolean;
}

export function ReviewWorkspace({ editor, presentationId, initialProposalId, onClose, onCount }: ReviewWorkspaceProps) {
  const { proposals, readFailed, status, approve, reject } = useProposals({
    presentationId,
    currentVersionId: editor.currentVersionId,
    onApplied: editor.adoptDocument,
    saveNow: editor.saveNow,
  });
  const [selectedId, setSelectedId] = useState<string | undefined>(initialProposalId);
  const [applied, setApplied] = useState<Applied[]>([]);
  const [undoMessage, setUndoMessage] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  useEffect(() => {
    onCount?.(proposals?.length ?? 0);
  }, [proposals, onCount]);

  // Keep a selection while there is anything to select: the one asked for, or
  // the first waiting once it has gone (approved, rejected, expired).
  const selected: PendingProposal | undefined =
    proposals?.find((proposal) => proposal.id === selectedId) ?? proposals?.[0];

  // Escape returns to editing, as it leaves every other overlay.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onApprove = async (proposal: PendingProposal) => {
    const transactionId = await approve(proposal);
    if (transactionId) {
      setApplied((list) => [{ id: proposal.id, transactionId, intent: proposal.intent }, ...list]);
      setUndoMessage(null);
    }
  };

  const onUndo = async (change: Applied) => {
    setUndoing(change.id);
    const result = await editor.revertChange(change.transactionId);
    setUndoing(null);
    if (result.ok) {
      setApplied((list) => list.map((item) => (item.id === change.id ? { ...item, undone: true } : item)));
      setUndoMessage(`Undone: ${change.intent}`);
    } else {
      setUndoMessage(result.message ?? "That change could not be undone.");
    }
  };

  const busy = status.kind === "working" || undoing !== null;

  return (
    <div className="dk-review" data-testid="review-workspace" data-region="review" role="region" aria-label="Review proposed changes">
      {selected ? (
        <ProposalReview
          key={selected.id}
          proposal={selected}
          editor={editor}
          presentationId={presentationId}
          onClose={onClose}
        />
      ) : (
        <div className="dk-review__empty">
          <div className="dk-review__toolbar">
            <span className="dk-label">Review</span>
            <Button size="sm" variant="secondary" icon="close" onClick={onClose} data-testid="close-review">
              Back to editing
            </Button>
          </div>
          <p>
            {proposals === null
              ? readFailed
                ? "Pending changes could not be checked just now. Trying again shortly."
                : "Looking for pending changes…"
              : "Nothing is waiting for you. Changes an agent proposes appear here."}
          </p>
        </div>
      )}

      <aside className="dk-review__queue" aria-label="Waiting for you">
        <h2 className="dk-review__title">
          Waiting for you{proposals ? ` (${proposals.length})` : ""}
        </h2>
        <ul className="dk-review__list">
          {(proposals ?? []).map((proposal) => {
            const current = proposal.id === selected?.id;
            return (
              <li key={proposal.id}>
                <button
                  type="button"
                  className={cx("dk-review__item", current && "dk-review__item--current")}
                  aria-pressed={current}
                  onClick={() => setSelectedId(proposal.id)}
                  data-testid="review-proposal"
                  data-proposal-id={proposal.id}
                >
                  <span className="dk-review__item-head">
                    <StatusChip tone="waiting">Pending</StatusChip>
                    <span>
                      {(proposal.risk_tier ?? "unknown").replace(/^./, (letter) => letter.toUpperCase())} risk
                    </span>
                  </span>
                  <span className="dk-review__intent">{proposal.intent}</span>
                  <span className="dk-muted">{proposalSource(proposal.agent_id)}</span>
                </button>
                {current ? (
                  <div className="dk-review__decide">
                    {proposal.reason ? <p className="dk-review__reason">{proposal.reason}</p> : null}
                    <div className="dk-review__actions">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void reject(proposal)} data-testid="review-reject">
                        Reject
                      </Button>
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => void onApprove(proposal)} data-testid="review-approve">
                        {status.kind === "working" && status.id === proposal.id ? "Approving…" : "Approve"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {status.kind === "error" ? (
          <p role="alert" className="dk-proposals__error">
            {status.message}
          </p>
        ) : null}

        {applied.length ? (
          <section className="dk-review__applied" aria-label="Applied this session">
            <h3 className="dk-label">Applied this session</h3>
            <ul className="dk-review__list">
              {applied.map((change) => (
                <li key={change.id} className="dk-review__applied-row" data-testid="review-applied" data-proposal-id={change.id}>
                  <span>{change.intent}</span>
                  {change.undone ? (
                    <span className="dk-muted">Undone</span>
                  ) : (
                    <Button size="sm" variant="ghost" icon="undo" disabled={busy} onClick={() => void onUndo(change)} data-testid="review-undo">
                      {undoing === change.id ? "Undoing…" : "Undo"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {undoMessage ? (
          <p role="status" className="dk-muted">
            {undoMessage}
          </p>
        ) : null}
      </aside>
    </div>
  );
}

/** Gap between the two pictures, each picture's 1px frame, and room for its caption. */
const PAIR_GAP = 24;
const FRAME = 2;
const CAPTION = 28;

/** The comparison stage's own size, measured, so the slides are drawn as big as it allows. */
function useStageSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function ProposalReview({
  proposal,
  editor,
  presentationId,
  onClose,
}: {
  proposal: PendingProposal;
  editor: EditorApi;
  presentationId: string;
  onClose: () => void;
}) {
  const client = useWorkspaceClient();
  const measurer = useBrowserMeasurer();
  const document = editor.sourceDocument;
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [compare, setCompare] = useState<Compare>("side");
  const [wipe, setWipe] = useState(50);
  const [stageRef, stage] = useStageSize();

  useEffect(() => {
    let cancelled = false;
    client.agent
      .proposal(presentationId, proposal.id)
      .then((body) => {
        if (!cancelled) setDetail(body);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailError(error instanceof Error ? error.message : "Could not load this change.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, presentationId, proposal.id]);

  const preview = useMemo(
    () => (detail ? previewProposal(document, detail.operations, editor.locale ?? null) : null),
    [detail, document, editor.locale],
  );
  const beforeScene = useMemo(() => buildDocumentScene(preview?.shownBefore ?? document, { measurer }), [preview, document, measurer]);
  const afterScene = useMemo(
    () => (preview?.shownAfter ? buildDocumentScene(preview.shownAfter, { measurer }) : null),
    [preview, measurer],
  );
  const resolveBefore = useAssetUrls(document);
  const resolveAfter = useAssetUrls(preview?.after ?? null);

  // What the change alters, then what it removes; a deck-wide change with no
  // slide of its own shows the first slide, where the difference is visible.
  const removed = new Set(preview?.removedSlideIds ?? []);
  const added = new Set(
    (preview?.changedSlideIds ?? []).filter((id) => !document.slides.some((slide) => slide.id === id)),
  );
  const shown = preview
    ? [...preview.changedSlideIds, ...preview.removedSlideIds].length
      ? [...preview.changedSlideIds, ...preview.removedSlideIds]
      : preview.deckWide && document.slides[0]
        ? [document.slides[0].id]
        : []
    : [];
  const index = Math.min(at, Math.max(0, shown.length - 1));
  const slideId = shown[index];
  const before = slideId ? beforeScene.slides.find((slide) => slide.slideId === slideId) : undefined;
  const after = slideId ? afterScene?.slides.find((slide) => slide.slideId === slideId) : undefined;
  const afterIndex = slideId ? (preview?.after?.slides.findIndex((slide) => slide.id === slideId) ?? -1) : -1;
  const position = afterIndex >= 0 ? afterIndex + 1 : document.slides.findIndex((slide) => slide.id === slideId) + 1;
  const rebased = Boolean(detail?.base_version_id && detail.base_version_id !== editor.currentVersionId());

  // As large as the stage allows, at the deck's own shape.
  const aspect = (document.viewport?.width ?? 1920) / (document.viewport?.height ?? 1080);
  const room = Math.max(0, stage.height - CAPTION);
  const sideWidth = Math.floor(Math.max(0, Math.min((stage.width - PAIR_GAP) / 2 - FRAME, room * aspect)));
  const wipeWidth = Math.floor(Math.max(0, Math.min(stage.width - FRAME, room * aspect)));

  const step = (by: number) => setAt((current) => Math.min(Math.max(0, current + by), Math.max(0, shown.length - 1)));

  const thumbScene = (id: string) =>
    (removed.has(id) ? beforeScene : afterScene ?? beforeScene).slides.find((slide) => slide.slideId === id);

  return (
    <>
      <nav className="dk-review__strip" aria-label="Changed slides">
        <h2 className="dk-review__title">Changed slides</h2>
        <ol className="dk-review__slides">
          {shown.map((id, i) => {
            const scene = thumbScene(id);
            const kind = removed.has(id) ? "Removed" : added.has(id) ? "New" : "Changed";
            return (
              <li key={id}>
                <button
                  type="button"
                  className={cx("dk-review__slide", i === index && "dk-review__slide--current")}
                  aria-current={i === index ? "true" : undefined}
                  onClick={() => setAt(i)}
                  data-testid="review-slide"
                >
                  {scene ? <FinalFrameSlide scene={scene} width={136} resolveAssetUrl={removed.has(id) ? resolveBefore : resolveAfter} /> : null}
                  <span className="dk-review__slide-kind">{kind}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <main className="dk-review__main" aria-label="Before and after">
        <div className="dk-review__toolbar">
          <Segmented<Compare>
            label="Compare"
            size="sm"
            value={compare}
            onChange={setCompare}
            items={[
              { value: "side", label: "Side by side", "data-testid": "review-compare-side" },
              { value: "wipe", label: "Wipe", "data-testid": "review-compare-wipe" },
            ]}
          />
          <span className="dk-review__where">
            {slideId ? `Slide ${position}` : ""}
            {shown.length > 1 ? ` · ${index + 1} of ${shown.length} changed` : ""}
            {preview?.deckWide ? " · deck settings change too" : ""}
          </span>
          <IconButton icon="chevronLeft" label="Previous changed slide" size="sm" variant="secondary" disabled={index === 0} onClick={() => step(-1)} />
          <IconButton
            icon="chevronRight"
            label="Next changed slide"
            size="sm"
            variant="secondary"
            disabled={index >= shown.length - 1}
            onClick={() => step(1)}
          />
          <Button size="sm" variant="secondary" icon="close" onClick={onClose} data-testid="close-review">
            Back to editing
          </Button>
        </div>

        <p className="dk-review__intent-line">
          <strong>{proposal.intent}</strong>
          {preview?.groundedIn.length ? <span className="dk-muted"> · Grounded in {groundingLabel(preview.groundedIn)}</span> : null}
        </p>
        {rebased ? (
          <p className="dk-review__note">Written against an earlier version. The pictures show it applied to the deck as it is now.</p>
        ) : null}

        <div ref={stageRef} className="dk-review__stage" data-testid="review-stage" data-compare={compare}>
          {preview?.error ? (
            <p className="dk-proposal__warning" role="status">
              This change no longer applies to the deck as it is now. Rejecting it clears it. ({preview.error})
            </p>
          ) : !detail ? (
            <p className="dk-muted">{detailError ?? "Drawing the change…"}</p>
          ) : shown.length === 0 ? (
            <p className="dk-muted">This change does not alter anything on the slides.</p>
          ) : compare === "side" ? (
            <div className="dk-review__pair">
              <figure className="dk-review__figure" data-testid="review-before">
                <figcaption>Before</figcaption>
                {before && sideWidth > 0 ? (
                  <FinalFrameSlide scene={before} width={sideWidth} resolveAssetUrl={resolveBefore} />
                ) : (
                  <span className="dk-review__gap" style={{ width: sideWidth, height: sideWidth / aspect }}>
                    New slide
                  </span>
                )}
              </figure>
              <figure className="dk-review__figure" data-testid="review-after">
                <figcaption>After</figcaption>
                {after && sideWidth > 0 ? (
                  <FinalFrameSlide scene={after} width={sideWidth} resolveAssetUrl={resolveAfter} />
                ) : (
                  <span className="dk-review__gap" style={{ width: sideWidth, height: sideWidth / aspect }}>
                    Removed
                  </span>
                )}
              </figure>
            </div>
          ) : (
            <figure className="dk-review__wipe" data-testid="review-wipe" style={{ width: wipeWidth }}>
              <figcaption>
                <span>Before</span>
                <span>After</span>
              </figcaption>
              <span className="dk-review__wipe-frame" style={{ width: wipeWidth, height: wipeWidth / aspect }}>
                {before && wipeWidth > 0 ? <FinalFrameSlide scene={before} width={wipeWidth} resolveAssetUrl={resolveBefore} /> : null}
                {/* After over Before, cut back to the right of the handle. */}
                <span className="dk-review__wipe-after" style={{ clipPath: `inset(0 0 0 ${wipe}%)` }}>
                  {after && wipeWidth > 0 ? <FinalFrameSlide scene={after} width={wipeWidth} resolveAssetUrl={resolveAfter} /> : null}
                </span>
                <span className="dk-review__wipe-line" style={{ left: `${wipe}%` }} aria-hidden="true" />
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={wipe}
                onChange={(event) => setWipe(Number(event.currentTarget.value))}
                aria-label="Wipe between Before and After"
                className="dk-review__wipe-range"
                data-testid="review-wipe-range"
              />
            </figure>
          )}
        </div>
      </main>
    </>
  );
}
