"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { ExportJob, ExportReport, ExportWarning } from "@deckastra/workspace-contracts";

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

type State =
  | { phase: "idle" }
  | { phase: "running"; kind: "pdf" | "pptx"; job?: ExportJob }
  | { phase: "ready"; job: ExportJob }
  | { phase: "failed"; message: string; job?: ExportJob };

export function ExportPanel({ presentationId }: { presentationId: string }) {
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

  async function run(kind: "pdf" | "pptx") {
    polling.current?.abort();
    const controller = new AbortController();
    polling.current = controller;
    setState({ phase: "running", kind });

    try {
      const job = await client.exports.start(
        presentationId,
        {
          kind,
          include_notes: includeNotes,
          at_time: atTime,
          idempotency_key: crypto.randomUUID(),
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

  return (
    <section style={{ padding: "0 16px 16px" }}>
      <h3 style={heading}>Export</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button
          style={button}
          disabled={state.phase === "running"}
          onClick={() => void run("pdf")}
        >
          {state.phase === "running" && state.kind === "pdf" ? "Exporting…" : "PDF"}
        </button>
        <button
          style={button}
          disabled={state.phase === "running"}
          onClick={() => void run("pptx")}
        >
          {state.phase === "running" && state.kind === "pptx" ? "Exporting…" : "PowerPoint"}
        </button>
      </div>

      <label style={option}>
        <input
          type="checkbox"
          checked={includeNotes}
          onChange={(event) => setIncludeNotes(event.target.checked)}
        />
        Include speaker notes
      </label>

      <label style={option}>
        <input
          type="checkbox"
          checked={atTime === "initial"}
          onChange={(event) => setAtTime(event.target.checked ? "initial" : "final")}
        />
        {/* Doc 04 §34.2: the handout case. A click-reveal deck exported at its
            final state gives every answer away on the first page. */}
        Freeze before animations run
      </label>

      {state.phase === "failed" ? (
        <div style={{ marginTop: 10 }}>
          <p style={{ ...muted, color: "var(--danger)" }}>{state.message}</p>
          {state.job && ["failed", "cancelled"].includes(state.job.status) ? (
            <button style={{ ...button, marginTop: 8 }} onClick={() => void retry(state.job!)}>Retry</button>
          ) : null}
        </div>
      ) : null}

      {state.phase === "running" && state.job ? (
        <div style={{ marginTop: 10 }}>
          <progress value={state.job.progress} max={1} style={{ width: "100%" }} />
          <p style={{ ...muted, marginTop: 5 }}>
            {state.job.message ?? state.job.stage ?? "Export queued…"}
          </p>
          <button style={{ ...button, marginTop: 8 }} onClick={() => void cancel(state.job!)}>
            Cancel
          </button>
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
    <div style={{ marginTop: 12 }}>
      <p style={{ ...muted, marginBottom: 8 }}>
        {report?.slideCount ?? 0} slide{report?.slideCount === 1 ? "" : "s"} ·{" "}
        {Math.round(job.bytes / 1024)} KB
      </p>

      {/* The report first, the button second. That order is doc 04 §32.2's
          requirement, not a layout preference. */}
      {warnings.length === 0 ? (
        <p style={{ ...muted, color: "var(--accent)" }}>
          Nothing was degraded — this file carries everything on the deck.
        </p>
      ) : (
        <details open style={{ marginBottom: 10 }}>
          <summary style={{ ...muted, cursor: "pointer" }}>
            {warnings.length} thing{warnings.length === 1 ? "" : "s"} changed to fit this format
          </summary>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {warnings.map((warning) => (
              <li key={`${warning.slideId}${warning.feature}${warning.action}`} style={warningRow}>
                {/* The action, not the feature name: "unsupported" tells a reader
                    nothing, "rasterized" tells them the text is no longer
                    selectable. */}
                <span style={{ ...pill, color: colourFor(warning.action) }}>{warning.action}</span>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {report?.metricsEstimated ? (
        <p style={{ ...muted, color: "var(--warning)" }}>
          Some text was measured by estimate rather than by a browser, so line
          breaks in this file may differ slightly from the editor.
        </p>
      ) : null}

      <button style={{ ...button, marginTop: 10 }} onClick={() => void onDownload(job)}>
        Download {job.filename}
      </button>
    </div>
  );
}

function colourFor(action: ExportWarning["action"]): string {
  // Dropped is the only one a reader has to look for in the file; the rest are
  // things they should know about and need not act on.
  return action === "dropped" ? "var(--warning)" : "var(--fg-subtle)";
}

const heading: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.4,
  textTransform: "uppercase",
  color: "var(--fg-subtle)",
  margin: "0 0 10px",
};

const button: CSSProperties = {
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  color: "var(--fg)",
  borderRadius: 8,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
};

const option: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 12,
  color: "var(--fg-muted)",
  marginBottom: 5,
};

const warningRow: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  fontSize: 12,
  color: "var(--fg-muted)",
  marginBottom: 6,
};

const pill: CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "1px 7px",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const muted: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-subtle)",
  margin: 0,
};
