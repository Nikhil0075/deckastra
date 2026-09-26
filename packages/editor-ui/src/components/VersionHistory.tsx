import { useEffect, useMemo, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { VersionSummary } from "@deckastra/workspace-contracts";

import { useAssetUrls } from "../lib/asset-urls";
import { useBrowserMeasurer } from "../lib/measurer";
import type { EditorApi } from "../lib/useEditor";
import { compareSlides, comparisonSummary, versionRows, type SlideChange } from "../lib/version-history";
import { Button, Drawer, IconButton, StatusChip } from "../ui";
import { cx } from "../ui/cx";
import { FinalFrameSlide } from "./FinalFrameSlide";

const PREVIEW_WIDTH = 432;
const COMPARE_WIDTH = 96;

/** Read from the chosen version's side: what restoring it would do to a slide. */
const CHANGE_LABEL: Record<Exclude<SlideChange, "same">, string> = {
  changed: "Differs",
  added: "Not in current deck",
  removed: "Added since",
};

export interface VersionHistoryProps {
  editor: EditorApi;
  presentationId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * The version history drawer (editor Phase 5, Figma frame "version history").
 *
 * Modal on purpose: while it is open the canvas behind it is dimmed and the
 * preview here shows a *past* version, and editing underneath would be editing
 * something other than what is on screen.
 *
 * Restoring is an ordinary change (`useEditor.restoreVersion`): it drains the
 * save queue first, tells the server which version the person was looking at,
 * and can be undone — nothing is ever removed from the history.
 */
export function VersionHistory({ editor, presentationId, open, onClose }: VersionHistoryProps) {
  const client = useWorkspaceClient();
  const measurer = useBrowserMeasurer();
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ReadonlyMap<string, PresentationDocument>>(new Map());
  const [readError, setReadError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [slideAt, setSlideAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  // Asked every time it opens: the list is a view of the server, and a deck an
  // agent changed since the last look has versions this one never saw.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    client.documents
      .versions(presentationId)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load the version history.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, open, presentationId, reloads]);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setComparing(false);
      setMessage(null);
    }
  }, [open]);

  useEffect(() => {
    if (!selectedId || documents.has(selectedId)) return;
    let cancelled = false;
    setReadError(null);
    client.documents
      .readAt(presentationId, selectedId)
      .then((read) => {
        if (cancelled) return;
        setDocuments((current) => new Map(current).set(selectedId, read.document));
      })
      .catch((error: unknown) => {
        if (!cancelled) setReadError(error instanceof Error ? error.message : "Could not read that version.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, documents, presentationId, selectedId]);

  const currentVersionId = editor.currentVersionId();
  const { rows, truncated } = useMemo(
    () => versionRows(versions ?? [], currentVersionId, Date.now()),
    [versions, currentVersionId],
  );
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const viewed = selectedId ? documents.get(selectedId) ?? null : null;
  const resolveAssetUrl = useAssetUrls(viewed);

  const scene = useMemo(() => (viewed ? buildDocumentScene(viewed, { measurer }) : null), [viewed, measurer]);
  const slideCount = scene?.slides.length ?? 0;
  const shownSlide = scene?.slides[Math.min(slideAt, Math.max(0, slideCount - 1))] ?? null;

  const comparison = useMemo(
    () => (viewed && comparing ? compareSlides(viewed, editor.document) : null),
    [viewed, comparing, editor.document],
  );
  const summary = useMemo(
    () => (viewed && comparing ? comparisonSummary(viewed, editor.document) : null),
    [viewed, comparing, editor.document],
  );

  const select = (id: string) => {
    setSelectedId(id);
    setMessage(null);
    // Open on the slide the person is editing when that slide exists there.
    const current = editor.document.slides[editor.slideIndex]?.id;
    const cached = documents.get(id);
    const index = cached && current ? cached.slides.findIndex((slide) => slide.id === current) : -1;
    setSlideAt(index >= 0 ? index : 0);
  };

  const restore = async () => {
    if (!selectedRow || selectedRow.current) return;
    setBusy(true);
    setMessage(null);
    const answer = await editor.restoreVersion(selectedRow.id);
    setBusy(false);
    if (!answer.ok) {
      setMessage(answer.message ?? "That version could not be restored.");
      return;
    }
    onClose();
  };

  const footer = selectedRow ? (
    <div className="dk-versions__actions">
      <Button
        variant="secondary"
        size="sm"
        disabled={!viewed || selectedRow.current}
        aria-pressed={comparing}
        onClick={() => setComparing((value) => !value)}
        data-testid="history-compare"
      >
        {comparing ? "Hide comparison" : "Compare with current"}
      </Button>
      <Button
        size="sm"
        disabled={!viewed || selectedRow.current || busy}
        onClick={() => void restore()}
        data-testid="history-restore"
      >
        {busy ? "Restoring…" : "Restore this version"}
      </Button>
    </div>
  ) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Version history"
      meta={versions ? `${versions.length}${truncated ? "+" : ""} version${versions.length === 1 ? "" : "s"}` : undefined}
      footer={footer}
      width={PREVIEW_WIDTH + 48}
      data-testid="history-drawer"
    >
      {selectedRow ? (
        <section className="dk-versions__preview" aria-label={`Preview of ${selectedRow.number}`}>
          <p className="dk-versions__preview-title">
            <span className="dk-versions__number">{selectedRow.number}</span> {selectedRow.title}
            {selectedRow.current ? <StatusChip tone="action">Current</StatusChip> : null}
          </p>
          {readError ? (
            <p className="dk-versions__error" role="alert">
              {readError}
            </p>
          ) : shownSlide ? (
            <>
              <div className="dk-versions__frame" data-testid="history-preview">
                <FinalFrameSlide scene={shownSlide} width={PREVIEW_WIDTH} resolveAssetUrl={resolveAssetUrl} />
              </div>
              <div className="dk-versions__stepper">
                <IconButton
                  icon="chevronLeft"
                  label="Previous slide"
                  size="sm"
                  variant="secondary"
                  disabled={slideAt <= 0}
                  onClick={() => setSlideAt((index) => Math.max(0, index - 1))}
                />
                <span>
                  Slide {Math.min(slideAt, slideCount - 1) + 1} of {slideCount}
                </span>
                <IconButton
                  icon="chevronRight"
                  label="Next slide"
                  size="sm"
                  variant="secondary"
                  disabled={slideAt >= slideCount - 1}
                  onClick={() => setSlideAt((index) => Math.min(slideCount - 1, index + 1))}
                />
              </div>
            </>
          ) : (
            <p className="dk-versions__hint">Loading this version…</p>
          )}

          {comparison && scene ? (
            <div className="dk-versions__compare" data-testid="history-comparison">
              <p className="dk-versions__summary">{summary}</p>
              <ol className="dk-versions__slides">
                {comparison.map((entry) => {
                  const slideScene =
                    entry.position !== null ? scene.slides[entry.position - 1] ?? null : null;
                  return (
                    <li
                      key={entry.slideId}
                      className={cx("dk-versions__slide", `dk-versions__slide--${entry.change}`)}
                      data-change={entry.change}
                    >
                      {slideScene ? (
                        <button
                          type="button"
                          className="dk-versions__slide-thumb"
                          aria-label={`Show slide ${entry.position}`}
                          onClick={() => setSlideAt((entry.position ?? 1) - 1)}
                        >
                          <FinalFrameSlide scene={slideScene} width={COMPARE_WIDTH} resolveAssetUrl={resolveAssetUrl} />
                        </button>
                      ) : (
                        <span className="dk-versions__slide-gap" aria-hidden="true" />
                      )}
                      <span className="dk-versions__slide-label">
                        {entry.position !== null ? `Slide ${entry.position}` : "Current deck only"}
                        {entry.change !== "same" ? (
                          <StatusChip tone={entry.change === "changed" ? "action" : entry.change === "added" ? "waiting" : "danger"}>
                            {CHANGE_LABEL[entry.change]}
                          </StatusChip>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {message ? (
            <p className="dk-versions__error" role="alert">
              {message}
            </p>
          ) : null}
        </section>
      ) : (
        <p className="dk-versions__hint">
          Choose a version to preview it. Restoring one adds a new version; nothing is removed from this list.
        </p>
      )}

      {loadError ? (
        <p className="dk-versions__error" role="alert">
          {loadError}{" "}
          <Button size="sm" variant="ghost" onClick={() => setReloads((count) => count + 1)}>
            Try again
          </Button>
        </p>
      ) : null}

      <ol className="dk-versions" aria-label="Versions, newest first">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={cx("dk-versions__row", row.id === selectedId && "dk-versions__row--selected")}
              aria-pressed={row.id === selectedId}
              onClick={() => select(row.id)}
              data-testid="history-row"
              data-version-id={row.id}
            >
              <span
                className={cx("dk-versions__marker", row.byAgent && "dk-versions__marker--agent")}
                aria-hidden="true"
              />
              <span className="dk-versions__text">
                <span className="dk-versions__title">
                  <span className="dk-versions__number">{row.number}</span> — {row.title}
                </span>
                <span className="dk-versions__detail">
                  {row.detail}
                  {row.current ? " · current" : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {truncated ? (
        <p className="dk-versions__hint">Showing the {rows.length} most recent versions.</p>
      ) : null}
    </Drawer>
  );
}
