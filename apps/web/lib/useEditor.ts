"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  newId,
  walkElements,
  type PatchOperation,
  type PresentationDocument,
} from "@deckastra/presentation-schema";
import { History, applyPatch, type EditCommand } from "@deckastra/transactions";
import {
  EMPTY_SELECTION,
  buildIndex,
  buildSelectableNodes,
  remapSelection,
  type SelectableNode,
  type SelectionState,
} from "@deckastra/editor";

/**
 * Editor state.
 *
 * The document, the history stack and the selection live here — and only the
 * first of those is ever persisted. Selection, hover and isolation are editor
 * state (doc 02 §4.1): two people opening the same deck must not fight over what
 * is selected.
 *
 * Every mutation goes through `apply`, which produces a patch, runs it through
 * the one applier, pushes an undo entry and queues a save. There is deliberately
 * no second path — an edit that skipped this would be invisible to undo and to
 * autosave both.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** How long to batch edits before persisting (doc 05 §31). */
const AUTOSAVE_DEBOUNCE_MS = 900;

export type SaveState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

export interface ApplyOptions {
  label: string;
  source?: EditCommand["source"];
  /** Merge into the previous entry when it shares this key — one gesture, one
   *  undo entry (doc 04 §29.2). */
  coalesceKey?: string;
  /** Skip persistence for a purely local change. */
  transient?: boolean;
  selectionAfter?: string[];
}

export interface EditorApi {
  document: PresentationDocument;
  slideIndex: number;
  setSlideIndex: (index: number) => void;
  selection: SelectionState;
  setSelection: (next: SelectionState | ((current: SelectionState) => SelectionState)) => void;
  apply: (operations: PatchOperation[], options: ApplyOptions) => void;
  undo: () => void;
  redo: () => void;
  undoLastAgentChange: () => { ok: boolean; message?: string };
  canUndo: boolean;
  canRedo: boolean;
  save: SaveState;
  saveNow: () => Promise<void>;
  nodes: SelectableNode[];
  historyEntries: readonly EditCommand[];
}

export interface UseEditorInput {
  initialDocument: PresentationDocument;
  presentationId: string;
  initialVersionId: string;
  token: string;
}

