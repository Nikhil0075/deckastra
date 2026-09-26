"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { serializeDocument, walkElements, type PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";
import { useBrowserMeasurer } from "../lib/measurer";
import { reconcileDocuments, type ConflictChoice, type ConflictReview } from "../lib/reconcile";
import type { RecoveryCopy } from "../lib/editor-recovery";
import { groupRecoveryCopies, recoveryDetail, recoverySummary } from "../lib/recovery-copies";
import type { EditorApi } from "../lib/useEditor";
import { Button, StatusChip } from "../ui";

function label(path: string, document: PresentationDocument): string {
  return path.split("/").filter(Boolean).map(raw => {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (part === "@order") return "Order";
    if (!part.startsWith("id:")) return part.replace(/([a-z])([A-Z])/g, "$1 $2");
    const id = part.slice(3);
    const index = document.slides.findIndex(slide => slide.id === id);
    if (index >= 0) return `Slide ${index + 1}`;
    for (const slide of document.slides) {
      const item = [...walkElements(slide.elements)].find(({ element }) => element.id === id)?.element;
      if (item) return item.name || item.type;
    }
    return "Removed item";
  }).join(" › ");
}

function describe(value: unknown): string {
  if (value === undefined) return "Deleted";
  if (typeof value === "string") return value || "Empty";
  if (value === null) return "Empty";
  return JSON.stringify(value, null, 2);
}

function SlidePreview({ document, index, title }: { document: PresentationDocument; index: number; title: string }) {
  const measurer = useBrowserMeasurer();
  const scene = useMemo(() => buildDocumentScene(document, { measurer }), [document, measurer]);
  const slide = scene.slides[Math.min(index, scene.slides.length - 1)];
  return <div className="dk-dialog__preview">
    <h4 className="dk-label">{title}</h4>
    {slide ? <ScaledSlide scene={slide} width={280} mode="export" /> : <p>No slides</p>}
  </div>;
}

