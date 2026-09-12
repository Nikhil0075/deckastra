import { useEffect, useMemo, useRef, useState } from "react";
import { buildDocumentScene } from "@deckastra/renderer";
import { EditorShell, PresentMode, useBrowserMeasurer } from "@deckastra/editor-ui";
import { WorkspaceClientProvider } from "@deckastra/workspace-client/react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { HostBridge, WorkspaceClient } from "@deckastra/workspace-contracts";

import type { AgentAccess, DesktopBridge, ServiceStatus } from "../shared/ipc";
import { createDesktopClient } from "./client";
import { desktopHost } from "./host";

/**
 * The desktop window.
 *
 * Two surfaces on one entry point, chosen by a query parameter, because both
 * windows load the same bundle: the editor, and the presenter view that the main
 * process opens beside it. The presenter reads the deck itself rather than being
 * handed one, so it survives a reload and does not depend on the editor window
 * staying open.
 *
 * Everything below the provider is the same code the web app mounts, now talking
 * to the same API the web app talks to. The only thing this file adds is what a
 * packaged app owes a user that a website does not: **when the backend is not
 * there, say so.** A browser tab with a dead server at least has a URL bar; a
 * blank window has nothing.
 */

interface Opened {
  presentationId: string;
  document: PresentationDocument;
  versionId: string;
}

type State =
  | { phase: "opening" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; deck: Opened };

