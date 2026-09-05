import type { PatchOperation, PatchPath } from "@deckastra/presentation-schema";

import { PathResolutionError, readPath, resolvePath } from "./path";

/**
 * Patch application (doc 02 §31.1, §31.4).
 *
 * Two guarantees, both load-bearing:
 *
 * 1. **Atomic.** Every operation applies or none does. A partially applied patch
 *    is never a valid state, so application runs against a copy and the copy is
 *    only returned once the last operation has succeeded.
 *
 * 2. **Invertible.** The inverse is computed *during* application, against the
 *    pre-state of each operation, because that is the only moment the old value
 *    is known. Computing it afterwards from the result is not possible: a
 *    `remove` has already destroyed what it removed.
 *
 * This is the only code in the product that mutates a document. The editor and
 * the agents both go through it, which is what makes doc 01 §4.7's "human and AI
 * editing are equal citizens" true rather than aspirational.
 */

export class PatchError extends Error {
  readonly code: string;
  readonly operationIndex: number;
  readonly path?: PatchPath;

  constructor(
    message: string,
    options: { code: string; operationIndex: number; path?: PatchPath; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "PatchError";
    this.code = options.code;
    this.operationIndex = options.operationIndex;
    this.path = options.path;
  }
}

export interface ApplyResult<T> {
  /** A new document. The input is never mutated. */
  document: T;
  /**
   * Operations that undo the patch, already in the order they must be applied.
   *
   * Reversed relative to the forward operations: undoing [a, b] means undoing b
   * first, because b was applied to the state a produced. Getting this backwards
   * produces an undo that works for single-operation patches and corrupts
   * multi-operation ones, which is the kind of bug that surfaces weeks later.
   */
  inverse: PatchOperation[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (key) =>
        key in (b as object) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }

