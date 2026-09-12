"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { serializeDocument, walkElements, type PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";
import { useBrowserMeasurer } from "../lib/measurer";
import { reconcileDocuments, type ConflictChoice, type ConflictReview } from "../lib/reconcile";
import type { EditorApi } from "../lib/useEditor";

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
  return <div style={{ minWidth: 0 }}>
    <h4>{title}</h4>
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
    {editor.recoveryCopies.length ? <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--border)" }}>
      <strong>Saved browser copies</strong>
      <p>Each tab keeps its own unsaved work. Close another editor before recovering its copy here.</p>
      <ul>{editor.recoveryCopies.map(copy => <li key={copy.key}>
        <button disabled={busy || copy.active || !!copy.error} onClick={() => void recover(copy.key)}>Recover copy: {copy.title}</button>
        {copy.active ? " — open in another tab" : null}
        {copy.error ? ` — ${copy.error}` : null}
        {" "}<button onClick={() => downloadSavedCopy(copy.key)}>Download saved copy</button>
      </li>)}</ul>
      <button onClick={() => void editor.refreshRecoveryCopies().catch(e => setError(e instanceof Error ? e.message : "Could not refresh copies."))}>Refresh saved copies</button>
      {!open && error ? <p role="alert">{error}</p> : null}
    </div> : null}
    {editor.save.status === "error" ? <div role="alert" style={{ padding: "10px 20px", borderBottom: "1px solid var(--border)" }}>
      <span>{editor.save.message} </span>
      <button onClick={download}>Download local copy</button>
    </div> : null}
    {editor.save.status === "conflict" ? <div style={{ padding: "10px 20px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      <span>Your local edits have been retained. </span>
      <button onClick={() => void refresh()}>Review conflicting versions</button>{" "}
      <button onClick={download}>Download local copy</button>
    </div> : null}
    <dialog ref={dialog} aria-labelledby="recovery-title" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      onKeyDown={event => event.stopPropagation()}
      style={{ width: "min(960px, 94vw)", maxHeight: "85vh", overflow: "auto", background: "var(--surface)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 10 }}>
      <h2 id="recovery-title">Review recovered edits</h2>
      <p>Compatible edits from both versions are combined. Choose which version to keep for each conflict before saving.</p>
      {busy ? <p role="status">Working…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {review && merged ? <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
          <SlidePreview document={review.local} index={editor.slideIndex} title="Your local version" />
          <SlidePreview document={review.server} index={editor.slideIndex} title="Saved version" />
          {!merged.errors.length ? <SlidePreview document={merged.document} index={editor.slideIndex} title="Combined result" /> : null}
        </div>
        {merged.conflicts.length === 0 ? <p>No overlapping changes. Both versions' edits can be saved together.</p> : null}
        {merged.conflicts.map(conflict => <fieldset key={conflict.path} style={{ margin: "16px 0" }}>
          <legend>{label(conflict.path, review.local)}</legend>
          {(["local", "server"] as const).map(choice => <label key={choice} style={{ display: "block", margin: "8px 0" }}>
            <input type="radio" name={conflict.path} checked={choices[conflict.path] === choice}
              onChange={() => setChoices(current => ({ ...current, [conflict.path]: choice }))} />
            {choice === "local" ? "Keep mine" : "Use saved version"}
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto", fontSize: 12 }}>{describe(conflict[choice])}</pre>
          </label>)}
        </fieldset>)}
        {merged.errors.map(message => <p role="alert" key={message}>{message}</p>)}
        <button onClick={() => void save()} disabled={busy || merged.errors.length > 0 || merged.conflicts.some(c => !choices[c.path])}>Save reviewed result</button>{" "}
      </> : null}
      <button onClick={() => void refresh()} disabled={busy}>Refresh comparison</button>{" "}
      <button onClick={download}>Download local copy</button>{" "}
      <button onClick={() => setOpen(false)} disabled={busy}>Keep editing locally</button>
    </dialog>
  </>;
}
