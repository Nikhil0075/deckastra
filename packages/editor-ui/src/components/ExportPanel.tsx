"use client";

import { languageLabel } from "../lib/languages";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { ExportJob, ExportReport, ExportWarning } from "@deckastra/workspace-contracts";
import { commitFocusedDraft } from "../lib/drafts";
import { Button, StatusChip } from "../ui";

/**
 * Exporting, and reading the report before the file (doc 04 §32.2).
 *
 * The order of this component is the requirement: the report appears, and the
 * download button appears under it. Doc 04 §32.2 says the user sees what was
 * degraded *before* they download — not after they have sent the file to a
 * client — and a UI that downloads on click and shows warnings in a toast has
 * technically shown them and practically not.
 *
 * A degradation is not an error, so it is not styled as one. "Groups were
 * flattened" is something a recipient should know and nothing anyone needs to
 * act on; a red banner would train the user to ignore the one that matters.
 */

type Kind = "pdf" | "pptx";

type State =
  | { phase: "idle" }
  | { phase: "saving"; kind: Kind }
  | { phase: "running"; kind: Kind; job?: ExportJob }
  | { phase: "ready"; job: ExportJob }
  | { phase: "unsaved"; kind: Kind }
  | { phase: "failed"; message: string; job?: ExportJob };

/**
 * The open editor, as an export needs it.
 *
 * An export renders what the service has stored, and the editor saves on a
 * debounce — so without this an edit made a moment ago, or one whose save is
 * failing, is on screen and not in the file, and the file says it succeeded.
 * With it, the export waits for the save queue to drain and names the version
 * that drain was acknowledged at, so the file is the deck on screen or nothing.
 */
export interface ExportSaveBarrier {
  saveNow: () => Promise<boolean>;
  currentVersionId: () => string;
  /** The language on screen, which is the language exported (integration plan 01 §3.10). */
  locale?: string | null;
}

export interface ExportPanelProps {
  presentationId: string;
  /** Absent in the deck list, where no deck is open and what is stored is the deck. */
  editor?: ExportSaveBarrier;
}