export function useEditor(input: UseEditorInput): EditorApi {
  const [document, setDocument] = useState(input.initialDocument);
  const [slideIndex, setSlideIndexRaw] = useState(0);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [, forceRender] = useState(0);

  const history = useRef(new History()).current;
  const versionId = useRef(input.initialVersionId);
  const pending = useRef<{ operations: PatchOperation[]; labels: string[] }>({
    operations: [],
    labels: [],
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;

  const setSlideIndex = useCallback((index: number) => {
    setSlideIndexRaw(index);
    // Selection is per-slide; carrying it across would leave the inspector
    // pointing at something that is no longer on screen.
    setSelection(EMPTY_SELECTION);
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    const batch = pending.current;
    if (batch.operations.length === 0) return;

    pending.current = { operations: [], labels: [] };
    setSave({ status: "saving" });

    try {
      const response = await fetch(`${API}/v1/presentations/${input.presentationId}/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          operations: batch.operations,
          intent: summarize(batch.labels),
          // Optimistic concurrency: the server refuses rather than silently
          // overwriting someone else's change.
          expected_version_id: versionId.current,
          client_id: "web-editor",
        }),
      });

      if (response.status === 409) {
        const body = await response.json().catch(() => ({}));
        setSave({
          status: "conflict",
          message:
            typeof body.detail === "object"
              ? (body.detail.message ?? "This deck changed elsewhere.")
              : "This deck changed elsewhere.",
        });
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = body.detail;
        setSave({
          status: "error",
          message:
            typeof detail === "string" ? detail : (detail?.message ?? `Save failed (${response.status})`),
        });
        return;
      }

      const body = await response.json();
      versionId.current = body.version_id;
      setSave({ status: "saved", at: Date.now() });
    } catch (error) {
      // The edit is still in memory and undoable; only persistence failed.
      setSave({
        status: "error",
        message: error instanceof Error ? error.message : "Could not reach the API.",
      });
    }
  }, [input.presentationId, input.token]);

  const queue = useCallback(
    (operations: PatchOperation[], label: string) => {
      pending.current.operations.push(...operations);
      pending.current.labels.push(label);
      setSave({ status: "pending" });

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const apply = useCallback(
    (operations: PatchOperation[], options: ApplyOptions) => {
      if (operations.length === 0) return;

      let result;
      try {
        result = applyPatch(documentRef.current, operations);
      } catch (error) {
        setSave({
          status: "error",
          message: error instanceof Error ? error.message : "That edit could not be applied.",
        });
        return;
      }

      const before = new Set(idsIn(documentRef.current));
      setDocument(result.document);

      history.push(
        {
          id: newId("txn"),
          source: options.source ?? "user",
          label: options.label,
          operations,
          inverseOperations: result.inverse,
          selectionBefore: selection.selectedIds,
          selectionAfter: options.selectionAfter ?? selection.selectedIds,
          timestamp: new Date().toISOString(),
        },
        { coalesceKey: options.coalesceKey },
      );

      // Ids the patch removed must not stay selected, and an element added with
      // `replacesId` inherits the selection of what it replaced (doc 04 §10.4).
      const after = idsIn(result.document);
      setSelection((current) =>
        remapSelection(current, new Set(after), replacementsIn(result.document, before)),
      );
      if (options.selectionAfter) {
        setSelection((current) => ({
          ...current,
          selectedIds: options.selectionAfter!,
          primaryId: options.selectionAfter!.at(-1),
        }));
      }

      forceRender((n) => n + 1);
      if (!options.transient) queue(operations, options.label);
    },
    [history, queue, selection.selectedIds],
  );

  const undo = useCallback(() => {
    const result = history.undo(documentRef.current);
    if (!result.ok) return;

    setDocument(result.document);
    setSelection((current) => ({ ...current, selectedIds: result.command.selectionBefore }));
    forceRender((n) => n + 1);
    queue(result.command.inverseOperations, `Undo: ${result.command.label}`);
  }, [history, queue]);

  const redo = useCallback(() => {
    const result = history.redo(documentRef.current);
    if (!result.ok) return;

    setDocument(result.document);
    setSelection((current) => ({ ...current, selectedIds: result.command.selectionAfter }));
    forceRender((n) => n + 1);
    queue(result.command.operations, `Redo: ${result.command.label}`);
  }, [history, queue]);

  const undoLastAgentChange = useCallback(() => {
    const result = history.undoLastAgentChange(documentRef.current);

    if (!result.ok) {
      if (result.reason === "empty") return { ok: false, message: "No AI changes to undo." };
      return {
        ok: false,
        // Refusing and saying why beats silently destroying the user's later work
        // to satisfy a convenience feature (doc 04 §29.3).
        message:
          "That AI change cannot be undone on its own — you have edited " +
          `${result.conflictingIds?.length ?? 0} of the same element(s) since.`,
      };
    }

    setDocument(result.document);
    forceRender((n) => n + 1);
    queue(result.command.inverseOperations, `Undo AI: ${result.command.label}`);
    return { ok: true };
  }, [history, queue]);

  // Persist on the way out, so a close mid-debounce does not lose the last edit.
  useEffect(() => {
    const onBeforeUnload = () => {
      if (pending.current.operations.length > 0) void flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  const slide = document.slides[slideIndex];

  const nodes = useMemo<SelectableNode[]>(
    () => (slide ? buildSelectableNodes(slide) : []),
    [slide],
  );

  return {
    document,
    slideIndex,
    setSlideIndex,
    selection,
    setSelection,
    apply,
    undo,
    redo,
    undoLastAgentChange,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    save,
    saveNow: flush,
    nodes,
    historyEntries: history.entries(),
  };
}

export function buildNodeIndex(nodes: SelectableNode[]) {
  return buildIndex(nodes);
}

function idsIn(document: PresentationDocument): string[] {
  const ids: string[] = [];
  for (const slide of document.slides) {
    ids.push(slide.id);
    for (const { element } of walkElements(slide.elements)) ids.push(element.id);
  }
  return ids;
}

/** Elements added by a patch that declare what they replaced (doc 02 §8.5). */
function replacementsIn(
  document: PresentationDocument,
  before: ReadonlySet<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const slide of document.slides) {
    for (const { element } of walkElements(slide.elements)) {
      const replaces = element.metadata?.replacesId;
      if (typeof replaces === "string" && !before.has(element.id)) {
        map.set(replaces, element.id);
      }
    }
  }
  return map;
}

/** One intent line for a batch of coalesced edits. */
function summarize(labels: readonly string[]): string {
  if (labels.length === 0) return "Edit";
  const unique = [...new Set(labels)];
  if (unique.length === 1) return unique[0]!;
  return `${unique[0]} and ${labels.length - 1} more change${labels.length > 2 ? "s" : ""}`;
}
