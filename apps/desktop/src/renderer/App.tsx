import { useEffect, useMemo, useRef, useState } from "react";
import { buildDocumentScene } from "@deckastra/renderer";
import {
  DeckList,
  EditorShell,
  PresentMode,
  allRecoveryEntries,
  prepareToClose,
  settleWork,
  writeRecoveryEntries,
  useBrowserMeasurer,
  type DeckListCommand,
  type SubscribeHostCommands,
} from "@deckastra/editor-ui";
import { Button } from "@deckastra/editor-ui/ui";
import { AgentAccessControl } from "./AgentAccessControl";
import { FirstRunNotice } from "./FirstRunNotice";
import { IntelligenceSettings } from "./IntelligenceSettings";
import { ServiceFailure, ServiceRetry, advice, worthRetrying } from "./ServiceFailure";
import { WorkspaceClientProvider } from "@deckastra/workspace-client/react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { HostBridge, WorkspaceClient } from "@deckastra/workspace-contracts";

import type { AgentAccess, DesktopBridge, ServiceStatus } from "../shared/ipc";
import { createDesktopClient } from "./client";
import { desktopHost } from "./host";
import { desktopMotionAuthoring } from "./motion/DesktopMotionStudio";

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
  // The deck list or the open deck (editor Phase 4). Launch opens the last deck,
  // as it always has; "All decks" in the editor's bar comes here.
  const [view, setView] = useState<"editor" | "decks">("editor");
  const [openError, setOpenError] = useState<string | null>(null);
  // What the deck list should do on arrival, when New deck or Generate was chosen
  // from the menu inside a deck. Set only once the editor has let go of it.
  const [listStart, setListStart] = useState<DeckListCommand | null>(null);
  // The application menu, as the editor's `commands` prop wants it. Stable, so
  // the editor and the list subscribe once rather than on every render.
  const menuCommands = useMemo<SubscribeHostCommands>(() => (listener) => bridge.onMenuCommand(listener), [bridge]);
  // Where decks are written, and how to change it (item 19). Held here rather
  // than in either screen, because both reach it and it outlives both.
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  useEffect(
    () => bridge.onMenuCommand((command) => command === "open-intelligence" && setIntelligenceOpen(true)),
    [bridge],
  );
  // Before this window closes, every open editor saves or journals what is on
  // screen, drafts included, and says which (item 01).
  useEffect(() => bridge.onPrepareToClose(() => prepareToClose()), [bridge]);
  /**
   * A backup carries the unsaved work too (item 14).
   *
   * The recovery journals are in this window's own storage, which the service
   * taking the snapshot cannot see. Main asks; this hands over the records as
   * strings and never parses them, and puts back whatever a restore returns.
   */
  useEffect(
    () =>
      bridge.onCollectJournals(async () => {
        // The same settling a close does (item 01): a note still in its field
        // is in no journal, and it is exactly the work a backup most needs to
        // carry. Not `prepareToClose`, because nothing is closing — approving a
        // close that is not happening would let the next one skip its own ask.
        await settleWork();
        return allRecoveryEntries();
      }),
    [bridge],
  );
  useEffect(() => bridge.onRestoreJournals((entries) => void writeRecoveryEntries(entries)), [bridge]);
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

  /**
   * Open a deck from the list. The main process is told first — it owns "which
   * deck is open", because the presenter window loads that deck and the agent
   * attachment names it — and only then is the document read and the editor
   * mounted, keyed by the deck so nothing of the previous one survives.
   */
  const openDeck = (presentationId: string) => {
    setOpenError(null);
    void (async () => {
      const opened = await bridge.openPresentation({ presentationId });
      const read = await client.documents.read(opened.presentationId);
      return { presentationId: opened.presentationId, document: read.document, versionId: read.version_id };
    })().then(
      (deck) => {
        opened.current = true;
        setState({ phase: "ready", deck });
        setView("editor");
      },
      (error: unknown) => {
        // Stay on the list and say why, rather than leaving an empty editor.
        setOpenError(error instanceof Error ? error.message : "That deck could not be opened.");
      },
    );
  };

  // Before the deck is open there is nothing to protect, so a service that is not
  // ready is the whole screen.
  if (state.phase !== "ready") {
    if (service.state !== "ready") {
      return (
        <Centred>
          <ServiceNotice status={service} bridge={bridge} onStatus={setService} />
        </Centred>
      );
    }
    if (state.phase === "opening") return <Centred>Opening…</Centred>;
    return (
      <Centred>
        <p className="dk-startup__title">{state.message}</p>
        <Button
          variant="primary"
          onClick={() => {
            opened.current = false;
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </Centred>
    );
  }

  const agentControl = (
    <>
      <Button size="sm" variant="secondary" icon="ai" title="Intelligence" onClick={() => setIntelligenceOpen(true)} data-testid="open-intelligence">
        Intelligence
      </Button>
      <AgentAccessControl access={access} onChange={(allow) => void bridge.setAgentAccess({ allow }).then(setAccess)} />
    </>
  );

  const intelligence = (
    <>
    <FirstRunNotice onOpenIntelligence={() => setIntelligenceOpen(true)} />
    <IntelligenceSettings
      open={intelligenceOpen}
      onClose={() => setIntelligenceOpen(false)}
      access={access}
      onAgentAccessChange={(allow) => void bridge.setAgentAccess({ allow }).then(setAccess)}
      bridge={bridge}
    />
    </>
  );

  return (
    <WorkspaceClientProvider client={client}>
      {presenterChannel ? (
        <Presenter deck={state.deck} channelName={presenterChannel} />
      ) : (
        // A banner, never a replacement.
        //
        // Once the deck is open the editor holds the document, the undo history
        // and — the part that matters — the autosave queue of work the service
        // has not acknowledged. Swapping it for a status screen when the service
        // goes down destroys exactly the work the queue exists to protect, which
        // is the opposite of what an outage should cost. The editor already knows
        // how to fail a save and keep the edit; it only needs to stay mounted —
        // so the banner is handed to it and drawn inside its own layout.
        <>
        {intelligence}
        {view === "decks" ? (
          <DeckList
            onOpen={openDeck}
            onSetUpGeneration={() => setIntelligenceOpen(true)}
            commands={menuCommands}
            startWith={listStart}
            openPresentationId={state.deck.presentationId}
            barExtras={agentControl}
            notices={
              <>
                {service.state !== "ready" ? <ServiceBanner status={service} bridge={bridge} onStatus={setService} /> : null}
                {openError ? (
                  <div className="dk-banner dk-banner--danger" role="alert">
                    {openError}
                  </div>
                ) : null}
              </>
            }
          />
        ) : (
          <EditorShell
            // Keyed by deck: opening another one mounts a fresh editor, so no
            // undo history, queue or selection carries across decks.
            key={state.deck.presentationId}
            onExit={(next) => {
              setListStart(next ?? null);
              setView("decks");
            }}
            commands={menuCommands}
            initialDocument={state.deck.document}
            presentationId={state.deck.presentationId}
            initialVersionId={state.deck.versionId}
            openPresenter={host.openPresenterWindow}
            // A journal left by a close that could not save is replayed on the
            // next launch, not left as an anonymous copy (item 01).
            recoveryPointer="local"
            motionAuthoring={desktopMotionAuthoring}
            notices={service.state !== "ready" ? <ServiceBanner status={service} bridge={bridge} onStatus={setService} /> : null}
            barExtras={agentControl}
          />
        )}
        </>
      )}
    </WorkspaceClientProvider>
  );
}

/** An outage, reported without taking the editor away — and with the one action
 *  that might end it (item 17). The editor stays mounted either way. */
function ServiceBanner({
  status,
  bridge,
  onStatus,
}: {
  status: ServiceStatus;
  bridge: DesktopBridge;
  onStatus: (status: ServiceStatus) => void;
}) {
  return (
    <div role="status" className="dk-banner dk-banner--notice" data-testid="service-banner">
      {status.state === "failed"
        ? `The workspace service stopped. Your edits are kept here and will save when it returns. ${advice(status.kind)}`
        : "Reconnecting to the workspace service. Your edits are kept here in the meantime."}
      {status.state === "failed" && worthRetrying(status.kind) ? (
        <ServiceRetry bridge={bridge} onStatus={onStatus} />
      ) : null}
    </div>
  );
}

/** What the app says while its own backend is not answering. */
function ServiceNotice({
  status,
  bridge,
  onStatus,
}: {
  status: ServiceStatus;
  bridge: DesktopBridge;
  onStatus: (status: ServiceStatus) => void;
}) {
  // A failure is something to act on, not only something to read (item 17).
  if (status.state === "failed") return <ServiceFailure status={status} bridge={bridge} onStatus={onStatus} />;
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
    <div className="dk-root dk-startup">
      <div>{children}</div>
    </div>
  );
}
