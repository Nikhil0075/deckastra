import { splitPath, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";

import { applyPatch } from "./apply";
import { ID_PREFIX } from "./path";

/**
 * History (doc 04 §29).
 *
 * Manual edits and AI transactions share one stack. That is the point: if AI
 * edits lived in a separate history, "undo" would mean different things depending
 * on what you last did, which is exactly the confusion doc 01 §3.7 identifies.
 *
 * This stack is a session convenience, not the record. The durable history is the
 * `transactions` table; losing this on a refresh loses nothing but convenience.
 */

export interface EditCommand {
  id: string;
  source: "user" | "agent" | "system";
  /** Shown in the UI: "Move 3 objects", "AI: simplify slide 6". */
  label: string;
  operations: PatchOperation[];
  inverseOperations: PatchOperation[];
  selectionBefore: string[];
  selectionAfter: string[];
  timestamp: string;
  /** Links back to the durable transaction, when there is one. */
  transactionId?: string;
}

/** In-memory cap (doc 04 §29.4). Oldest entries drop first. */
export const DEFAULT_LIMIT = 200;

/** Typing coalesces into one entry until this much idle time passes (doc 04 §29.2). */
export const COALESCE_IDLE_MS = 800;

export interface PushOptions {
  /**
   * Merge into the previous entry instead of creating a new one, when the
   * previous entry shares this key and is recent enough.
   *
   * One user gesture is one undo entry: a drag emits ~300 pointermove events and
   * must produce a single entry, or undo becomes useless.
   */
  coalesceKey?: string;
  now?: number;
}

export interface UndoBlocked {
  ok: false;
  reason: "empty" | "overlapping-later-edit";
  /** The entry that could not be undone, when there was one. */
  command?: EditCommand;
  /** Element ids a later edit also touched. */
  conflictingIds?: string[];
}

export interface UndoApplied {
  ok: true;
  command: EditCommand;
  document: PresentationDocument;
}

export type UndoResult = UndoApplied | UndoBlocked;

/**
 * Every id an operation's paths mention, including ancestors.
 *
 * Useful for "what did this change involve" — provenance, activity feeds, cache
 * invalidation. Not the right set for conflict detection: see `targetIds`.
 */
export function touchedIds(operations: readonly PatchOperation[]): Set<string> {
  const ids = new Set<string>();

  const collect = (path: string): void => {
    for (const segment of splitPath(path)) {
      if (segment.startsWith(ID_PREFIX)) ids.add(segment.slice(ID_PREFIX.length));
    }
  };

  for (const operation of operations) {
    collect(operation.path);
    if (operation.op === "move" || operation.op === "copy") collect(operation.from);
  }

  return ids;
}

/**
 * The innermost id each operation actually addresses.
 *
 * This is half of what conflict detection needs; `disturbs` combines it with
 * `touchedIds`. Using every id in the path on both sides instead would make two
 * edits to different elements on the same slide "overlap" — because both paths
 * mention the slide — which would block essentially every AI-specific undo and
 * quietly turn the feature off.
 */
export function targetIds(operations: readonly PatchOperation[]): Set<string> {
  const ids = new Set<string>();

  const innermost = (path: string): string | undefined => {
    const segments = splitPath(path);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]!;
      if (segment.startsWith(ID_PREFIX)) return segment.slice(ID_PREFIX.length);
    }
    return undefined;
  };

  for (const operation of operations) {
    const target = innermost(operation.path);
    if (target) ids.add(target);
    if (operation.op === "move" || operation.op === "copy") {
      const source = innermost(operation.from);
      if (source) ids.add(source);
    }
  }

  return ids;
}

/**
 * Ids where `later` would make undoing `earlier` unsafe.
 *
 * The rule is asymmetric on purpose, and both halves are needed:
 *
 * * `later`'s target appearing anywhere in `earlier`'s paths catches containment
 *   — deleting a slide disturbs every edit made inside it.
 * * `earlier`'s target appearing anywhere in `later`'s paths catches the reverse
 *   — a later edit reaching into what the earlier one changed.
 *
 * Comparing every mentioned id against every mentioned id would instead make any
 * two edits on the same slide conflict, because both paths name the slide.
 *
 * Mirrored in `deckastra_api.patch.disturbs`; the server applies the same rule
 * before a deferred revert.
 */