  return false;
}

function writeAt(parent: unknown, key: string | number, value: unknown): void {
  if (Array.isArray(parent)) (parent as unknown[])[key as number] = value;
  else (parent as Record<string, unknown>)[key as string] = value;
}

function readAt(parent: unknown, key: string | number): unknown {
  return Array.isArray(parent)
    ? (parent as unknown[])[key as number]
    : (parent as Record<string, unknown>)[key as string];
}

/**
 * Insert into an array at a validated index.
 *
 * The guard matters more than it looks. `splice` silently clamps an out-of-range
 * index to the end, so an operation asking for index 4 in a 3-item array
 * "succeeds" — but the resolved index recorded for the inverse is 4, which points
 * at a position that never existed. The undo then fails, and it fails later, on a
 * different document, far from the patch that caused it.
 *
 * RFC 6902 requires the index to be no greater than the array length; equal means
 * append.
 */
function insertAt(array: unknown[], index: number, value: unknown, path: PatchPath): void {
  if (index > array.length || index < 0) {
    throw new PatchError(
      `Cannot insert at index ${index}; the array holds ${array.length} item(s).`,
      { code: "E303", operationIndex: -1, path },
    );
  }
  array.splice(index, 0, value);
}

/**
 * Apply a patch, returning a new document and the operations that undo it.
 *
 * `expectedVersionId` is not checked here — that is the persistence layer's job,
 * because only it knows the current head. This function is pure.
 */
export function applyPatch<T>(document: T, operations: readonly PatchOperation[]): ApplyResult<T> {
  const draft = clone(document);
  const inverse: PatchOperation[] = [];

  operations.forEach((operation, index) => {
    try {
      applyOne(draft, operation, inverse);
    } catch (error) {
      if (error instanceof PatchError) throw error;
      if (error instanceof PathResolutionError) {
        throw new PatchError(error.message, {
          code: error.code,
          operationIndex: index,
          path: error.path,
          cause: error,
        });
      }
      throw new PatchError(
        error instanceof Error ? error.message : "Patch operation failed",
        { code: "E303", operationIndex: index, cause: error },
      );
    }
  });

  // Undo runs the inverses in reverse application order.
  inverse.reverse();

  return { document: draft, inverse };
}

/** The id of a value, when it carries one. */
function idOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function applyOne(draft: unknown, operation: PatchOperation, inverse: PatchOperation[]): void {
  switch (operation.op) {
    case "test": {
      const actual = readPath(draft, operation.path);
      if (!deepEqual(actual, operation.value)) {
        throw new PatchError(
          `test failed at ${operation.path}: the document no longer holds the expected value. ` +
            `Someone else changed it between the read and this write.`,
          { code: "E302", operationIndex: -1, path: operation.path },
        );
      }
      // A test asserts; it changes nothing, so it has no inverse.
      return;
    }

    case "add": {
      const resolved = resolvePath(draft, operation.path, { allowMissingLeaf: true });

      if (resolved.isArray) {
        insertAt(
          resolved.parent as unknown[],
          resolved.key as number,
          clone(operation.value),
          operation.path,
        );
        // The original path cannot be reused — it may have been "-" (append),
        // which names no position. Address the inverse by the added value's own
        // id where it has one, so removing it later finds the right item even if
        // siblings have shifted; fall back to the index otherwise.
        const addedId = idOf(operation.value);
        inverse.push({
          op: "remove",
          path: addedId
            ? concreteToPath([...resolved.concrete.slice(0, -1), `id:${addedId}`])
            : concreteToPath(resolved.concrete),
        });
        return;
      }

      const parent = resolved.parent as Record<string, unknown>;
      const key = resolved.key as string;
      const existed = key in parent;
      const previous = parent[key];

      parent[key] = clone(operation.value);

      // `add` onto an existing key overwrites, so its inverse restores the old
      // value rather than removing the key (RFC 6902 semantics).
      inverse.push(
        existed
          ? { op: "replace", path: operation.path, value: clone(previous) }
          : { op: "remove", path: operation.path },
      );
      return;
    }

    case "remove": {
      const resolved = resolvePath(draft, operation.path);
      const removed = clone(readAt(resolved.parent, resolved.key));

      if (resolved.isArray) {
        (resolved.parent as unknown[]).splice(resolved.key as number, 1);
      } else {
        delete (resolved.parent as Record<string, unknown>)[resolved.key as string];
      }

      // Re-adding at the concrete index restores position as well as content.
      inverse.push({ op: "add", path: concreteToPath(resolved.concrete), value: removed });
      return;
    }

    case "replace": {
      const resolved = resolvePath(draft, operation.path);
      const previous = clone(readAt(resolved.parent, resolved.key));

      writeAt(resolved.parent, resolved.key, clone(operation.value));
      // Reuse the caller's path rather than the resolved indices. A replace does
      // not move anything, so the original path still addresses the same node —
      // and if it was id-addressed, the inverse stays id-addressed, which is what
      // keeps a deferred undo from silently landing on whatever now occupies that
      // index.
      inverse.push({ op: "replace", path: operation.path, value: previous });
      return;
    }

    case "move": {
      // Resolve the source first and detach it, then resolve the destination
      // against the *already shortened* array. Resolving both up front and then
      // splicing gives an off-by-one whenever source and destination share a
      // parent and the source sits earlier — the reorder case, which is the most
      // common move there is.
      const from = resolvePath(draft, operation.from);
      const value = clone(readAt(from.parent, from.key));

      if (from.isArray) (from.parent as unknown[]).splice(from.key as number, 1);
      else delete (from.parent as Record<string, unknown>)[from.key as string];

      const to = resolvePath(draft, operation.path, { allowMissingLeaf: true });

      // The destination index is evaluated against the already-shortened array,
      // so index === length is a valid append.
      if (to.isArray) insertAt(to.parent as unknown[], to.key as number, value, operation.path);
      else (to.parent as Record<string, unknown>)[to.key as string] = value;

      inverse.push({
        op: "move",
        from: concreteToPath(to.concrete),
        path: concreteToPath(from.concrete),
      });
      return;
    }

    case "copy": {
      const from = resolvePath(draft, operation.from);
      const value = clone(readAt(from.parent, from.key));
      const to = resolvePath(draft, operation.path, { allowMissingLeaf: true });

      if (to.isArray) insertAt(to.parent as unknown[], to.key as number, value, operation.path);
      else (to.parent as Record<string, unknown>)[to.key as string] = value;

      inverse.push({ op: "remove", path: concreteToPath(to.concrete) });
      return;
    }

    default: {
      const unknownOp = (operation as { op: string }).op;
      throw new PatchError(`Unknown patch operation "${unknownOp}".`, {
        code: "E303",
        operationIndex: -1,
      });
    }
  }
}

/**
 * Build a path from resolved segments.
 *
 * Where an inverse can be id-addressed it is (see `replace` and `add` above).
 * Some cannot be: restoring a removed element has to name a *position*, and a
 * position is an index. Those inverses are only safe against the state they were
 * computed from, which is why a deferred revert must first check that no later
 * change disturbed what it targets — `History.undoLastAgentChange` and the
 * server-side revert both do.
 */
function concreteToPath(concrete: readonly (string | number)[]): PatchPath {
  return (
    "/" +
    concrete
      .map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

export { concreteToPath as _concreteToPath, deepEqual, isRecord };
