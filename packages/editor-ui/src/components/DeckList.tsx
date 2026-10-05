"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { AccountContext, AccountWorkspace, PresentationSummary } from "@deckastra/workspace-contracts";

import { useAssetUrls } from "../lib/asset-urls";
import { latestRequests } from "../lib/latest-request";
import { importDeckFile } from "../lib/import-deck";
import { loadView, viewKey, viewTitle, type DeckView, type ListedDeck } from "../lib/deck-views";
import { setThemePreference } from "../lib/chrome-theme";
import { themeForCommand, type DeckListCommand, type HostCommand, type SubscribeHostCommands } from "../lib/host-commands";
import { deckSummary, projectSummary, relativeTime, visibleDecks, type DeckSort } from "../lib/deck-list";
import { useBrowserMeasurer } from "../lib/measurer";
import {
  Button,
  Drawer,
  Icon,
  IconButton,
  Menu,
  ScrollArea,
  Select,
  StatusChip,
  TextField,
} from "../ui";
import { cx } from "../ui/cx";
import { ExportPanel } from "./ExportPanel";
import { FinalFrameSlide } from "./FinalFrameSlide";
import { CreditsMeter } from "./CreditsMeter";
import { GenerateDeck } from "./GenerateDeck";
import { CommandPalette } from "./shell/CommandPalette";
import { AccountMenu, type AccountIdentity } from "./shell/AccountMenu";

/**
 * The deck list per project (Figma: "the deck list per project").
 *
 * Projects on the left, the project's decks as cards on the right: a thumbnail
 * of the first slide, the name, "12 slides · edited 2h ago", a yellow badge when
 * proposals wait, and a menu — Open, Duplicate, Move to project…, Export,
 * Delete.
 *
 * No routing here (the package rule): `onOpen` hands a deck id to the shell,
 * which decides what opening means — the desktop tells its main process, so the
 * presenter window and an attached agent follow the deck the person opened.
 *
 * Delete is soft (the API's trash) and says so: the banner offers Undo, which
 * restores the deck with its id, history and share links.
 */

export interface DeckListProps {
  onOpen: (presentationId: string) => void;
  /** The deck the shell has open, marked on its card. */
  openPresentationId?: string;
  /** Start on the project holding this deck, when known. */
  initialProjectId?: string;
  /** Host-owned controls for the top bar (the desktop's agent-access chip). */
  barExtras?: React.ReactNode;
  /** Host-owned banners under the top bar (a service outage, a deck that would not open). */
  notices?: React.ReactNode;
  /** The host's own commands — the desktop application menu. */
  commands?: SubscribeHostCommands;
  /**
   * Open the host's generation set-up screen (the desktop's Intelligence
   * drawer). Absent in the web app, which is configured by whoever runs it.
   */
  onSetUpGeneration?: () => void;
  /**
   * Carry this out once the list can: New deck or Generate chosen from the menu
   * while a deck was open. Waits for the project to load, because there is
   * nowhere to create a deck before then.
   */
  startWith?: DeckListCommand | null;
  /** Open the host's Settings (signing in lives there on the desktop). */
  onOpenSettings?: () => void;
  /** Open a `.mydeck` file through the host's own dialog. Absent: not offered. */
  onOpenFile?: () => void;
  /** Who is signed in, and signing out, for the bar's account menu. */
  accountMenu?: { identity?: AccountIdentity | null; onSignOut?: () => void };
}

interface Located {
  workspace: AccountWorkspace;
  projectId: string;
}

