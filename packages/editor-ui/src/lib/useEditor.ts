"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  newId,
  PresentationDocumentSchema,
  walkElements,
  type PatchOperation,
  type PresentationDocument,
} from "@deckastra/presentation-schema";
import { History, applyPatch, type EditCommand } from "@deckastra/transactions";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import { isWorkspaceError, type DocumentRead } from "@deckastra/workspace-contracts";
import { openRecoveryJournal, type EditorRecovery, type RecoveryCopy, type RecoveryJournal } from "./editor-recovery";
import { reconcileDocuments, reconciliationPatch, type ConflictReview, type ConflictChoice } from "./reconcile";
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

/** How long to batch edits before persisting (doc 05 §31). */
const AUTOSAVE_DEBOUNCE_MS = 900;

export type SaveState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  /** The deck was changed outside this window and the editor took the change in. */
  | { status: "updated"; at: number }
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
  /**
   * Adopt a document the server produced, for a change applied server-side.
   *
   * Deliberately not `apply`: an agent change is already a transaction with its
   * own inverse, and re-applying it locally would create a second one.
   */
  adoptDocument: (document: PresentationDocument, versionId: string) => boolean;
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
  /**
   * Drain the autosave queue now. Resolves to whether it emptied.
   *
   * Callers that are about to let the server change the document underneath the
   * editor must await this and stop on `false`: an unsent operation is addressed
   * against the version it was authored on.
   */
  saveNow: () => Promise<boolean>;
  recoveryReady: boolean;
  recoveryCopies: RecoveryCopy[];
  refreshRecoveryCopies: () => Promise<void>;
  recoverCopy: (key: string) => Promise<void>;
  reviewConflict: () => Promise<ConflictReview>;
  resolveConflict: (review: ConflictReview, choices: Record<string, ConflictChoice>) => Promise<boolean>;
  nodes: SelectableNode[];
  historyEntries: readonly EditCommand[];
}

export interface UseEditorInput {
  initialDocument: PresentationDocument;
  presentationId: string;
  initialVersionId: string;
  /**
   * How often to ask whether the deck moved under this editor, in ms. 0 turns
   * it off. See the effect that uses it for why an editor has to ask at all.
   */
  watchHeadMs?: number;
}

