import { useEffect, useMemo, useRef, useState } from "react";
import {
  PresentationDocumentSchema,
  canonicalize,
  documentHash,
  type PresentationDocument,
} from "@deckastra/presentation-schema";
import { resolveElementById } from "@deckastra/presentation-core";
import documentJsonSchema from "@deckastra/presentation-schema/generated/mydeck-document.schema.json";

import {
  CodeEditError,
  codeTextForScope,
  prepareCodeEdit,
  type CodeEditScope,
  type PreparedCodeEdit,
} from "../../lib/code-edit";
import { registerCloseParticipant } from "../../lib/close-barrier";
import { reconcileDocuments, type ConflictChoice, type MergeConflict } from "../../lib/reconcile";
import type { EditorApi } from "../../lib/useEditor";
import { portableSlideText } from "../../lib/portable-slide";
import { writeTextToClipboard } from "../../lib/write-text-clipboard";
import { Button, Section, Segmented } from "../../ui";
import { JsonCodeEditor } from "./JsonCodeEditor";
import { CodeChangePreview } from "./CodeChangePreview";

interface CodeDraftSession {
  version: 1;
  documentId: string;
  scope: CodeEditScope;
  baseDocument: PresentationDocument;
  baseJson: string;
  draft: string;
}

interface MergeReview {
  local: PresentationDocument;
  conflicts: MergeConflict[];
  choices: Record<string, ConflictChoice>;
}

type CodeViewScope = CodeEditScope["kind"] | "selection";

const DECK_JSON_SCHEMA = documentJsonSchema as Record<string, unknown>;
const schemaProperties = DECK_JSON_SCHEMA.properties as Record<string, any>;
const SLIDE_JSON_SCHEMA = {
  $schema: DECK_JSON_SCHEMA.$schema,
  $defs: DECK_JSON_SCHEMA.$defs,
  ...schemaProperties.slides.items,
} as Record<string, unknown>;
const ELEMENT_JSON_SCHEMA = {
  $schema: DECK_JSON_SCHEMA.$schema,
  $defs: DECK_JSON_SCHEMA.$defs,
  ...schemaProperties.slides.items.properties.elements.items,
} as Record<string, unknown>;

type Analysis =
  | { ok: true; edit: PreparedCodeEdit }
  | { ok: false; error: CodeEditError };

/**
 * Editable canonical JSON for the whole deck or the current slide. Text is
 * never adopted as state: it becomes a validated, id-addressed patch and then
 * uses the editor's ordinary mutation path.
 */
