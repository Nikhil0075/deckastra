"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newId, PatchOperationSchema, ThemeDefinitionSchema } from "@deckastra/presentation-schema";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { SavedTheme } from "@deckastra/workspace-contracts";
import type { EditorApi } from "../lib/useEditor";
import { applyThemeOperations } from "../lib/theme-apply";
import { Button, Tabs } from "../ui";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeCustomise } from "./ThemeCustomise";

type ThemeTab = "gallery" | "customise" | "workspace" | "file";

/**
 * Themes (Design tab review, 2026-09-26): the built-in gallery, the
 * workspace's saved themes, and themes as files. Each applies through the
 * editor's own `apply`, so it is one change with one undo.
 */
export function ThemePanel({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const [tab, setTab] = useState<ThemeTab>("gallery");
  return (
    <Tabs
      label="Theme source"
      value={tab}
      onChange={setTab}
      className="dk-theme-tabs"
      items={[
        { value: "gallery", label: "Gallery", panel: <ThemeGallery editor={editor} /> },
        { value: "customise", label: "Customise", panel: <ThemeCustomise editor={editor} /> },
        { value: "workspace", label: "Workspace", panel: <WorkspaceThemes editor={editor} presentationId={presentationId} /> },
        { value: "file", label: "Import", panel: <ThemeFile editor={editor} presentationId={presentationId} /> },
      ]}
    />
  );
}

/**
 * A theme as a file: download this deck's, or read one someone sent.
 *
 * The file is checked against the schema before anything is applied, and a
 * refusal names what was wrong. An imported theme gets a fresh id, so two decks
 * that imported the same file are not mistaken for the same saved theme.
 */
function ThemeFile({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const client = useWorkspaceClient();
  const input = useRef<HTMLInputElement>(null);
  const office = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const readOffice = async (file: File) => {
    setMessage(undefined);
    setNotes([]);
    setBusy(true);
    try {
      const imported = await client.themes.importOffice(presentationId, file);
      editor.apply(applyThemeOperations(editor.document, imported.theme), { label: `Import the ${imported.theme.name} theme` });
      setMessage(`Imported ${imported.theme.name} from ${file.name}. Undo puts the previous theme back.`);
      setNotes(imported.notes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That file could not be read.");
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const theme = editor.document.theme;
    const blob = new Blob([JSON.stringify({ kind: "deckastra.theme", version: 1, theme }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(theme.name || "theme").replace(/[^\w.-]+/g, "-")}.theme.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const read = async (file: File) => {
    setMessage(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readText(file));
    } catch {
      setMessage("That file is not JSON, so it cannot be a theme.");
      return;
    }
    // A bare ThemeDefinition, or the envelope this panel writes.
    const candidate = (parsed as { kind?: string; theme?: unknown })?.kind === "deckastra.theme" ? (parsed as { theme: unknown }).theme : parsed;
    const result = ThemeDefinitionSchema.safeParse({ ...(candidate as object), id: newId("thm") });
    if (!result.success) {
      const first = result.error.issues[0];
      setMessage(`That file is not a theme this app can use: ${first ? `${first.path.join(".") || "the file"} ${first.message}` : "it does not match"}.`);
      return;
    }
    editor.apply(applyThemeOperations(editor.document, result.data), { label: `Import the ${result.data.name} theme` });
    setMessage(`Imported ${result.data.name}. Undo puts the previous theme back.`);
  };

  return (
    <div className="dk-themes">
      <Button size="sm" variant="ghost" icon="download" onClick={download} data-testid="theme-download">
        Download this theme
      </Button>
      <Button size="sm" variant="ghost" icon="upload" onClick={() => input.current?.click()} data-testid="theme-import">
        Import a theme file (.json)…
      </Button>
      <Button size="sm" variant="ghost" icon="upload" disabled={busy} onClick={() => office.current?.click()} data-testid="theme-import-office">
        {busy ? "Reading…" : "Import from PowerPoint (.thmx, .pptx)…"}
      </Button>
      <input
        ref={office}
        type="file"
        accept=".thmx,.pptx,.potx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        hidden
        data-testid="theme-import-office-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void readOffice(file);
        }}
      />
      <DeckThemePicker editor={editor} presentationId={presentationId} onMessage={setMessage} />
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        data-testid="theme-import-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void read(file);
        }}
      />
      {message ? (
        <p role="status" className="dk-muted">
          {message}
        </p>
      ) : null}
      {notes.length ? (
        <ul className="dk-muted dk-theme-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Take the theme another deck in the workspace uses.
 *
 * Decks are listed when the list is opened, not on mount: a workspace with
 * hundreds of decks should not pay for a list nobody asked to see.
 */
function DeckThemePicker({
  editor,
  presentationId,
  onMessage,
}: {
  editor: EditorApi;
  presentationId: string;
  onMessage: (message: string) => void;
}) {
  const client = useWorkspaceClient();
  const [decks, setDecks] = useState<{ id: string; title: string }[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const account = await client.session.account();
      const lists = await Promise.all(
        account.workspaces.flatMap((workspace) => workspace.projects.map((project) => client.documents.list(project.id))),
      );
      setDecks(lists.flat().filter((deck) => deck.id !== presentationId).map((deck) => ({ id: deck.id, title: deck.title || "Untitled deck" })));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The decks could not be listed.");
    } finally {
      setBusy(false);
    }
  };

  if (decks === null) {
    return (
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()} data-testid="theme-from-deck">
        {busy ? "Listing decks…" : "Use another deck's theme…"}
      </Button>
    );
  }
  if (decks.length === 0) return <p className="dk-muted">There are no other decks in this workspace yet.</p>;

  return (
    <div className="dk-themes__field">
      <label className="dk-label" htmlFor={`theme-deck-${presentationId}`}>
        Another deck
      </label>
      <select id={`theme-deck-${presentationId}`} className="dk-input" value={chosen} onChange={(event) => setChosen(event.target.value)}>
        <option value="">Choose a deck</option>
        {decks.map((deck) => (
          <option key={deck.id} value={deck.id}>
            {deck.title}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="secondary"
        disabled={!chosen || busy}
        data-testid="theme-from-deck-apply"
        onClick={async () => {
          setBusy(true);
          try {
            const read = await client.documents.read(chosen);
            editor.apply(applyThemeOperations(editor.document, read.document.theme), { label: `Use ${read.document.theme.name} from another deck` });
            onMessage(`Now using ${read.document.theme.name}, the theme of "${decks.find((deck) => deck.id === chosen)?.title}".`);
          } catch (error) {
            onMessage(error instanceof Error ? error.message : "That deck could not be read.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Use its theme
      </Button>
    </div>
  );
}

function WorkspaceThemes({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const client = useWorkspaceClient();
  const [themes, setThemes] = useState<SavedTheme[]>([]);
  // The list's own state, apart from the actions' messages: reading, read, or
  // could not be read (roadmap 08 rule 5).
  const [listState, setListState] = useState<"reading" | "read" | "failed">("reading");
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const active = useRef(true);
  const latestEditor = useRef(editor);
  latestEditor.current = editor;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // Presentation-scoped, so a deck in a second workspace never silently offers
  // the first workspace's themes.
  const list = useCallback(
    (signal?: AbortSignal) => client.themes.list(presentationId, signal ? { signal } : undefined),
    [client, presentationId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void list(controller.signal).then(result => {
      if (!controller.signal.aborted) { setThemes(result.themes); setListState("read"); }
    }).catch(error => { if (!controller.signal.aborted) { setListState("failed"); setMessage(error.message); } });
    return () => controller.abort();
  }, [list]);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setMessage("");
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not update the theme."); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section aria-label="Themes" className="dk-themes">
    <button className="dk-btn dk-btn--ghost dk-btn--sm" disabled={busy} onClick={() => void run(async () => {
      setListState("reading");
      try {
        const result = await list();
        if (active.current) { setThemes(result.themes); setListState("read"); }
      } catch (error) {
        if (active.current) setListState("failed");
        throw error;
      }
    })}>{listState === "failed" ? "Try again" : "Refresh themes"}</button>
    {listState === "reading" ? <p role="status" className="dk-muted">Reading this workspace's themes…</p> : null}
    {listState === "read" && themes.length === 0 ? (
      <p className="dk-muted">No saved themes in this workspace yet. Save the current one below to reuse it.</p>
    ) : null}
    <label className="dk-themes__field">
      Saved theme
      <select className="dk-input" value={selected} onChange={event => setSelected(event.target.value)} disabled={busy}>
        <option value="">Choose a theme</option>
        {themes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}{theme.is_default ? " (default)" : ""}</option>)}
      </select>
    </label>
    <button className="dk-btn dk-btn--primary dk-btn--sm" disabled={!selected || busy} onClick={() => void run(async () => {
      const documentId = latestEditor.current.document.id;
      // Read-only: the portable definition and the themeId patch are applied to
      // the local document through the editor's own `apply`, so pending edits,
      // undo and autosave all survive adopting a theme.
      const result = await client.themes.proposal(presentationId, selected);
      if (!active.current || latestEditor.current.document.id !== documentId) return;
      const operations = PatchOperationSchema.array().parse(result.operations);
      latestEditor.current.apply(operations, { label: `Apply theme ${result.theme.name}` });
    })}>Apply theme</button>
    <label className="dk-themes__field">
      Save current theme as
      <input className="dk-input" value={name} maxLength={255} onChange={event => setName(event.target.value)} disabled={busy} />
    </label>
    <small className="dk-muted">A matching name replaces that saved theme.</small>
    <label className="dk-export__option">
      <input type="checkbox" checked={makeDefault} disabled={busy} onChange={event => setMakeDefault(event.target.checked)} />
      Use as default for new decks
    </label>
    <button className="dk-btn dk-btn--secondary dk-btn--sm" disabled={!name.trim() || busy} onClick={() => void run(async () => {
      const documentId = latestEditor.current.document.id;
      const saved = await client.themes.save(presentationId, {
        name: name.trim(),
        definition: latestEditor.current.document.theme,
        is_default: makeDefault,
      });
      if (!active.current || latestEditor.current.document.id !== documentId) return;
      setThemes((current) => [...current.filter(theme => theme.id !== saved.id).map(theme => saved.is_default ? { ...theme, is_default: false } : theme), saved]);
      setSelected(saved.id); setMessage("Theme saved to this workspace.");
    })}>Save theme</button>
    {busy ? <p role="status" className="dk-muted">Updating theme…</p> : null}
    {message ? (
      listState === "failed" ? (
        <p role="alert" className="dk-export__error">The saved themes could not be read: {message}</p>
      ) : (
        <p role="status" className="dk-muted">{message}</p>
      )
    ) : null}
  </section>;
}

/** A file's text. `Blob.text()` where it exists, a FileReader where it does not. */
function readText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsText(file);
  });
}