export function ExportPanel({ presentationId, editor }: ExportPanelProps) {
  const client = useWorkspaceClient();
  const [state, setState] = useState<State>({ phase: "idle" });
  const [includeNotes, setIncludeNotes] = useState(false);
  const [atTime, setAtTime] = useState<"final" | "initial">("final");
  const polling = useRef<AbortController | null>(null);

  useEffect(() => () => polling.current?.abort(), []);

  async function poll(job: ExportJob, signal: AbortSignal) {
    let current = job;
    while (["queued", "running"].includes(current.status)) {
      setState({ phase: "running", kind: current.kind, job: current });
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 800);
        signal.addEventListener("abort", () => {
          window.clearTimeout(timer);
          reject(new DOMException("Polling stopped", "AbortError"));
        }, { once: true });
      });
      current = await client.exports.status(current.id, { signal });
    }
    if (current.status === "completed") setState({ phase: "ready", job: current });
    else setState({ phase: "failed", message: current.error ?? current.message ?? `Export ${current.status}.`, job: current });
  }

  /**
   * Export. From the editor, the save queue drains first and the export is
   * pinned to the version it drained to. If it cannot drain (a failed save, a
   * conflict under review) nothing starts: the person is told their latest
   * changes would be missing and may choose, explicitly, to export the last
   * saved version instead (`lastSaved`).
   */
  async function run(kind: Kind, { lastSaved = false }: { lastSaved?: boolean } = {}) {
    polling.current?.abort();
    const controller = new AbortController();
    polling.current = controller;

    let expected: string | undefined;
    if (editor && !lastSaved) {
      // A notes draft still in its field is part of "what is on screen".
      commitFocusedDraft();
      setState({ phase: "saving", kind });
      if (!(await editor.saveNow())) {
        if (!controller.signal.aborted) setState({ phase: "unsaved", kind });
        return;
      }
      if (controller.signal.aborted) return;
      expected = editor.currentVersionId();
    }
    setState({ phase: "running", kind });

    try {
      const job = await client.exports.start(
        presentationId,
        {
          kind,
          include_notes: includeNotes,
          at_time: atTime,
          idempotency_key: crypto.randomUUID(),
          ...(expected ? { expected_version_id: expected } : {}),
          ...(editor?.locale ? { locale: editor.locale } : {}),
        },
        { signal: controller.signal },
      );

      await poll(job, controller.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({
        phase: "failed",
        message: error instanceof Error ? error.message : "The export failed.",
      });
    }
  }

  async function cancel(job: ExportJob) {
    try {
      const body = await client.exports.cancel(job.id);
      if (body.status === "cancelled") polling.current?.abort();
      setState({ phase: "failed", message: body.message ?? "Export cancelled.", job: body });
    } catch (error) {
      setState({
        phase: "failed",
        message: error instanceof Error ? error.message : "Could not cancel the export.",
        job,
      });
    }
  }

  async function retry(job: ExportJob) {
    const controller = new AbortController();
    polling.current = controller;
    let restarted: ExportJob;
    try {
      restarted = await client.exports.retry(job.id, { signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({ phase: "failed", message: "This export could not be retried.", job });
      return;
    }
    await poll(restarted, controller.signal);
  }

  async function download(job: ExportJob) {
    // Handed over as bytes rather than linked directly: the download endpoint is
    // authenticated and a bare <a href> cannot carry a credential. The desktop
    // shell will hand the same bytes to a native save dialog instead.
    let bytes: Blob;
    try {
      bytes = await client.exports.download(job.id);
    } catch {
      setState({ phase: "failed", message: "The file is no longer available. Export it again." });
      return;
    }

    const url = URL.createObjectURL(bytes);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = job.filename ?? `deck.${job.kind}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const busyKind = state.phase === "running" || state.phase === "saving" ? state.kind : null;
  const busy = busyKind !== null;

  return (
    // The heading comes first in the section, and CSS uppercases it: the
    // desktop export step finds this panel by its rendered text starting
    // "EXPORT", which is how it tells it from the Share panel.
    <section className="dk-export">
      <h3 className="dk-label dk-export__heading">Export</h3>
      {editor?.locale ? (
        // Said before pressing: the file is in the language on screen.
        <p className="dk-muted" data-testid="export-language">
          In {languageLabel(editor.locale)}. Switch language in the bar to export another.
        </p>
      ) : null}

      <div className="dk-export__formats">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("pdf")}>
          {busyKind === "pdf" ? "Exporting…" : "PDF"}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("pptx")}>
          {busyKind === "pptx" ? "Exporting…" : "PowerPoint"}
        </Button>
      </div>

      <label className="dk-export__option">
        <input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} />
        Include speaker notes
      </label>

      <label className="dk-export__option">
        <input
          type="checkbox"
          checked={atTime === "initial"}
          onChange={(event) => setAtTime(event.target.checked ? "initial" : "final")}
        />
        {/* Doc 04 §34.2: the handout case. A click-reveal deck exported at its
            final state gives every answer away on the first page. */}
        Freeze before animations run
      </label>

      {state.phase === "saving" ? (
        <p className="dk-muted" role="status">
          Saving your latest changes first…
        </p>
      ) : null}

      {state.phase === "unsaved" ? (
        <div className="dk-export__block" data-testid="export-unsaved">
          <p className="dk-export__error" role="alert">
            Your latest changes have not saved, so an export now would leave them out. Nothing was exported.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void run(state.kind, { lastSaved: true })}>
            Export the last saved version
          </Button>
        </div>
      ) : null}

      {state.phase === "failed" ? (
        <div className="dk-export__block">
          <p className="dk-export__error" role="alert">
            {state.message}
          </p>
          {state.job && ["failed", "cancelled"].includes(state.job.status) ? (
            // A retry renders the version the job was pinned to, which may be
            // older than the deck now. The label says so; PDF or PowerPoint
            // above exports the current deck.
            <Button size="sm" variant="secondary" onClick={() => void retry(state.job!)}>
              Retry this version
            </Button>
          ) : null}
        </div>
      ) : null}

      {state.phase === "running" && state.job ? (
        <div className="dk-export__block">
          <progress className="dk-export__progress" value={state.job.progress} max={1} aria-label="Export progress" />
          <p className="dk-muted" role="status">
            {state.job.message ?? state.job.stage ?? "Export queued…"}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void cancel(state.job!)}>
            Cancel
          </Button>
        </div>
      ) : null}

      {state.phase === "ready" ? <Ready job={state.job} onDownload={download} /> : null}
    </section>
  );
}

function Ready({
  job,
  onDownload,
}: {
  job: ExportJob;
  onDownload: (job: ExportJob) => Promise<void>;
}) {
  const report = job.report;
  const warnings = report?.warnings ?? [];

  return (
    // The version travels on the element so the desktop harness can check the
    // file is of the deck that was on screen (audit UI-01).
    <div className="dk-export__block" data-export-version={job.version_id ?? undefined}>
      <p className="dk-muted">
        {report?.slideCount ?? 0} slide{report?.slideCount === 1 ? "" : "s"} · {Math.round(job.bytes / 1024)} KB
      </p>

      {/* The report first, the button second. That order is doc 04 §32.2's
          requirement, not a layout preference. */}
      {warnings.length === 0 ? (
        <p className="dk-muted">Nothing was degraded — this file carries everything on the deck.</p>
      ) : (
        <details open className="dk-export__report">
          <summary className="dk-export__summary">
            {warnings.length} thing{warnings.length === 1 ? "" : "s"} changed to fit this format
          </summary>
          <ul className="dk-export__warnings">
            {warnings.map((warning) => (
              <li key={`${warning.slideId}${warning.feature}${warning.action}`} className="dk-export__warning">
                {/* The action, not the feature name: "unsupported" tells a reader
                    nothing, "rasterized" tells them the text is no longer
                    selectable. Dropped is the one to go and look for. */}
                <StatusChip tone={warning.action === "dropped" ? "danger" : "neutral"}>{warning.action}</StatusChip>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {report?.metricsEstimated ? (
        <p className="dk-export__note">
          Some text was measured by estimate rather than by a browser, so line breaks in this file may differ slightly
          from the editor.
        </p>
      ) : null}

      <Button size="sm" variant="primary" icon="download" onClick={() => void onDownload(job)}>
        Download {job.filename}
      </Button>
    </div>
  );
}

