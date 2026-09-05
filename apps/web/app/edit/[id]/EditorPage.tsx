"use client";

import { useEffect, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene } from "@deckastra/renderer";

import { EditorShell } from "../../../components/EditorShell";
import { PresentMode } from "../../../components/PresentMode";
import { browserMeasurer } from "../../../lib/measurer";
import { getSession } from "../../../lib/session";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      document: PresentationDocument;
      versionId: string;
      token: string;
      canEdit: boolean;
    };

export function EditorPage({ presentationId }: { presentationId: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { token } = await getSession();
        const response = await fetch(`${API}/v1/presentations/${presentationId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 404) {
          // The API answers 404 for both missing and forbidden, so the UI must
          // not claim to know which — saying "no permission" would leak that it
          // exists.
          throw new Error("That deck could not be found.");
        }
        if (!response.ok) throw new Error(`Could not load the deck (${response.status}).`);

        const body = await response.json();
        if (cancelled) return;

        setState({
          phase: "ready",
          document: body.document,
          versionId: body.version_id,
          token,
          canEdit: body.can_edit,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Something went wrong.",
        });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [presentationId]);

  if (state.phase === "loading") {
    return <Centered>Loading…</Centered>;
  }

  if (state.phase === "error") {
    return (
      <Centered>
        <div style={{ textAlign: "center" }}>
          <p style={{ marginBottom: 12 }}>{state.message}</p>
          <a href="/" style={{ fontSize: 14 }}>
            Back to the start
          </a>
        </div>
      </Centered>
    );
  }

  // The presenter window is this same route with `presenter=1`: it loads the
  // deck itself rather than being handed one, so it survives a reload and does
  // not depend on the audience window staying open.
  const params = new URLSearchParams(window.location.search);
  if (params.get("presenter") === "1") {
    return (
      <PresentMode
        scene={buildDocumentScene(state.document, { measurer: browserMeasurer() })}
        onExit={() => window.close()}
        presenterOnly
        channelName={params.get("channel") ?? `deckastra-present-${presentationId}`}
      />
    );
  }

  if (!state.canEdit) {
    return (
      <Centered>You have view-only access to this deck.</Centered>
    );
  }

  return (
    <EditorShell
      initialDocument={state.document}
      presentationId={presentationId}
      initialVersionId={state.versionId}
      token={state.token}
      onExit={() => {
        window.location.href = "/";
      }}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "var(--fg-muted)" }}>
      {children}
    </div>
  );
}