export function CodePanel({ editor }: { editor: EditorApi }) {
  const { document: documentOnScreen, slideIndex } = editor;
  const currentSlide = documentOnScreen.slides[slideIndex];
  const primary = editor.selection.primaryId
    ? resolveElementById(documentOnScreen, editor.selection.primaryId)?.element
    : undefined;
  const initialScope: CodeEditScope = currentSlide ? { kind: "slide", slideId: currentSlide.id } : { kind: "deck" };
  const [session, setSession] = useState<CodeDraftSession>(() =>
    loadJournal(documentOnScreen) ?? createSession(documentOnScreen, initialScope),
  );
  const [scopeKind, setScopeKind] = useState<CodeViewScope>(
    session.draft !== session.baseJson ? session.scope.kind : primary ? "selection" : session.scope.kind,
  );
  const desiredScope: CodeEditScope = scopeKind === "selection"
    ? session.scope
    : scopeKind === "deck" || !currentSlide
    ? { kind: "deck" }
    : { kind: "slide", slideId: currentSlide.id };
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [shortHash, setShortHash] = useState("");
  const [journalSafe, setJournalSafe] = useState(true);
  const [keepEditing, setKeepEditing] = useState(false);
  const [mergeReview, setMergeReview] = useState<MergeReview | null>(null);
  const [mergeMessage, setMergeMessage] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const dirty = session.draft !== session.baseJson;
  const dirtyRef = useRef(dirty);
  const journalSafeRef = useRef(journalSafe);
  dirtyRef.current = dirty;
  journalSafeRef.current = journalSafe;

  const currentHead = useMemo(() => codeTextForScope(documentOnScreen, { kind: "deck" }), [documentOnScreen]);
  const baseHead = useMemo(() => codeTextForScope(session.baseDocument, { kind: "deck" }), [session.baseDocument]);
  const desiredScopeKey = scopeKey(desiredScope);
  const stale = dirty && (currentHead !== baseHead || desiredScopeKey !== scopeKey(session.scope));

  const analysis = useMemo<Analysis>(() => {
    try {
      return { ok: true, edit: prepareCodeEdit(session.baseDocument, session.scope, session.draft) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof CodeEditError
          ? error
          : new CodeEditError(error instanceof Error ? error.message : "That JSON could not be prepared."),
      };
    }
  }, [session.baseDocument, session.draft, session.scope]);

  // A clean draft follows canvas edits, undo, current-slide navigation and
  // adopted agent changes. Dirty text keeps its base for three-way merge.
  useEffect(() => {
    if (dirty) return;
    if (currentHead === baseHead && desiredScopeKey === scopeKey(session.scope)) return;
    setSession(createSession(documentOnScreen, desiredScope));
  }, [baseHead, currentHead, desiredScope, desiredScopeKey, dirty, documentOnScreen, session.scope]);

  useEffect(() => {
    if (!dirty) {
      removeJournal(documentOnScreen.id);
      setJournalSafe(true);
      return;
    }
    setJournalSafe(saveJournal(session));
  }, [dirty, documentOnScreen.id, session]);

  useEffect(() => {
    if (scopeKind === "selection" && !primary) setScopeKind(currentSlide ? "slide" : "deck");
  }, [currentSlide, primary, scopeKind]);

  useEffect(
    () => registerCloseParticipant(async () =>
      dirtyRef.current ? (journalSafeRef.current ? "journalled" : "blocked") : "clean"),
    [],
  );

  useEffect(() => {
    let active = true;
    if (dirty || !analysis.ok || session.scope.kind !== "deck") {
      setShortHash("");
      return;
    }
    void documentHash(analysis.edit.candidate)
      .then((hash) => { if (active) setShortHash(hash.slice(0, 12)); })
      .catch(() => { if (active) setShortHash(""); });
    return () => { active = false; };
  }, [analysis, dirty, session.scope.kind]);

  const changeScope = (kind: CodeViewScope) => {
    if (dirty || kind === scopeKind) return;
    if (kind === "selection") {
      if (primary) setScopeKind("selection");
      return;
    }
    const next: CodeEditScope = kind === "slide" && currentSlide
      ? { kind: "slide", slideId: currentSlide.id }
      : { kind: "deck" };
    setScopeKind(kind);
    setSession(createSession(documentOnScreen, next));
    setCopied(null);
    setMergeMessage("");
  };

  if (scopeKind === "selection" && primary) {
    return (
      <SelectionCodeView
        editor={editor}
        element={primary}
        onScope={changeScope}
      />
    );
  }

  const discard = () => {
    const scope = desiredScope;
    setScopeKind(scope.kind);
    setSession(createSession(documentOnScreen, scope));
    setMergeReview(null);
    setMergeMessage("");
    setKeepEditing(false);
    removeJournal(documentOnScreen.id);
  };

  const apply = () => {
    if (!analysis.ok || stale || analysis.edit.operations.length === 0) return;
    const label = session.scope.kind === "deck"
      ? "Code edit · deck"
      : `Code edit · slide ${slideNumber(session.baseDocument, session.scope.slideId)}`;
    editor.apply(analysis.edit.operations, { label });
    const text = codeTextForScope(analysis.edit.candidate, session.scope);
    setSession({
      version: 1,
      documentId: analysis.edit.candidate.id,
      scope: session.scope,
      baseDocument: analysis.edit.candidate,
      baseJson: text,
      draft: text,
    });
    setCopied(null);
    setMergeMessage(analysis.edit.mintedIds.size ? `Applied · minted ${analysis.edit.mintedIds.size} id(s)` : "Applied");
    setShowPreview(false);
  };

  const beginMerge = () => {
    if (!analysis.ok) return;
    const merged = reconcileDocuments(session.baseDocument, analysis.edit.candidate, documentOnScreen);
    if (merged.errors.length) {
      setMergeMessage(merged.errors[0] ?? "The merged document is not valid.");
      return;
    }
    if (merged.conflicts.length) {
      setMergeReview({ local: analysis.edit.candidate, conflicts: merged.conflicts, choices: {} });
      setMergeMessage("");
      return;
    }
    acceptMerge(merged.document);
  };

  const finishMerge = () => {
    if (!mergeReview || mergeReview.conflicts.some((conflict) => !mergeReview.choices[conflict.path])) return;
    const merged = reconcileDocuments(session.baseDocument, mergeReview.local, documentOnScreen, mergeReview.choices);
    if (merged.errors.length) {
      setMergeMessage(merged.errors[0] ?? "The merged document is not valid.");
      return;
    }
    acceptMerge(merged.document);
  };

  const acceptMerge = (merged: PresentationDocument) => {
    const text = codeTextForScope(merged, session.scope);
    if (!text) {
      setMergeMessage("That slide was removed. Discard this draft to follow the current deck.");
      return;
    }
    setSession({
      version: 1,
      documentId: documentOnScreen.id,
      scope: session.scope,
      baseDocument: documentOnScreen,
      baseJson: codeTextForScope(documentOnScreen, session.scope),
      draft: text,
    });
    setMergeReview(null);
    setMergeMessage("Merged with the current deck. Review, then Apply.");
    setKeepEditing(false);
  };

  const copy = async () => {
    if (dirty) return;
    try {
      const text = session.scope.kind === "slide"
        ? portableSlideText(session.baseDocument, session.scope.slideId)
        : session.draft;
      await writeTextToClipboard(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };

  const summary = analysis.ok ? analysis.edit.summary : {
    operations: 0,
    added: 0,
    changed: 0,
    removed: 0,
    moved: 0,
    changedSlideIds: [],
    themeChanged: false,
    metadataChanged: false,
  };
  const canApply = analysis.ok && !stale && summary.operations > 0;
  const label = session.scope.kind === "deck"
    ? "Whole deck"
    : `Current slide · ${slideNumber(session.baseDocument, session.scope.slideId)}`;

  return (
    <div className="dk-modepanel dk-code">
      <div className="dk-code__head">
        <span className="dk-label">{label}</span>
        <span className="dk-muted">Editable JSON</span>
      </div>
      <div className="dk-code__tools">
        <Segmented
          label="Code scope"
          size="sm"
          value={scopeKind}
          onChange={changeScope}
          items={[
            { value: "deck", label: "Deck", disabled: dirty && scopeKind !== "deck" },
            { value: "slide", label: "Slide", disabled: !currentSlide || (dirty && scopeKind !== "slide") },
            { value: "selection", label: "Selection", disabled: !primary || dirty },
          ]}
        />
        <span className="dk-muted dk-code__count">{session.draft.split("\n").length} lines</span>
        <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy()} disabled={dirty} data-testid="code-copy">
          {session.scope.kind === "deck" ? "Copy deck JSON" : "Copy portable slide"}
        </Button>
        <span className="dk-muted" role="status" aria-live="polite">
          {copied === "ok" ? "Copied" : copied === "failed" ? "Could not copy" : shortHash ? `SHA-256 ${shortHash}` : ""}
        </span>
      </div>

      {stale && !keepEditing ? (
        <div className="dk-code__banner" role="alert" data-testid="code-stale">
          <div>
            <strong>The deck changed while you were typing.</strong>
            <span> Merge before Apply so neither edit is overwritten.</span>
          </div>
          <div className="dk-code__banner-actions">
            <Button size="sm" variant="primary" onClick={beginMerge} disabled={!analysis.ok}>Merge</Button>
            <Button size="sm" variant="secondary" onClick={discard}>Discard mine</Button>
            <Button size="sm" variant="ghost" onClick={() => setKeepEditing(true)}>Keep editing</Button>
          </div>
        </div>
      ) : null}

      <JsonCodeEditor
        key={scopeKey(session.scope)}
        value={session.draft}
        schema={session.scope.kind === "deck" ? DECK_JSON_SCHEMA : SLIDE_JSON_SCHEMA}
        onChange={(draft) => {
          setSession((current) => ({ ...current, draft }));
          setCopied(null);
          setMergeMessage("");
        }}
        onApply={apply}
      />

      <div className="dk-code__applybar">
        <div className="dk-code__diagnostic" aria-live="polite">
          {!analysis.ok ? (
            <span className="dk-code__error" data-testid="code-error">
              {formatError(analysis.error)}
            </span>
          ) : stale ? (
            <span>Apply is paused until this draft is merged or discarded.</span>
          ) : summary.operations === 0 ? (
            <span>No document changes.</span>
          ) : (
            <span data-testid="code-summary">
              {summary.operations} operation{summary.operations === 1 ? "" : "s"}
              {summary.changed ? ` · ${summary.changed} changed` : ""}
              {summary.added ? ` · ${summary.added} added` : ""}
              {summary.removed ? ` · ${summary.removed} removed` : ""}
              {summary.moved ? ` · ${summary.moved} moved` : ""}
            </span>
          )}
          {!journalSafe ? <span className="dk-code__error"> This draft could not be journalled; keep this window open.</span> : null}
          {mergeMessage ? <span> {mergeMessage}</span> : null}
          {analysis.ok && analysis.edit.messages.length ? <span> {analysis.edit.messages.join(" ")}</span> : null}
        </div>
        <Button size="sm" variant="secondary" onClick={discard} disabled={!dirty}>Discard</Button>
        <Button size="sm" variant="ghost" onClick={() => setShowPreview((shown) => !shown)} disabled={!analysis.ok || summary.operations === 0}>
          {showPreview ? "Hide preview" : "Preview"}
        </Button>
        <Button size="sm" variant="primary" onClick={apply} disabled={!canApply} data-testid="code-apply">
          Apply <span aria-hidden="true">Ctrl+Enter</span>
        </Button>
      </div>

      {showPreview && analysis.ok && analysis.edit.operations.length ? (
        <CodeChangePreview before={session.baseDocument} operations={analysis.edit.operations} />
      ) : null}

      {mergeReview ? (
        <div className="dk-code__conflicts" role="group" aria-label="Merge conflicts">
          <strong>Choose each conflicting field</strong>
          {mergeReview.conflicts.map((conflict) => (
            <div className="dk-code__conflict" key={conflict.path}>
              <code>{conflict.path}</code>
              <Segmented
                label={`Value for ${conflict.path}`}
                size="sm"
                value={mergeReview.choices[conflict.path] ?? ""}
                onChange={(choice) => {
                  if (choice !== "local" && choice !== "server") return;
                  setMergeReview((current) => current ? {
                    ...current,
                    choices: { ...current.choices, [conflict.path]: choice },
                  } : null);
                }}
                items={[
                  { value: "local", label: "Mine" },
                  { value: "server", label: "Current" },
                ]}
              />
            </div>
          ))}
          <Button size="sm" variant="primary" onClick={finishMerge} disabled={mergeReview.conflicts.some((conflict) => !mergeReview.choices[conflict.path])}>
            Continue merge
          </Button>
        </div>
      ) : null}

      {analysis.ok && analysis.edit.report.warnings.length ? (
        <Section title="Warnings" meta={`${analysis.edit.report.warnings.length}`}>
          <ul className="dk-code__issues">
            {analysis.edit.report.warnings.slice(0, 8).map((warning, index) => (
              <li key={`${warning.code}:${warning.path}:${index}`}>
                <code>{warning.code}</code> {warning.path}: {warning.message}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <SessionHistory editor={editor} />
    </div>
  );
}

function SelectionCodeView({
  editor,
  element,
  onScope,
}: {
  editor: EditorApi;
  element: Record<string, unknown> & { id: string; type: string };
  onScope: (scope: CodeViewScope) => void;
}) {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const json = `${JSON.stringify(canonicalize(element), null, 2)}\n`;
  const copy = async () => {
    try {
      await writeTextToClipboard(json);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="dk-modepanel dk-code">
      <div className="dk-code__head">
        <span className="dk-label">Selection · {element.type}</span>
        <span className="dk-muted">Read-only</span>
      </div>
      <div className="dk-code__tools">
        <Segmented
          label="Code scope"
          size="sm"
          value="selection"
          onChange={onScope}
          items={[
            { value: "deck", label: "Deck" },
            { value: "slide", label: "Slide" },
            { value: "selection", label: "Selection" },
          ]}
        />
        <span className="dk-muted dk-code__count">{json.split("\n").length} lines</span>
        <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy()} data-testid="code-copy">Copy element JSON</Button>
        <span className="dk-muted" role="status" aria-live="polite">
          {copied === "ok" ? "Copied" : copied === "failed" ? "Could not copy" : ""}
        </span>
      </div>
      <JsonCodeEditor
        key={element.id}
        value={json}
        schema={ELEMENT_JSON_SCHEMA}
        disabled
        onChange={() => {}}
        onApply={() => {}}
      />
      <div className="dk-code__applybar">
        <div className="dk-code__diagnostic">Edit this object in the context of its slide so references remain visible.</div>
        <Button size="sm" variant="primary" onClick={() => onScope("slide")}>Edit in slide</Button>
      </div>
      <SessionHistory editor={editor} />
    </div>
  );
}

function SessionHistory({ editor }: { editor: EditorApi }) {
  const history = editor.historyEntries ?? [];
  return (
    <Section title="This session" meta={`${history.length} changes`}>
      <ol className="dk-history">
        {history.slice(0, 20).map((entry) => (
          <li key={entry.id} className="dk-history__row">
            <span className={entry.source === "agent" ? "dk-history__who dk-history__who--agent" : "dk-history__who"}>
              {entry.source === "agent" ? "AI" : "You"}
            </span>
            <span>{entry.label}</span>
          </li>
        ))}
        {history.length === 0 ? <li className="dk-history__row">No changes yet.</li> : null}
      </ol>
    </Section>
  );
}

function createSession(document: PresentationDocument, scope: CodeEditScope): CodeDraftSession {
  const text = codeTextForScope(document, scope);
  return {
    version: 1,
    documentId: document.id,
    scope,
    baseDocument: document,
    baseJson: text,
    draft: text,
  };
}

function scopeKey(scope: CodeEditScope): string {
  return scope.kind === "deck" ? "deck" : `slide:${scope.slideId}`;
}

function slideNumber(document: PresentationDocument, slideId: string): number {
  return Math.max(1, document.slides.findIndex((slide) => slide.id === slideId) + 1);
}

function formatError(error: CodeEditError): string {
  const location = error.line ? `Line ${error.line}${error.column ? `:${error.column}` : ""} · ` : "";
  return `${location}${error.message}`;
}

function journalKey(documentId: string): string {
  return `deckastra.code-draft.${documentId}`;
}

function saveJournal(session: CodeDraftSession): boolean {
  try {
    localStorage.setItem(journalKey(session.documentId), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

function removeJournal(documentId: string): void {
  try { localStorage.removeItem(journalKey(documentId)); } catch { /* Reported on the next write. */ }
}

function loadJournal(document: PresentationDocument): CodeDraftSession | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(journalKey(document.id));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CodeDraftSession>;
    if (
      value.version !== 1 ||
      value.documentId !== document.id ||
      typeof value.baseJson !== "string" ||
      typeof value.draft !== "string" ||
      !value.scope ||
      (value.scope.kind !== "deck" && value.scope.kind !== "slide") ||
      !PresentationDocumentSchema.safeParse(value.baseDocument).success
    ) return null;
    return value as CodeDraftSession;
  } catch {
    return null;
  }
}