export function DeckList({
  onOpen,
  openPresentationId,
  initialProjectId,
  barExtras,
  notices,
  commands,
  startWith,
  onSetUpGeneration,
  onOpenSettings,
  onOpenFile,
  accountMenu,
}: DeckListProps) {
  const client = useWorkspaceClient();
  const [account, setAccount] = useState<AccountContext | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [decks, setDecks] = useState<ListedDeck[] | null>(null);
  // What the main area shows (concept 08-home.png): one project, every deck,
  // the recent ones, or the trash. `projectId` stays the project new decks go
  // to, whichever view is showing.
  const [view, setView] = useState<DeckView | null>(initialProjectId ? { kind: "project", projectId: initialProjectId } : null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DeckSort>("recent");
  const [banner, setBanner] = useState<{ text: string; undo?: () => void; tone: "notice" | "danger" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<PresentationSummary | null>(null);
  const [exporting, setExporting] = useState<PresentationSummary | null>(null);
  const [newProject, setNewProject] = useState<string | null>(null);
  // Bumped to put the caret in the home's prompt (File › Generate).
  const [promptFocus, setPromptFocus] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [promptSeed, setPromptSeed] = useState<{ text: string; token: number } | undefined>();
  const [now, setNow] = useState(() => Date.now());

  // "edited 2h ago" should not stay "just now" all afternoon.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      const next = await client.session.account({ fresh: true });
      setAccount(next);
      setAccountError(null);
      return next;
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Your workspaces could not be read.");
      return null;
    }
  }, [client]);

  useEffect(() => {
    void loadAccount().then((next) => {
      if (!next) return;
      const first = next.workspaces.flatMap((workspace) => workspace.projects)[0]?.id ?? null;
      setProjectId((current) => current ?? first);
      setView((current) => current ?? (first ? { kind: "project", projectId: first } : null));
    });
  }, [loadAccount]);

  const located = useMemo<Located | null>(() => {
    if (!account || !projectId) return null;
    for (const workspace of account.workspaces) {
      if (workspace.projects.some((project) => project.id === projectId)) return { workspace, projectId };
    }
    return null;
  }, [account, projectId]);
  const project = located?.workspace.projects.find((candidate) => candidate.id === projectId);

  // The project on screen *now*, read when a load starts and again when it
  // answers. Refreshes run after a duplicate, a delete, an undo or a move, any of
  // which can finish after the person has moved to another project, and an undo
  // button can be pressed long after the closure behind it was made.
  const selectedView = useRef(view);
  selectedView.current = view;
  const accountRef = useRef(account);
  accountRef.current = account;
  const requests = useRef(latestRequests());

  const loadDecks = useCallback(async () => {
    const asked = selectedView.current;
    const known = accountRef.current;
    if (!asked || !known) return;
    const current = requests.current.begin();
    // Current only if nothing newer was asked for *and* the answer is still for
    // the view on screen. The second half is not implied by the first: a
    // refresh can be the newest request and still be for a view the person
    // has since left, if they left without anything asking for the new one yet.
    const stillWanted = () => current() && selectedView.current !== null && viewKey(selectedView.current) === viewKey(asked);
    try {
      const listed = await loadView(client, known, asked, { fresh: true });
      if (!stillWanted()) return;
      setDecks(listed);
      setListError(null);
    } catch (error) {
      if (!stillWanted()) return;
      setListError(error instanceof Error ? error.message : "These decks could not be read.");
    }
  }, [client]);

  const shownView = view ? viewKey(view) : null;
  useEffect(() => {
    // A new view starts from "loading", never from the last one's cards or
    // its error.
    setDecks(null);
    setListError(null);
    void loadDecks();
  }, [loadDecks, shownView, account]);

  const showProject = (id: string) => {
    setProjectId(id);
    setView({ kind: "project", projectId: id });
  };

  // The trash keeps its own order, most recently deleted first: "recent" there
  // means when it was thrown away, not when it was last edited.
  const shown = useMemo(() => {
    const listed = decks ?? [];
    if (view?.kind !== "trash" || sort !== "recent") return visibleDecks(listed, query, sort);
    const kept = new Set(visibleDecks(listed, query, sort));
    return listed.filter((deck) => kept.has(deck));
  }, [decks, query, sort, view]);

  // ---------------------------------------------------------------- actions

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setBanner({ tone: "danger", text: error instanceof Error ? error.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  };

  // Opening a `.mydeck` file. The host's own dialog where it has one (the
  // desktop's main process); otherwise the browser's file picker and the
  // service's import, where the client offers one (the web app).
  const fileInput = useRef<HTMLInputElement>(null);
  const browserImport = !onOpenFile && Boolean(client.imports);
  const openFile = onOpenFile ?? (browserImport ? () => fileInput.current?.click() : undefined);
  const importFile = (file: File) =>
    run(async () => {
      if (!projectId) return;
      setBanner({ tone: "notice", text: `Opening “${file.name}”…` });
      const outcome = await importDeckFile(client, projectId, file);
      if (outcome.kind === "failed") {
        setBanner({ tone: "danger", text: outcome.message });
        return;
      }
      setBanner(null);
      onOpen(outcome.presentationId);
    });

  const createDeck = () =>
    run(async () => {
      if (!projectId) return;
      const created = await client.documents.create({ title: "Untitled presentation", project_id: projectId });
      onOpen(created.presentation_id);
    });

  const duplicate = (deck: PresentationSummary) =>
    run(async () => {
      const copy = await client.documents.duplicate(deck.id);
      setBanner({ tone: "notice", text: `Duplicated as “${copy.title}”.` });
      await loadDecks();
    });

  const remove = (deck: PresentationSummary) =>
    run(async () => {
      await client.documents.delete(deck.id);
      setBanner({
        tone: "notice",
        text: `Deleted “${deck.title}”.`,
        undo: () =>
          void run(async () => {
            await client.documents.restore(deck.id);
            setBanner({ tone: "notice", text: `Restored “${deck.title}”.` });
            await loadDecks();
          }),
      });
      await loadDecks();
    });

  const restoreDeck = (deck: PresentationSummary) =>
    run(async () => {
      await client.documents.restore(deck.id);
      setBanner({ tone: "notice", text: `Restored “${deck.title}”.` });
      await loadDecks();
    });

  const createProject = () =>
    run(async () => {
      const name = newProject?.trim();
      if (!name || !located) return;
      const created = await client.session.createProject(located.workspace.id, name);
      setNewProject(null);
      await loadAccount();
      showProject(created.id);
    });

  // ------------------------------------------------------------------ render

  const editable = located ? located.workspace.role !== "viewer" : false;

  // The menu's commands. A ref for the same reason as the editor's: one
  // subscription per host, a handler that sees the current project.
  const onCommand = useRef<(command: HostCommand) => void>(() => {});
  onCommand.current = (command) => {
    const theme = themeForCommand(command);
    if (theme) setThemePreference(theme);
    else if (command === "new-deck" && editable && !busy) void createDeck();
    else if (command === "generate-deck" && editable) {
      if (view?.kind === "trash") setView(projectId ? { kind: "project", projectId } : { kind: "all" });
      setPromptFocus((count) => count + 1);
    } else if (command === "all-decks") setView({ kind: "all" });
    else if (command === "open-settings") onOpenSettings?.();
    else if (command === "command-palette") setPaletteOpen(true);
  };
  // Ctrl+K on the home too (roadmap 08 §1.5), so the palette is one key
  // wherever someone is. Typing in a field still gets Ctrl+K: there is no
  // field here where it means anything else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => commands?.((command) => onCommand.current(command)), [commands]);
  const started = useRef(false);
  useEffect(() => {
    if (!startWith || started.current || !editable || !projectId) return;
    started.current = true;
    onCommand.current(startWith);
  }, [startWith, editable, projectId]);

  return (
    <div className="dk-root dk-decks" data-testid="deck-list">
      <header className="dk-decks__bar">
        <span className="dk-brand" aria-hidden="true" />
        <h1 className="dk-appbar__title">
          <span className="dk-appbar__product">{located?.workspace.name ?? "Deckastra"}</span>
          <span className="dk-appbar__sep" aria-hidden="true">
            /
          </span>
          <span className="dk-appbar__deck">{project?.name ?? "Decks"}</span>
        </h1>
        <span className="dk-decks__search">
          <Icon name="search" size={14} />
          <TextField
            label="Search decks"
            hideLabel
            placeholder="Search decks"
            value={query}
            onChange={setQuery}
            data-testid="deck-search"
          />
        </span>
        <span className="dk-decks__bar-end">
          {barExtras}
          <AccountMenu {...accountMenu} onOpenSettings={onOpenSettings} />
        </span>
      </header>

      {notices}

      <div className="dk-decks__body">
        <nav className="dk-decks__projects" aria-label="Decks and projects">
          <ul className="dk-decks__project-list dk-decks__views">
            {(
              [
                { kind: "all", label: "All decks", icon: "grid" },
                { kind: "recent", label: "Recent", icon: "history" },
              ] as const
            ).map((entry) => (
              <li key={entry.kind}>
                <button
                  type="button"
                  className={cx("dk-decks__project", view?.kind === entry.kind && "dk-decks__project--current")}
                  aria-current={view?.kind === entry.kind ? "true" : undefined}
                  onClick={() => setView({ kind: entry.kind })}
                  data-testid={`view-${entry.kind}`}
                >
                  <Icon name={entry.icon} size={14} />
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
          {accountError ? <p className="dk-decks__error">{accountError}</p> : null}
          {account?.workspaces.map((workspace) => (
            <section key={workspace.id} className="dk-decks__workspace">
              <span className="dk-label">
                {workspace.name}
                {workspace.origin === "cloud" ? " · synced" : ""}
              </span>
              <ul className="dk-decks__project-list">
                {workspace.projects.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      className={cx("dk-decks__project", view?.kind === "project" && candidate.id === view.projectId && "dk-decks__project--current")}
                      aria-current={view?.kind === "project" && candidate.id === view.projectId ? "true" : undefined}
                      onClick={() => showProject(candidate.id)}
                    >
                      {candidate.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {newProject === null ? (
            <Button variant="ghost" size="sm" icon="plus" onClick={() => setNewProject("")} disabled={!located || !editable}>
              New project
            </Button>
          ) : (
            <form
              className="dk-decks__new-project"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <TextField label="Project name" value={newProject} onChange={setNewProject} autoFocus />
              <span className="dk-decks__new-project-actions">
                <Button size="sm" variant="primary" type="submit" disabled={!newProject.trim() || busy}>
                  Create
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewProject(null)}>
                  Cancel
                </Button>
              </span>
            </form>
          )}
          <button
            type="button"
            className={cx("dk-decks__project", "dk-decks__trash", view?.kind === "trash" && "dk-decks__project--current")}
            aria-current={view?.kind === "trash" ? "true" : undefined}
            onClick={() => setView({ kind: "trash" })}
            data-testid="view-trash"
          >
            <Icon name="trash" size={14} />
            Trash
          </button>
          {/* The plan card (concept 08-home.png): what AI help has left this
              month, at the foot of the projects. Absent without an account. */}
          <div className="dk-decks__plan">
            <CreditsMeter variant="card" onOpenSettings={onOpenSettings} />
          </div>
        </nav>

        <main className="dk-decks__main">
          {projectId && view?.kind !== "trash" ? (
            // The home's prompt bar (roadmap 08 §1.3): every new deck starts
            // here, described or blank. One per project: nothing typed or
            // paused for one project is shown under another (item 02).
            <GenerateDeck
              key={projectId}
              onClose={() => {}}
              projectId={projectId}
              workspaceId={located?.workspace.id}
              reviewAvailable={account?.capabilities.checkpoints === true}
              generation={account?.capabilities.generation}
              onSetUp={onSetUpGeneration}
              onGenerated={onOpen}
              onBlank={() => void createDeck()}
              blankDisabled={busy}
              disabled={!editable}
              focusToken={promptFocus}
              seed={promptSeed}
              onOpenFile={openFile}
            />
          ) : null}
          {browserImport ? (
            <input
              ref={fileInput}
              type="file"
              accept=".mydeck"
              hidden
              data-testid="open-deck-file-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file again still opens it.
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
          ) : null}
          <div className="dk-decks__heading">
            <div>
              <h2 className="dk-decks__title">{view ? viewTitle(view, account) : "Decks"}</h2>
              <p className="dk-muted">
                {!decks
                  ? "Loading…"
                  : view?.kind === "trash"
                    ? decks.length === 0
                      ? "Empty"
                      : `${decks.length} deleted deck${decks.length === 1 ? "" : "s"} · restore any of them`
                    : projectSummary(decks, now)}
              </p>
            </div>
            <Select
              label="Sort"
              hideLabel
              value={sort}
              onChange={setSort}
              options={[
                { value: "recent", label: "Sort: Recent" },
                { value: "name", label: "Sort: Name" },
              ]}
            />
          </div>

          {banner ? (
            <div className={cx("dk-banner", banner.tone === "danger" ? "dk-banner--danger" : "dk-banner--notice", "dk-decks__banner")} role="status">
              <span>{banner.text}</span>
              {banner.undo ? (
                <Button size="sm" variant="secondary" onClick={banner.undo} data-testid="undo-delete">
                  Undo
                </Button>
              ) : null}
              <IconButton icon="close" label="Dismiss" size="sm" onClick={() => setBanner(null)} />
            </div>
          ) : null}

          {listError ? <p className="dk-decks__error">{listError}</p> : null}

          <ScrollArea className="dk-decks__scroll">
            {decks && decks.length === 0 ? (
              <div className="dk-decks__empty">
                <span className="dk-accent-rule" aria-hidden="true" />
                <p>
                  {view?.kind === "trash"
                    ? "Nothing in the trash. Decks you delete wait here until you restore them."
                    : view?.kind === "project"
                      ? "No decks in this project yet. Describe one above, or start from a blank deck."
                      : "No decks yet. Describe one above, or start from a blank deck."}
                </p>
              </div>
            ) : null}
            {decks && decks.length > 0 && shown.length === 0 ? (
              <p className="dk-muted dk-decks__empty">No decks match “{query}”.</p>
            ) : null}
            <ul className="dk-decks__grid">
              {shown.map((deck) =>
                view?.kind === "trash" ? (
                  <li key={deck.id}>
                    <TrashCard deck={deck} now={now} onRestore={() => void restoreDeck(deck)} disabled={busy || !deck.editable} />
                  </li>
                ) : (
                <li key={deck.id}>
                  <DeckCard
                    deck={deck}
                    now={now}
                    open={deck.id === openPresentationId}
                    editable={deck.editable}
                    where={view?.kind === "project" ? undefined : deck.projectName}
                    onOpen={() => onOpen(deck.id)}
                    onDuplicate={() => void duplicate(deck)}
                    onMove={() => setMoving(deck)}
                    onExport={() => setExporting(deck)}
                    onDelete={() => void remove(deck)}
                  />
                </li>
                ),
              )}
            </ul>
          </ScrollArea>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        place="home"
        canExit
        canOpenSettings={Boolean(onOpenSettings)}
        onClose={() => setPaletteOpen(false)}
        onCommand={(command) => {
          setPaletteOpen(false);
          onCommand.current(command);
        }}
        onAsk={(text) => {
          setPaletteOpen(false);
          if (view?.kind === "trash") setView(projectId ? { kind: "project", projectId } : { kind: "all" });
          setPromptSeed((current) => ({ text, token: (current?.token ?? 0) + 1 }));
        }}
      />

      <MoveDialog
        deck={moving}
        account={account}
        fromProjectId={moving && "projectId" in moving ? (moving as ListedDeck).projectId : projectId}
        onClose={() => setMoving(null)}
        onMoved={(message) => {
          setMoving(null);
          setBanner({ tone: "notice", text: message });
          void loadDecks();
        }}
      />

      <Drawer
        open={exporting !== null}
        onClose={() => setExporting(null)}
        title="Export"
        meta={exporting?.title}
        modal
        width={420}
      >
        {exporting ? <ExportPanel key={exporting.id} presentationId={exporting.id} /> : null}
      </Drawer>
    </div>
  );
}

// ----------------------------------------------------------------------- card

function DeckCard({
  deck,
  now,
  open,
  editable,
  where,
  onOpen,
  onDuplicate,
  onMove,
  onExport,
  onDelete,
}: {
  deck: PresentationSummary;
  now: number;
  open: boolean;
  editable: boolean;
  /** The project, in views that mix projects. */
  where?: string;
  onOpen: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const pending = deck.pending_proposals ?? 0;
  return (
    <article className={cx("dk-card", open && "dk-card--open")} data-testid="deck-card" data-deck-id={deck.id}>
      <button type="button" className="dk-card__thumb" onClick={onOpen} aria-label={`Open ${deck.title}`}>
        <DeckThumbnail presentationId={deck.id} versionId={deck.version_id} />
      </button>
      <span className="dk-card__menu">
        <Menu
          label={`${deck.title} actions`}
          align="end"
          trigger={(props) => (
            <IconButton icon="more" label={`${deck.title} actions`} size="sm" variant="secondary" data-testid="deck-menu" {...props} />
          )}
          items={[
            { id: "open", label: "Open", onSelect: onOpen },
            { id: "duplicate", label: "Duplicate", icon: "duplicate", disabled: !editable, onSelect: onDuplicate },
            { id: "move", label: "Move to project…", disabled: !editable, onSelect: onMove },
            { id: "export", label: "Export", icon: "download", onSelect: onExport },
            { id: "delete", label: "Delete", icon: "trash", danger: true, disabled: !editable, onSelect: onDelete },
          ]}
        />
      </span>
      <div className="dk-card__meta">
        <span className="dk-card__title" title={deck.title}>
          {deck.title}
        </span>
        {pending > 0 ? (
          <StatusChip tone="waiting" title={`${pending} change${pending === 1 ? "" : "s"} waiting for review`}>
            {pending} pending
          </StatusChip>
        ) : null}
        {open ? <StatusChip tone="neutral">Open</StatusChip> : null}
      </div>
      <p className="dk-card__summary">{where ? `${where} · ${deckSummary(deck, now)}` : deckSummary(deck, now)}</p>
    </article>
  );
}

/**
 * A deck in the trash. No thumbnail: every read treats a deleted deck as
 * missing, which is the point of deleting it, so its slides cannot be drawn
 * until it is restored.
 */
function TrashCard({ deck, now, onRestore, disabled }: { deck: ListedDeck; now: number; onRestore: () => void; disabled: boolean }) {
  return (
    <article className="dk-card dk-card--trash" data-testid="trash-card" data-deck-id={deck.id}>
      <div className="dk-card__thumb dk-card__thumb--empty" aria-hidden="true">
        <Icon name="trash" size={20} />
      </div>
      <div className="dk-card__meta">
        <span className="dk-card__title" title={deck.title}>
          {deck.title}
        </span>
        <Button size="sm" variant="secondary" onClick={onRestore} disabled={disabled} data-testid="restore-deck">
          Restore
        </Button>
      </div>
      <p className="dk-card__summary">
        {deck.projectName} · deleted {relativeTime(deck.deleted_at, now)}
      </p>
    </article>
  );
}

/** Documents read for thumbnails, by id and version, for the life of the page. */
const thumbnailCache = new Map<string, PresentationDocument>();

/**
 * The deck's first slide, drawn by the same renderer as everything else. Read
 * only once the card scrolls into view, and cached by version: a project of
 * forty decks should not read forty documents to show the first eight.
 */
function DeckThumbnail({ presentationId, versionId }: { presentationId: string; versionId: string | null }) {
  const client = useWorkspaceClient();
  const box = useRef<HTMLSpanElement | null>(null);
  const key = `${presentationId}@${versionId ?? "none"}`;
  const [document, setDocument] = useState<PresentationDocument | null>(() => thumbnailCache.get(key) ?? null);
  const [visible, setVisible] = useState(false);
  // The card's width, measured: ScaledSlide scales the slide from the width it
  // is given, so stretching its box with CSS would leave the slide the wrong size.
  const [width, setWidth] = useState(0);
  const measurer = useBrowserMeasurer();

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const resolveAssetUrl = useAssetUrls(document);

  useEffect(() => {
    const node = box.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || document) return;
    let cancelled = false;
    client.documents
      .read(presentationId)
      .then((read) => {
        thumbnailCache.set(key, read.document);
        if (!cancelled) setDocument(read.document);
      })
      .catch(() => {
        // A card without a picture is still a card; the name and actions work.
      });
    return () => {
      cancelled = true;
    };
  }, [client, document, key, presentationId, visible]);

  const first = useMemo(() => {
    if (!document) return null;
    return buildDocumentScene(document, { measurer }).slides[0] ?? null;
  }, [document, measurer]);

  return (
    <span ref={box} className="dk-card__frame">
      {first && width > 0 ? (
        <FinalFrameSlide scene={first} width={width} resolveAssetUrl={resolveAssetUrl} />
      ) : (
        <span className="dk-card__placeholder" aria-hidden="true" />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------- move

function MoveDialog({
  deck,
  account,
  fromProjectId,
  onClose,
  onMoved,
}: {
  deck: PresentationSummary | null;
  account: AccountContext | null;
  fromProjectId: string | null;
  onClose: () => void;
  onMoved: (message: string) => void;
}) {
  const client = useWorkspaceClient();
  const options = useMemo(
    () =>
      (account?.workspaces ?? [])
        .filter((workspace) => workspace.role !== "viewer")
        .flatMap((workspace) =>
          workspace.projects
            .filter((project) => project.id !== fromProjectId)
            .map((project) => ({
              value: project.id,
              // Where a deck is going is the whole decision: a synced workspace
              // is the moment it stops being private to this machine.
              label: `${workspace.name} / ${project.name}${workspace.origin === "cloud" ? " (synced)" : ""}`,
            })),
        ),
    [account, fromProjectId],
  );
  const [target, setTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTarget(options[0]?.value ?? "");
    setError(null);
  }, [deck, options]);

  return (
    <Drawer
      open={deck !== null}
      onClose={onClose}
      title="Move to project"
      meta={deck?.title}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!target || busy}
            data-testid="confirm-move"
            onClick={() => {
              if (!deck || !target) return;
              setBusy(true);
              setError(null);
              client.documents
                .move(deck.id, target)
                .then(() => onMoved(`Moved “${deck.title}” to ${options.find((option) => option.value === target)?.label ?? "the project"}.`))
                // The API names why a move is refused (pending proposals,
                // shared pictures, editor rights on both sides); say it as is.
                .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The deck could not be moved."))
                .finally(() => setBusy(false));
            }}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="dk-decks__move">
        {options.length === 0 ? (
          <p className="dk-muted">There is no other project you can move this deck to. Create one first.</p>
        ) : (
          <Select label="Destination" value={target} options={options} onChange={setTarget} />
        )}
        <p className="dk-muted">
          The deck keeps its id, its history and its share links. It will need no pending changes, and every picture it
          uses must be used by no other deck.
        </p>
        {error ? (
          <p className="dk-decks__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