/** Native modal focus handling keeps canvas shortcuts out of the review. */
export function ConflictRecovery({ editor }: { editor: EditorApi }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<ConflictReview | null>(null);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const merged = useMemo(() => review ? reconcileDocuments(review.base, review.local, review.server, choices) : null, [review, choices]);
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) node.showModal();
    if (!open && node?.open) node.close();
  }, [open]);

  async function refresh() {
    setOpen(true); setBusy(true); setError(""); setReview(null); setChoices({});
    try { setReview(await editor.reviewConflict()); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not compare versions."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!review) return;
    setBusy(true); setError("");
    try {
      if (await editor.resolveConflict(review, choices)) setOpen(false);
      else setError("The merge was not saved. Your local copy is retained. Retry or refresh the comparison if the server changed again.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the reviewed deck."); }
    finally { setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([serializeDocument(editor.document)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "local-recovery.mydeck.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadSavedCopy(key: string) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) throw new Error("That saved copy is no longer available.");
      const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = "saved-recovery-record.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not download the saved copy."); }
  }

  async function recover(key: string) {
    setBusy(true); setError("");
    try { await editor.recoverCopy(key); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not recover that copy."); }
    finally { setBusy(false); }
  }

  return <>
    {editor.recoveryCopies.length ? <RecoveryCopies
      copies={editor.recoveryCopies}
      busy={busy}
      error={!open ? error : ""}
      onRecover={key => void recover(key)}
      onDownload={downloadSavedCopy}
      onRefresh={() => void editor.refreshRecoveryCopies().catch(e => setError(e instanceof Error ? e.message : "Could not refresh copies."))}
    /> : null}
    {editor.save.status === "error" ? <div role="alert" className="dk-banner dk-banner--danger dk-banner--actions">
      <span>{editor.save.message}</span>
      <Button size="sm" variant="secondary" onClick={download}>Download local copy</Button>
    </div> : null}
    {editor.save.status === "conflict" ? <div className="dk-banner dk-banner--notice dk-banner--actions">
      <span>Your local edits have been retained.</span>
      <Button size="sm" variant="secondary" onClick={() => void refresh()}>Review conflicting versions</Button>
      <Button size="sm" variant="ghost" onClick={download}>Download local copy</Button>
    </div> : null}
    <dialog ref={dialog} aria-labelledby="recovery-title" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      onKeyDown={event => event.stopPropagation()}
      className="dk-dialog">
      <h2 id="recovery-title" className="dk-dialog__title">Review recovered edits</h2>
      <p className="dk-muted">Compatible edits from both versions are combined. Choose which version to keep for each conflict before saving.</p>
      {busy ? <p role="status" className="dk-muted">Working…</p> : null}
      {error ? <p role="alert" className="dk-export__error">{error}</p> : null}
      {review && merged ? <>
        <div className="dk-dialog__previews">
          <SlidePreview document={review.local} index={editor.slideIndex} title="Your local version" />
          <SlidePreview document={review.server} index={editor.slideIndex} title="Saved version" />
          {!merged.errors.length ? <SlidePreview document={merged.document} index={editor.slideIndex} title="Combined result" /> : null}
        </div>
        {merged.conflicts.length === 0 ? <p>No overlapping changes. Both versions' edits can be saved together.</p> : null}
        {merged.conflicts.map(conflict => <fieldset key={conflict.path} className="dk-dialog__conflict">
          <legend className="dk-label">{label(conflict.path, review.local)}</legend>
          {(["local", "server"] as const).map(choice => <label key={choice} className="dk-dialog__choice">
            <input type="radio" name={conflict.path} checked={choices[conflict.path] === choice}
              onChange={() => setChoices(current => ({ ...current, [conflict.path]: choice }))} />
            {choice === "local" ? "Keep mine" : "Use saved version"}
            <pre className="dk-dialog__value">{describe(conflict[choice])}</pre>
          </label>)}
        </fieldset>)}
        {merged.errors.map(message => <p role="alert" className="dk-export__error" key={message}>{message}</p>)}
        <button type="button" className="dk-btn dk-btn--primary dk-btn--sm" onClick={() => void save()} disabled={busy || merged.errors.length > 0 || merged.conflicts.some(c => !choices[c.path])}>Save reviewed result</button>{" "}
      </> : null}
      <button type="button" className="dk-btn dk-btn--secondary dk-btn--sm" onClick={() => void refresh()} disabled={busy}>Refresh comparison</button>{" "}
      <button type="button" className="dk-btn dk-btn--secondary dk-btn--sm" onClick={download}>Download local copy</button>{" "}
      <button type="button" className="dk-btn dk-btn--ghost dk-btn--sm" onClick={() => setOpen(false)} disabled={busy}>Keep editing locally</button>
    </dialog>
  </>;
}

/**
 * Unsaved work other editor windows left in this browser (each window keeps its
 * own journal, and the retention rules can leave several).
 *
 * Collapsed to one line by default: the list is something to act on once, and
 * twenty rows of it above the canvas left no room to edit. Expanded, it is
 * bounded and scrolls. Presentation only — recovering still goes through the
 * journal's lock, and nothing here removes a copy.
 */
export function RecoveryCopies({ copies, busy, error, onRecover, onDownload, onRefresh }: {
  copies: readonly RecoveryCopy[];
  busy: boolean;
  error: string;
  onRecover: (key: string) => void;
  onDownload: (key: string) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupRecoveryCopies(copies), [copies]);
  const now = Date.now();
  const listId = "dk-recovery-list";
  return <div className="dk-recovery" data-testid="recovery-copies">
    <div className="dk-banner dk-banner--notice dk-banner--actions dk-recovery__bar">
      <span>{recoverySummary(copies)}</span>
      <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={listId}
        onClick={() => setExpanded(value => !value)} data-testid="recovery-toggle">
        {expanded ? "Hide" : "Review"}
      </Button>
      {error ? <span role="alert" className="dk-recovery__error">{error}</span> : null}
    </div>
    {expanded ? <div id={listId} className="dk-recovery__panel">
      <p className="dk-recovery__hint">
        Each window keeps its own unsaved work. Close the other window before recovering its copy here.
      </p>
      <div className="dk-recovery__list">
        {groups.map(group => <div key={group.title} className="dk-recovery__group">
          <h3 className="dk-recovery__title">{group.title}</h3>
          <ul className="dk-recovery__copies">
            {group.copies.map(copy => <li key={copy.key} className="dk-recovery__copy">
              <span className="dk-recovery__detail">
                {recoveryDetail(copy, now)}
                {copy.active ? <StatusChip tone="neutral">Open in another window</StatusChip> : null}
                {copy.error ? <StatusChip tone="danger">{copy.error}</StatusChip> : null}
              </span>
              <Button size="sm" variant="secondary" disabled={busy || copy.active || !!copy.error}
                aria-label={`Recover copy: ${copy.title}`} onClick={() => onRecover(copy.key)}>
                Recover
              </Button>
              <Button size="sm" variant="ghost" aria-label="Download saved copy" onClick={() => onDownload(copy.key)}>
                Download
              </Button>
            </li>)}
          </ul>
        </div>)}
      </div>
      <Button size="sm" variant="ghost" onClick={onRefresh}>Refresh saved copies</Button>
    </div> : null}
  </div>;
}