export function disturbs(
  earlier: readonly PatchOperation[],
  later: readonly PatchOperation[],
): Set<string> {
  const earlierMentioned = touchedIds(earlier);
  const earlierTargets = targetIds(earlier);
  const laterMentioned = touchedIds(later);
  const laterTargets = targetIds(later);

  const out = new Set<string>();
  for (const id of laterTargets) if (earlierMentioned.has(id)) out.add(id);
  for (const id of earlierTargets) if (laterMentioned.has(id)) out.add(id);
  return out;
}

export class History {
  private readonly undoStack: EditCommand[] = [];
  private readonly redoStack: EditCommand[] = [];
  private lastPush = 0;
  private lastCoalesceKey?: string;

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** Newest first. */
  entries(): readonly EditCommand[] {
    return [...this.undoStack].reverse();
  }

  peek(): EditCommand | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  push(command: EditCommand, options: PushOptions = {}): void {
    const now = options.now ?? Date.now();
    const previous = this.undoStack[this.undoStack.length - 1];

    const mergeable =
      previous !== undefined &&
      options.coalesceKey !== undefined &&
      options.coalesceKey === this.lastCoalesceKey &&
      previous.source === command.source &&
      now - this.lastPush < COALESCE_IDLE_MS;

    if (mergeable && previous) {
      // Forward operations concatenate; inverses prepend, because undoing the
      // merged entry must undo the later operation first.
      previous.operations = [...previous.operations, ...command.operations];
      previous.inverseOperations = [
        ...command.inverseOperations,
        ...previous.inverseOperations,
      ];
      previous.selectionAfter = command.selectionAfter;
      previous.timestamp = command.timestamp;
    } else {
      this.undoStack.push(command);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }

    // Any new edit invalidates the redo branch: redoing after diverging would
    // replay operations against a document that no longer matches the state they
    // were computed from.
    this.redoStack.length = 0;
    this.lastPush = now;
    this.lastCoalesceKey = options.coalesceKey;
  }

  undo(document: PresentationDocument): UndoResult {
    const command = this.undoStack.pop();
    if (!command) return { ok: false, reason: "empty" };

    const { document: next } = applyPatch(document, command.inverseOperations);
    this.redoStack.push(command);
    this.lastCoalesceKey = undefined;

    return { ok: true, command, document: next };
  }

  redo(document: PresentationDocument): UndoResult {
    const command = this.redoStack.pop();
    if (!command) return { ok: false, reason: "empty" };

    const { document: next } = applyPatch(document, command.operations);
    this.undoStack.push(command);
    this.lastCoalesceKey = undefined;

    return { ok: true, command, document: next };
  }

  /**
   * Undo the most recent AI change specifically (doc 01 §4.2, doc 04 §29.3).
   *
   * Walks back to the newest `agent` entry and inverts it — but only if no later
   * entry touched the same elements. When one did, this refuses and says which,
   * because silently reverting an element the user has since edited by hand
   * destroys their work to satisfy a convenience feature.
   */
  undoLastAgentChange(document: PresentationDocument): UndoResult {
    const index = this.undoStack.findLastIndex((entry) => entry.source === "agent");
    if (index === -1) return { ok: false, reason: "empty" };

    const command = this.undoStack[index]!;

    const conflicting = new Set<string>();
    for (let i = index + 1; i < this.undoStack.length; i += 1) {
      for (const id of disturbs(command.operations, this.undoStack[i]!.operations)) {
        conflicting.add(id);
      }
    }

    if (conflicting.size > 0) {
      return {
        ok: false,
        reason: "overlapping-later-edit",
        command,
        conflictingIds: [...conflicting],
      };
    }

    let next: PresentationDocument;
    try {
      next = applyPatch(document, command.inverseOperations).document;
    } catch {
      // Belt and braces: the overlap rule above should have caught this, but an
      // inverse that no longer resolves must never become a thrown error on a
      // routine "can I undo this" question.
      return {
        ok: false,
        reason: "overlapping-later-edit",
        command,
        conflictingIds: [...targetIds(command.operations)],
      };
    }
    this.undoStack.splice(index, 1);
    this.lastCoalesceKey = undefined;

    // Deliberately not pushed onto the redo stack: this was an out-of-order undo,
    // and a redo stack that can reinsert an entry into the middle of history is a
    // reordering bug waiting to happen.
    return { ok: true, command, document: next };
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastCoalesceKey = undefined;
  }
}
