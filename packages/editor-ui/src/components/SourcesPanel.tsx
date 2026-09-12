"use client";

import { useEffect, useState } from "react";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { SlideSource } from "@deckastra/workspace-contracts";

/**
 * Where this slide's claims came from — the phase's exit criterion.
 *
 * Two things it deliberately does not do.
 *
 * It does not hide the empty case. A slide with no sources says so, because the
 * absence is information: this slide is not grounded in anything, and a panel
 * that simply vanishes leaves the user unable to tell the difference between
 * "nothing to show" and "not loaded".
 *
 * It does not fabricate a link. `url` is null for a local checkout and for a
 * slide citing another slide; a link that 404s reads as a fabricated citation,
 * so the reference is shown as text instead.
 */

export function SourcesPanel({
  presentationId,
  slideId,
}: {
  presentationId: string;
  slideId: string;
}) {
  const client = useWorkspaceClient();
  const [sources, setSources] = useState<SlideSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSources(null);
    setError(null);

    client.repositories.slideSources(presentationId, slideId)
      .then((body) => {
        if (!cancelled) setSources(body.sources);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load sources.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, presentationId, slideId]);

  if (error) {
    return <p style={mutedStyle}>{error}</p>;
  }

  if (sources === null) {
    return <p style={mutedStyle}>Loading sources…</p>;
  }

  if (sources.length === 0) {
    return (
      <p style={mutedStyle}>
        This slide is not grounded in a source. Nothing on it was written from an
        indexed file.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {sources.map((source) => (
        <SourceRow key={source.id} source={source} />
      ))}
    </ul>
  );
}

function SourceRow({ source }: { source: SlideSource }) {
  // `owner/repo#path:12-48` — the repository is context the user already has, so
  // the file and its lines are what gets the emphasis.
  const [, reference = source.sourceReference] = source.sourceReference.split("#");

  return (
    <li
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "10px 12px",
        marginBottom: 8,
        background: "var(--surface-alt)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600 }}
          >
            {reference}
          </a>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 600 }}>{reference}</span>
        )}
        {typeof source.confidence === "number" ? (
          <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
            match {source.confidence.toFixed(2)}
          </span>
        ) : null}
      </div>

      {source.excerpt ? (
        <pre
          style={{
            margin: "8px 0 0",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--fg-muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 130,
            overflow: "auto",
          }}
        >
          {source.excerpt}
        </pre>
      ) : null}
    </li>
  );
}

const mutedStyle: React.CSSProperties = {
  color: "var(--fg-muted)",
  fontSize: 13,
  margin: 0,
};
