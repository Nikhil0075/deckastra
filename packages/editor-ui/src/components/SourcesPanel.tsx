"use client";

import { useEffect, useState } from "react";

import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { SlideSource } from "@deckastra/workspace-contracts";

/**
 * Evidence an agent or import attached to this slide.
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

    client.documents.slideSources(presentationId, slideId)
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
    return <p className="dk-muted">{error}</p>;
  }

  if (sources === null) {
    return <p className="dk-muted">Loading sources…</p>;
  }

  if (sources.length === 0) {
    return (
      <p className="dk-muted">
        This slide has no attached sources.
      </p>
    );
  }

  return (
    <ul className="dk-sources">
      {sources.map((source) => (
        <SourceRow key={source.id} source={source} />
      ))}
    </ul>
  );
}

function SourceRow({ source }: { source: SlideSource }) {
  // Compact structured references while leaving ordinary URLs and labels intact.
  const [, reference = source.sourceReference] = source.sourceReference.split("#");

  return (
    <li className="dk-sources__item">
      <div className="dk-sources__head">
        {source.url ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="dk-sources__ref dk-sources__ref--link"
          >
            {reference}
          </a>
        ) : (
          <span className="dk-sources__ref">{reference}</span>
        )}
        {typeof source.confidence === "number" ? (
          <span className="dk-muted">
            match {source.confidence.toFixed(2)}
          </span>
        ) : null}
      </div>

      {source.excerpt ? (
        <pre className="dk-sources__excerpt" tabIndex={0}>
          {source.excerpt}
        </pre>
      ) : null}
    </li>
  );
}

