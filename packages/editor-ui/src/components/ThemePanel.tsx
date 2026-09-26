"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PatchOperationSchema } from "@deckastra/presentation-schema";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { SavedTheme } from "@deckastra/workspace-contracts";
import type { EditorApi } from "../lib/useEditor";

export function ThemePanel({ editor, presentationId }: { editor: EditorApi; presentationId: string }) {
  const client = useWorkspaceClient();
  const [themes, setThemes] = useState<SavedTheme[]>([]);
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
      if (!controller.signal.aborted) setThemes(result.themes);
    }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); });
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
      const result = await list();
      if (active.current) setThemes(result.themes);
    })}>Refresh themes</button>
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
    {message ? <p role="status" className="dk-muted">{message}</p> : null}
  </section>;
}
