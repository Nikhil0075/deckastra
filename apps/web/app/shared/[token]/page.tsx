"use client";

import { use, useEffect, useMemo, useState } from "react";
import { buildDocumentScene, type DocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { SharedDocument } from "@deckastra/workspace-contracts";

import { PresentMode, useBrowserMeasurer } from "@deckastra/editor-ui";

/**
 * A deck opened from a share link (gap register doc 01 S2).
 *
 * The audience's page. It has no session, no workspace, and no way into
 * anything else — the token in the URL is the entire credential, and the API
 * hands back one document and nothing about where it lives.
 *
 * Two deliberate absences:
 *
 * **No editor, ever, on this route.** A link may grant `editor`, and a colleague
 * who has one should open the real editor at `/edit/{id}` — which requires a
 * session. This page presents. Mixing the two would mean the public route had to
 * carry every editing surface, and every one of those is a place to leak a
 * workspace.
 *
 * **No sign-in prompt on failure.** A link that has expired, been revoked or was
 * never real all show the same thing, because telling a holder which it is
 * confirms that a deck exists behind the id they tried.
 */

type State =
  | { phase: "loading" }
  | { phase: "ready"; deck: SharedDocument }
  | { phase: "unavailable" };

export default function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const client = useWorkspaceClient();
  const { token } = use(params);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [presenting, setPresenting] = useState(false);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;

    client.shares
      .redeem(token)
      .then((deck) => {
        if (!cancelled) setState({ phase: "ready", deck });
      })
      .catch(() => {
        // Expired, revoked and never-existed answer alike on purpose, so there is
        // deliberately nothing here that could tell them apart.
        if (!cancelled) setState({ phase: "unavailable" });
      });

    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const measurer = useBrowserMeasurer();
  const scene: DocumentScene | null = useMemo(() => {
    if (state.phase !== "ready") return null;
    return buildDocumentScene(state.deck.document, { measurer });
  }, [state, measurer]);

  if (state.phase === "loading") {
    return (
      <main style={centred}>
        <p style={{ color: "var(--fg-subtle)" }}>Opening…</p>
      </main>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <main style={centred}>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, margin: "0 0 10px" }}>This link is not available</h1>
          {/* One message for expired, revoked and never-real alike. Which of the
              three it is would tell a holder that a deck exists behind the id
              they tried. */}
          <p style={{ color: "var(--fg-muted)", margin: 0, fontSize: 15 }}>
            It may have expired or been turned off. Ask whoever sent it for a new
            one.
          </p>
        </div>
      </main>
    );
  }

  if (presenting && scene) {
    return <PresentMode scene={scene} onExit={() => setPresenting(false)} initialSlide={selected} />;
  }

  const current = scene?.slides[selected];

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 64px" }}>
      <header
        style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 20 }}
      >
        <div>
          <h1 style={{ fontSize: 26, margin: "0 0 4px" }}>{state.deck.title}</h1>
          <p style={{ color: "var(--fg-subtle)", fontSize: 13, margin: 0 }}>
            {scene?.slides.length} slides · shared with you
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <button style={primary} onClick={() => setPresenting(true)}>
          Present
        </button>
      </header>

      {current ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "#000" }}>
          <ScaledSlide scene={current} width={1040} mode="present" />
        </div>
      ) : null}

      {/* Arrow keys work here too, so the thumbnails are a real control rather
          than a mouse-only one (WCAG 2.1 AA, 2.1.1 keyboard). */}
      <div
        role="listbox"
        aria-label="Slides"
        style={{ display: "flex", gap: 10, overflowX: "auto", padding: "18px 0" }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") setSelected((index) => Math.min(index + 1, (scene?.slides.length ?? 1) - 1));
          if (event.key === "ArrowLeft") setSelected((index) => Math.max(index - 1, 0));
        }}
      >
        {scene?.slides.map((slide, index) => (
          <button
            key={slide.slideId}
            role="option"
            aria-selected={index === selected}
            aria-label={`Slide ${index + 1}${slide.keyMessage ? `: ${slide.keyMessage}` : ""}`}
            onClick={() => setSelected(index)}
            style={{
              flex: "0 0 auto",
              padding: 0,
              border: `2px solid ${index === selected ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8,
              overflow: "hidden",
              background: "#000",
              lineHeight: 0,
            }}
          >
            <ScaledSlide scene={slide} width={168} mode="present" />
          </button>
        ))}
      </div>
    </main>
  );
}

const centred: React.CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: 24,
};

const primary: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg)",
  border: "none",
  borderRadius: 10,
  padding: "11px 22px",
  fontSize: 15,
  fontWeight: 600,
};