export function useEditor(input: UseEditorInput): EditorApi {
  // The transport, not a token. Auth belongs to the client, so this hook works
  // unchanged against the API and against the desktop shell's local authority.
  const client = useWorkspaceClient();
  const [document, setDocument] = useState(input.initialDocument);
  const [slideIndex, setSlideIndexRaw] = useState(0);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryCopies, setRecoveryCopies] = useState<RecoveryCopy[]>([]);
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

  /**
   * Whether a save is in flight.
   *
   * Without it a second `flush` can start while the first is still on the
   * network: both carry the same `expected_version_id`, the server accepts one
   * and 409s the other, and the user is told their deck changed elsewhere when
   * nobody touched it.
   */
  const flushing = useRef(false);
  /** Bumped on every acknowledged save, so a head check that raced one is discarded. */
  const saveGeneration = useRef(0);
  const activeDrain = useRef<Promise<boolean> | null>(null);
  const adoptionConflict = useRef(false);
  const inFlight = useRef<{ operations: PatchOperation[]; labels: string[] } | null>(null);
  const journal = useRef<RecoveryJournal | null>(null);
  const recoveryBusy = useRef(true);

  const persistRecovery = useCallback(() => {
    try {
      const operations = [...(inFlight.current?.operations ?? []), ...pending.current.operations];
      const labels = [...(inFlight.current?.labels ?? []), ...pending.current.labels];
      if (!operations.length && !adoptionConflict.current) {
        if (!journal.current) throw new Error("Recovery storage unavailable");
        journal.current.write(null);
      } else {
        if (!journal.current) throw new Error("Recovery storage unavailable");
        journal.current.write({
          format: 1, versionId: versionId.current, document: documentRef.current, operations, labels,
        });
      }
    } catch {
      setSave({ status: "error", message: "Browser recovery storage is unavailable. Keep this page open until your edits are saved." });
    }
  }, [input.presentationId]);

  const setSlideIndex = useCallback((index: number) => {
    setSlideIndexRaw(index);
    // Selection is per-slide; carrying it across would leave the inspector
    // pointing at something that is no longer on screen.
    setSelection(EMPTY_SELECTION);
  }, []);

  /**
   * Send one batch. Returns whether the server took it.
   *
   * On any failure the batch goes back on the **front** of the queue: operations
   * added while the request was in flight are newer and must apply after it, and
   * a reordered patch is a different document.
   */
  const send = useCallback(
    async (batch: { operations: PatchOperation[]; labels: string[] }): Promise<boolean> => {
      const restore = (): void => {
        inFlight.current = null;
        pending.current = {
          operations: [...batch.operations, ...pending.current.operations],
          labels: [...batch.labels, ...pending.current.labels],
        };
        persistRecovery();
      };

      try {
        const result = await client.documents.commit(
          input.presentationId,
          {
            operations: batch.operations,
            intent: summarize(batch.labels),
            // Optimistic concurrency: the server refuses rather than silently
            // overwriting someone else's change.
            expected_version_id: versionId.current,
            client_id: client.clientId,
          },
          {
            // Unload cancels ordinary in-flight fetches, and a cancelled batch is
            // work the user did and cannot see was lost. Conditional because the
            // keepalive body cap is small: a large patch has to take its chances
            // with the recovery journal instead.
            keepalive:
              new TextEncoder().encode(JSON.stringify(batch.operations)).length < 60_000,
          },
        );

        versionId.current = result.version_id;
        saveGeneration.current += 1;
        inFlight.current = null;
        persistRecovery();
        if (!adoptionConflict.current) setSave({ status: "saved", at: Date.now() });
        return true;
      } catch (error) {
        if (isWorkspaceError(error) && error.status === 409) {
          // Kept, never re-sent with a refreshed version. Doing that would
          // overwrite whatever the other writer did — last-write-wins, the one
          // failure mode this persistence design exists to prevent. The work
          // stays queued so a reload-and-reapply can still save it.
          adoptionConflict.current = true;
          restore();
          setSave({
            status: "conflict",
            message:
              typeof error.detail === "object" && error.detail !== null
                ? ((error.detail as { message?: string }).message ??
                  "This deck changed elsewhere.")
                : "This deck changed elsewhere.",
          });
          return false;
        }

        // Every other refusal, and the network never delivering it at all: the
        // batch is still ours to send either way.
        restore();
        setSave({
          status: "error",
          message: error instanceof Error ? error.message : "Could not reach the API.",
        });
        return false;
      }
    },
    [client, input.presentationId, persistRecovery],
  );

  /**
   * Drain the queue.
   *
   * The rule the whole autosave path turns on: **the queue is emptied by an
   * acknowledgement, never by an attempt.** It used to be cleared before the
   * request, so a 409, a 500 or a dropped connection discarded the operations
   * permanently — and because the in-memory document still looked right, nothing
   * appeared wrong until a reload.
   *
   * A loop rather than one send, so operations queued while a request was in
   * flight go out in the same drain instead of waiting for the next debounce.
   * It stops on the first failure: retrying immediately against a server that is
   * down is a spin, and the user has a Retry button.
   */
  const flush = useCallback((): Promise<boolean> => {
    // Pending is empty while its batch is on the network. Every waiter must
    // observe the acknowledgement, including callers preparing an AI change.
    if (activeDrain.current) return activeDrain.current;
    if (recoveryBusy.current) return Promise.resolve(false);
    if (adoptionConflict.current) return Promise.resolve(false);
    if (pending.current.operations.length === 0) return Promise.resolve(true);

    flushing.current = true;
    setSave({ status: "saving" });

    const drain = (async () => { try {
      while (pending.current.operations.length > 0) {
        const batch = pending.current;
        inFlight.current = batch;
        pending.current = { operations: [], labels: [] };
        if (!(await send(batch)) || adoptionConflict.current) break;
      }
    } finally {
      flushing.current = false;
      activeDrain.current = null;
    }

    return !adoptionConflict.current && pending.current.operations.length === 0;
    })();
    activeDrain.current = drain;
    return drain;
  }, [send]);

  const queue = useCallback(
    (operations: PatchOperation[], label: string) => {
      pending.current.operations.push(...operations);
      pending.current.labels.push(label);
      setSave(current => adoptionConflict.current ? current : { status: "pending" });
      persistRecovery();

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS);
    },
    [flush, persistRecovery],
  );

  const loadRecovered = useCallback((recovered: EditorRecovery) => {
      pending.current = { operations: recovered.operations, labels: recovered.labels };
      documentRef.current = recovered.document;
      setDocument(recovered.document);
      history.clear();
      setSelection(EMPTY_SELECTION);
      setSlideIndexRaw(index => Math.max(0, Math.min(index, recovered.document.slides.length - 1)));
      const changed = recovered.versionId !== versionId.current;
      versionId.current = recovered.versionId;
      if (changed) {
        adoptionConflict.current = true;
        setSave({ status: "conflict", message: "Recovered your local work. The server has another version; review both before saving." });
      } else {
        adoptionConflict.current = false;
        setSave({ status: "pending" });
      }
  }, [history]);

  const refreshRecoveryCopies = useCallback(async () => {
    if (journal.current) setRecoveryCopies(await journal.current.copies());
  }, []);

  useEffect(() => {
    let canceled = false;
    let owned: RecoveryJournal | null = null;
    recoveryBusy.current = true;
    void (async () => {
      try {
        // React's development effect replay can cancel the first setup before
        // it acquires ownership. Do not let it steal the reload pointer.
        await Promise.resolve();
        if (canceled) return;
        owned = await openRecoveryJournal(input.presentationId);
        if (canceled) { owned.close(); return; }
        journal.current = owned;
        const recovered = owned.read();
        if (recovered) loadRecovered(recovered);
        await refreshRecoveryCopies();
      } catch (error) {
        if (!canceled) {
          setSave({ status: "error", message: error instanceof Error ? error.message : "Could not read local recovery data." });
          // Offer the original bytes for download even when schema validation
          // prevents loading the owned recovery record into the editor.
          await refreshRecoveryCopies().catch(() => {});
        }
      } finally {
        if (!canceled) { recoveryBusy.current = false; setRecoveryReady(true); }
      }
    })();
    const refresh = () => { void refreshRecoveryCopies().catch(() => {}); };
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      canceled = true;
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      // A late acknowledgement may still update this journal. Keep ownership
      // until it settles so a remount cannot clear a newer editor's work.
      const close = () => {
        owned?.close();
        if (journal.current === owned) journal.current = null;
      };
      if (activeDrain.current) void activeDrain.current.finally(close);
      else close();
    };
  }, [input.presentationId, loadRecovered, refreshRecoveryCopies]);

  const recoverCopy = useCallback(async (key: string) => {
    if (recoveryBusy.current || !journal.current) throw new Error("Recovery storage is not ready.");
    if (pending.current.operations.length || flushing.current || adoptionConflict.current) {
      throw new Error("Save or reconcile this tab's edits before opening another copy.");
    }
    recoveryBusy.current = true;
    try { loadRecovered(await journal.current.take(key)); await refreshRecoveryCopies(); }
    finally { recoveryBusy.current = false; }
  }, [loadRecovered, refreshRecoveryCopies]);

  const apply = useCallback(
    (operations: PatchOperation[], options: ApplyOptions) => {
      if (recoveryBusy.current) return;
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
      documentRef.current = result.document;
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
    if (recoveryBusy.current) return;
    const result = history.undo(documentRef.current);
    if (!result.ok) return;

    setDocument(result.document);
    documentRef.current = result.document;
    setSelection((current) => ({ ...current, selectedIds: result.command.selectionBefore }));
    forceRender((n) => n + 1);
    queue(result.command.inverseOperations, `Undo: ${result.command.label}`);
  }, [history, queue]);

  const redo = useCallback(() => {
    if (recoveryBusy.current) return;
    const result = history.redo(documentRef.current);
    if (!result.ok) return;

    setDocument(result.document);
    documentRef.current = result.document;
    setSelection((current) => ({ ...current, selectedIds: result.command.selectionAfter }));
    forceRender((n) => n + 1);
    queue(result.command.operations, `Redo: ${result.command.label}`);
  }, [history, queue]);

  const undoLastAgentChange = useCallback(() => {
    if (recoveryBusy.current) return { ok: false, message: "Recovery is still loading." };
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
    documentRef.current = result.document;
    forceRender((n) => n + 1);
    queue(result.command.inverseOperations, `Undo AI: ${result.command.label}`);
    return { ok: true };
  }, [history, queue]);

  // The journal includes active and queued work before any network send. Small
  // saves use keepalive; larger saves still survive a canceled fetch as recovery
  // data. Never start a competing unload request with a stale expected version.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!pending.current.operations.length && !inFlight.current && !adoptionConflict.current) return;
      persistRecovery();
      event.preventDefault();
      event.returnValue = "";
      if (!flushing.current && !adoptionConflict.current) void flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush, persistRecovery]);

  const slide = document.slides[slideIndex];

  const nodes = useMemo<SelectableNode[]>(
    () => (slide ? buildSelectableNodes(slide) : []),
    [slide],
  );

  /**
   * Replace the document with one the server produced.
   *
   * For an agent change, which is applied server-side and comes back whole. It
   * deliberately does *not* go through `apply`: the change is already a
   * transaction with its own inverse, and re-applying it locally would create a
   * second one. The history entry it belongs to is the server's.
   *
   * The version pointer moves with it, or the next autosave would send a stale
   * `expected_version_id` and get a 409 the user did nothing to deserve.
   *
   * A preflight save is not a lock: edits may arrive while the server works.
   * Refuse replacement in that case, retaining the document and operations.
   * Never replay them against the new server version without reconciliation.
   */
  const adoptDocument = useCallback(
    (next: PresentationDocument, nextVersionId: string) => {
      const orphaned = pending.current.operations.length;
      if (recoveryBusy.current) return false;
      if (orphaned > 0 || flushing.current || adoptionConflict.current) {
        adoptionConflict.current = true;
        persistRecovery();
        if (timer.current) clearTimeout(timer.current);
        setSave({
          status: "conflict",
          message:
            "The server changed this deck while you were editing. Your local work is still here; " +
            "the server document was not substituted. Reconcile the versions before saving.",
        });
        return false;
      }
      versionId.current = nextVersionId;
      documentRef.current = next;
      setDocument(next);
      setSelection((current) =>
        remapSelection(current, new Set(idsIn(next)), new Map()),
      );
      return true;
    },
    [persistRecovery],
  );

  /**
   * Notice when the deck changes somewhere else, and take the change in.
   *
   * An editor used to learn the head only from its own saves. That was enough
   * while it was the only writer; it stopped being enough when an agent could
   * change the deck over MCP while the user watched. The window went on showing
   * the old document, and the user's next edit met a conflict they did not
   * cause — the worst possible way to find out someone else had been there.
   *
   * A poll rather than a push. It is one row behind a cheap route, it works the
   * same through the web app's HTTP and the desktop's proxy, and it needs no
   * channel that a service restart could silently drop.
   *
   * The rule that keeps it safe: **it only ever replaces a document with nothing
   * unsaved in it.** With operations queued or in flight, it does nothing — the
   * next save carries a stale `expected_version_id`, the server refuses it, and
   * the existing conflict review handles it with the user's work intact. A
   * watcher that swapped the document under unsaved work would be the silent
   * data loss the autosave queue exists to prevent.
   *
   * Local undo is cleared on adoption. Its inverses were computed against the
   * document before the outside change, and some are index-addressed; replaying
   * one against a document that has moved is how a patch lands on the wrong
   * element. The user's own edits are already saved, so what they lose is the
   * ability to step back past someone else's change — which is the honest limit.
   */
  useEffect(() => {
    const every = input.watchHeadMs ?? 4_000;
    if (!every) return;

    let stopped = false;
    let checking = false;
    const idle = () =>
      !recoveryBusy.current &&
      !flushing.current &&
      !inFlight.current &&
      !adoptionConflict.current &&
      pending.current.operations.length === 0;

    const check = async () => {
      if (stopped || checking || !idle()) return;
      // A hidden window has nobody to show a change to, and asking anyway is a
      // request every few seconds from every background tab.
      if (globalThis.document?.visibilityState === "hidden") return;

      checking = true;
      const known = versionId.current;
      const generation = saveGeneration.current;
      // Discard the answer if this editor saved, or started to, while we asked.
      // Its own acknowledged save moves the head too, and adopting that would
      // mistake the user's edit for someone else's.
      const stillCurrent = () =>
        !stopped && idle() && saveGeneration.current === generation && versionId.current === known;

      try {
        const head = await client.documents.head(input.presentationId, { fresh: true });
        if (typeof head?.version_id !== "string" || head.version_id === known || !stillCurrent()) return;

        const read = await client.documents.read(input.presentationId, { fresh: true });
        if (typeof read?.version_id !== "string" || !stillCurrent()) return;
        // Parse to check, keep the server's bytes. The parsed object is
        // reconstructed in schema order; the served one is canonical.
        PresentationDocumentSchema.parse(read.document);

        if (adoptDocument(read.document, read.version_id)) {
          history.clear();
          setSave({ status: "updated", at: Date.now() });
        }
      } catch {
        // Offline, a restarting service, a response that did not validate: the
        // next tick asks again. None of those is worth interrupting anyone for.
      } finally {
        checking = false;
      }
    };

    const timer = setInterval(() => void check(), every);
    // Coming back to the window is exactly when a stale deck would be noticed —
    // the user has just been in a terminal telling an agent what to change.
    const onReturn = () => void check();
    window.addEventListener("focus", onReturn);
    globalThis.document?.addEventListener("visibilitychange", onReturn);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      globalThis.document?.removeEventListener("visibilitychange", onReturn);
    };
  }, [adoptDocument, client, history, input.presentationId, input.watchHeadMs]);

  const reviewConflict = useCallback(async (): Promise<ConflictReview> => {
    // Finish any earlier acknowledgement before capturing the local base. While
    // the review is open, new edits remain local and invalidate that review.
    adoptionConflict.current = true;
    if (timer.current) clearTimeout(timer.current);
    if (activeDrain.current) await activeDrain.current;
    const local = documentRef.current;
    const baseVersion = versionId.current;
    const read = async (pending: Promise<DocumentRead>) => {
      let body: DocumentRead;
      try {
        body = await pending;
      } catch {
        throw new Error("Could not load the saved versions. Your local recovery copy is intact.");
      }
      if (typeof body.version_id !== "string") throw new Error("The server returned no version identifier.");
      return { document: PresentationDocumentSchema.parse(body.document), versionId: body.version_id };
    };
    // Both reads must bypass any cache: a stale base or head turns the three-way
    // merge below into a two-way one and quietly loses whichever side it dropped.
    const [base, server] = await Promise.all([
      read(client.documents.readAt(input.presentationId, baseVersion, { fresh: true })),
      read(client.documents.read(input.presentationId, { fresh: true })),
    ]);
    return { base: base.document, local, server: server.document, serverVersionId: server.versionId };
  }, [client, input.presentationId]);

  const resolveConflict = useCallback(async (review: ConflictReview, choices: Record<string, ConflictChoice>) => {
    if (flushing.current || documentRef.current !== review.local) {
      throw new Error("You edited the deck after opening this review. Refresh the comparison to include those edits.");
    }
    const merged = reconcileDocuments(review.base, review.local, review.server, choices);
    if (merged.conflicts.some(conflict => !choices[conflict.path])) throw new Error("Choose a version for each conflict first.");
    if (merged.errors.length) throw new Error(`The combined deck is invalid: ${merged.errors[0]}`);
    const operations = reconciliationPatch(review.server, merged.document);
    // Only explicit review can move the base of recovered edits. If another
    // writer advances it again, the ordinary POST receives 409 and retains this
    // reviewed result for the next comparison.
    versionId.current = review.serverVersionId;
    documentRef.current = merged.document;
    setDocument(merged.document);
    pending.current = { operations, labels: operations.length ? ["Resolve conflicting edits"] : [] };
    adoptionConflict.current = false;
    history.clear();
    setSelection(EMPTY_SELECTION);
    setSlideIndexRaw(index => Math.max(0, Math.min(index, merged.document.slides.length - 1)));
    persistRecovery();
    if (!operations.length) {
      setSave({ status: "saved", at: Date.now() });
      return true;
    }
    return flush();
  }, [flush, history, persistRecovery]);

  return {
    document,
    adoptDocument,
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
    recoveryReady,
    recoveryCopies,
    refreshRecoveryCopies,
    recoverCopy,
    reviewConflict,
    resolveConflict,
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
