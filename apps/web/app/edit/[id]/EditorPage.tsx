"use client";

import { useEffect, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene } from "@deckastra/renderer";

import { EditorShell, PresentMode, isSettingsSection, useBrowserMeasurer, type SettingsSectionId } from "@deckastra/editor-ui";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import { isWorkspaceError } from "@deckastra/workspace-contracts";

import { useAccountMenu } from "../../../lib/use-account-menu";
import { WebSettings } from "../../WebSettings";


type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      document: PresentationDocument;
      versionId: string;
      canEdit: boolean;
    };

export function EditorPage({ presentationId }: { presentationId: string }) {
  const client = useWorkspaceClient();
  const measurer = useBrowserMeasurer();
  const [state, setState] = useState<State>({ phase: "loading" });
  const accountMenu = useAccountMenu();
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSectionId }>({ open: false, section: "account" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const body = await client.documents.read(presentationId);
        if (cancelled) return;

        setState({
          phase: "ready",
          document: body.document,
          versionId: body.version_id,
          canEdit: body.can_edit,
        });
      } catch (error) {
        if (isWorkspaceError(error) && error.status === 404) {
          // The API answers 404 for both missing and forbidden, so the UI must
          // not claim to know which — saying "no permission" would leak that it
          // exists.
          if (!cancelled) setState({ phase: "error", message: "That deck could not be found." });
          return;
        }
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
  }, [client, presentationId]);

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
        scene={buildDocumentScene(state.document, { measurer })}
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
    <>
      <EditorShell
        initialDocument={state.document}
        presentationId={presentationId}
        initialVersionId={state.versionId}
        // Back to the home, carrying New deck or Generate when one was chosen
        // from inside the deck; the editor has already drained its save queue.
        onExit={(next) => {
          window.location.href = next ? `/?start=${next}` : "/";
        }}
        // Settings opens over the deck rather than leaving it, so nothing waiting
        // to save is put at risk by a look at the account.
        onOpenSettings={(section) =>
          setSettings((current) => ({ open: true, section: isSettingsSection(section) ? section : current.section }))
        }
        account={accountMenu}
      />
      <WebSettings
        open={settings.open}
        onClose={() => setSettings((current) => ({ ...current, open: false }))}
        section={settings.section}
        onSection={(section) => setSettings({ open: true, section })}
      />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "var(--dk-ink-muted)", background: "var(--dk-ground)" }}>
      {children}
    </div>
  );
}