export function App({ bridge }: { bridge: DesktopBridge }) {
  const host = useMemo<HostBridge>(() => desktopHost(bridge), [bridge]);
  const client = useMemo<WorkspaceClient>(() => createDesktopClient(), []);
  const [service, setService] = useState<ServiceStatus>({ state: "starting", attempt: 0 });
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [state, setState] = useState<State>({ phase: "opening" });
  const [attempt, setAttempt] = useState(0);
  /**
   * Whether a deck is already open.
   *
   * The service coming back is not a reason to re-read the document. Re-reading
   * remounts the editor with the server's copy, and anything still queued locally
   * — which after an outage is exactly the work that matters — goes with it. The
   * editor reconnects on its own: it retries the save, and if the server moved it
   * raises the conflict rather than guessing.
   */
  const opened = useRef(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const presenterChannel = params.get("presenter") === "1" ? params.get("channel") : null;

  useEffect(() => bridge.onServiceStatus(setService), [bridge]);
  useEffect(() => bridge.onAgentAccess(setAccess), [bridge]);

  useEffect(() => {
    // Nothing can be opened until the service is up, and trying anyway would show
    // the user a request failure for a condition the app already knows about.
    if (service.state !== "ready") return;
    // Opened once. See `opened` above for why a reconnect must not re-read.
    if (opened.current) return;

    let cancelled = false;
    setState({ phase: "opening" });

    (async () => {
      const { presentationId } = await bridge.currentPresentation();
      const read = await client.documents.read(presentationId);
      return { presentationId, document: read.document, versionId: read.version_id };
    })().then(
      (deck) => {
        if (cancelled) return;
        opened.current = true;
        setState({ phase: "ready", deck });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            phase: "failed",
            message: error instanceof Error ? error.message : "The deck could not be opened.",
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [bridge, client, service.state, attempt]);

  // Before the deck is open there is nothing to protect, so a service that is not
  // ready is the whole screen.
  if (state.phase !== "ready") {
    if (service.state !== "ready") {
      return (
        <Centred>
          <ServiceNotice status={service} />
        </Centred>
      );
    }
    if (state.phase === "opening") return <Centred>Opening…</Centred>;
    return (
      <Centred>
        <p style={{ marginBottom: 12 }}>{state.message}</p>
        <button
          onClick={() => {
            opened.current = false;
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </Centred>
    );
  }

  return (
    <WorkspaceClientProvider client={client}>
      {presenterChannel ? (
        <Presenter deck={state.deck} channelName={presenterChannel} />
      ) : (
        <>
          {/*
            A banner, never a replacement.

            Once the deck is open the editor holds the document, the undo history
            and — the part that matters — the autosave queue of work the service
            has not acknowledged. Swapping it for a status screen when the service
            goes down destroys exactly the work the queue exists to protect, which
            is the opposite of what an outage should cost. The editor already knows
            how to fail a save and keep the edit; it only needs to stay mounted.
          */}
          {service.state !== "ready" ? <ServiceBanner status={service} /> : null}
          <AgentAccessBar
            access={access}
            onChange={(allow) => void bridge.setAgentAccess({ allow }).then(setAccess)}
          />
          <EditorShell
            initialDocument={state.deck.document}
            presentationId={state.deck.presentationId}
            initialVersionId={state.deck.versionId}
            openPresenter={host.openPresenterWindow}
          />
        </>
      )}
    </WorkspaceClientProvider>
  );
}

/**
 * Whether agents may reach this install, and the switch that decides it.
 *
 * The credential an agent gets is already narrow — read, write and export, never
 * approving its own work and never minting a share link, refused by the service
 * rather than by which tools an adapter registered. But narrow is not the same as
 * asked for, so nothing is published until this says yes, and it says no on a
 * fresh install and after every update.
 *
 * It lapses after twelve hours. A permission that never expires is one nobody
 * revisits, and the honest place to say when it ends is next to the switch that
 * started it.
 */
function AgentAccessBar({
  access,
  onChange,
}: {
  access: AgentAccess | null;
  onChange: (allow: boolean) => void;
}) {
  if (!access) return null;

  const until = access.expiresAt
    ? new Date(access.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 16px",
        background: "var(--surface-alt)",
        borderBottom: "1px solid var(--border)",
        fontSize: 13,
        color: "var(--fg-subtle)",
      }}
    >
      <span role="status">
        {access.allowed
          ? `Agents can read, edit and export your decks until ${until}. They cannot approve their own changes or share a deck.`
          : "Agents cannot reach this app. Turn this on to let Claude Code or Codex work on your decks."}
      </span>
      <button
        onClick={() => onChange(!access.allowed)}
        style={{
          marginLeft: "auto",
          padding: "3px 10px",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: access.allowed ? "var(--warning)" : "var(--fg)",
          cursor: "pointer",
        }}
      >
        {access.allowed ? "Stop agent access" : "Allow agent access"}
      </button>
    </div>
  );
}

/** An outage, reported without taking the editor away. */
function ServiceBanner({ status }: { status: ServiceStatus }) {
  return (
    <div
      role="status"
      style={{
        padding: "8px 16px",
        background: "var(--surface-alt)",
        borderBottom: "1px solid var(--border)",
        color: "var(--warning)",
        fontSize: 13,
      }}
    >
      {status.state === "failed"
        ? `The workspace service stopped. Your edits are kept here and will save when it returns. ${status.detail ?? ""}`
        : "Reconnecting to the workspace service. Your edits are kept here in the meantime."}
    </div>
  );
}

/** What the app says while its own backend is not answering. */
function ServiceNotice({ status }: { status: ServiceStatus }) {
  if (status.state === "failed") {
    return (
      <div style={{ maxWidth: 520, textAlign: "center" }}>
        <p style={{ marginBottom: 8 }}>The workspace service could not start.</p>
        {/* The real reason, not a generic apology. It is the only thing that
            makes this reportable. */}
        <p style={{ color: "var(--fg-subtle)", fontSize: 13 }}>{status.detail}</p>
      </div>
    );
  }
  return (
    <p role="status">
      {status.state === "restarting"
        ? `Restarting the workspace service (attempt ${status.attempt})…`
        : "Starting the workspace service…"}
    </p>
  );
}

function Presenter({ deck, channelName }: { deck: Opened; channelName: string }) {
  const measurer = useBrowserMeasurer();
  const scene = useMemo(
    () => buildDocumentScene(deck.document, { measurer }),
    [deck.document, measurer],
  );

  return (
    <PresentMode
      scene={scene}
      onExit={() => window.close()}
      presenterOnly
      channelName={channelName}
    />
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        height: "100vh",
        color: "var(--fg-muted)",
        textAlign: "center",
      }}
    >
      <div>{children}</div>
    </div>
  );
}
