import { splitPath, type PatchPath } from "@deckastra/presentation-schema";

/**
 * Patch path resolution (doc 02 §31.3).
 *
 * A path is resolved to a concrete container and key *at apply time*, atomically
 * with the rest of the patch. That timing is the whole point of id-addressed
 * paths: an index captured when an agent read the document is stale the moment
 * anything is inserted before it, and inserting things is exactly what agents do.
 *
 *     /slides/id:sld_01JB.../elements/id:el_07/transform/x
 *     /slides/id:sld_01JB.../elements/-            (append)
 *     /theme/colors/accent
 */

export const ID_PREFIX = "id:";
export const APPEND = "-";

export class PathResolutionError extends Error {
  readonly code: string;
  readonly path: PatchPath;
  readonly segment: string;

  constructor(message: string, options: { code: string; path: PatchPath; segment: string }) {
    super(message);
    this.name = "PathResolutionError";
    this.code = options.code;
    this.path = options.path;
    this.segment = options.segment;
  }
}

export interface ResolvedPath {
  /** The object or array that directly holds the target. */
  parent: unknown;
  /** Array index, or object key. */
  key: string | number;
  /** True when the parent is an array. */
  isArray: boolean;
  /** True when the path ended in "-", i.e. append to the parent array. */
  isAppend: boolean;
  /** Concrete index path, with every `id:` segment already resolved. */
  concrete: (string | number)[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Find the index of the array member carrying `id`.
 *
 * A near-match is reported in the error because the most common cause of a
 * failure here is an agent citing an id from a stale read, and naming the closest
 * live id turns a dead end into something the caller can act on (doc 02 §31.3
 * rule 4).
 */
function indexOfId(
  container: unknown,
  id: string,
  path: PatchPath,
  segment: string,
): number {
  if (!Array.isArray(container)) {
    throw new PathResolutionError(
      `Segment "${segment}" addresses by id, but the value at that position is not an array.`,
      { code: "E301", path, segment },
    );
  }

  const index = container.findIndex(
    (item) => isRecord(item) && (item as { id?: unknown }).id === id,
  );

  if (index === -1) {
    const available = container
      .filter(isRecord)
      .map((item) => (item as { id?: unknown }).id)
      .filter((value): value is string => typeof value === "string");

    const nearest = nearestId(id, available);
    const hint = nearest
      ? ` Nearest existing id is "${nearest}".`
      : available.length === 0
        ? " The collection is empty."
        : ` Available: ${available.slice(0, 3).join(", ")}${available.length > 3 ? ", …" : ""}.`;

    throw new PathResolutionError(`No element with id "${id}".${hint}`, {
      code: "E301",
      path,
      segment,
    });
  }

  return index;
}

/** Longest shared prefix wins. Ids are ULIDs, so a shared prefix means "created
 *  at about the same time", which is usually the sibling the caller meant. */
function nearestId(target: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;

  for (const candidate of candidates) {
    let score = 0;
    while (score < target.length && score < candidate.length && target[score] === candidate[score]) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // A shared prefix shorter than the type tag says nothing useful.
  return bestScore >= 4 ? best : undefined;
}

export interface ResolveOptions {
  /** Allow the final segment to name a key that does not exist yet, as `add` does. */
  allowMissingLeaf?: boolean;
}

export function resolvePath(
  document: unknown,
  path: PatchPath,
  options: ResolveOptions = {},
): ResolvedPath {
  const segments = splitPath(path);

  if (segments.length === 0) {
    throw new PathResolutionError("The root path cannot be the target of an operation.", {
      code: "E301",
      path,
      segment: "/",
    });
  }

  let cursor: unknown = document;
  const concrete: (string | number)[] = [];

  // Walk to the parent of the final segment. Every intermediate step must exist:
  // patches do not create intermediate structure, because silently materializing
  // a missing slide would turn a typo into a data-shaped bug.
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const key = stepKey(cursor, segment, path);
    concrete.push(key);
    cursor = Array.isArray(cursor)
      ? cursor[key as number]
      : (cursor as Record<string, unknown>)[key as string];

    if (cursor === undefined) {
      throw new PathResolutionError(
        `Path stops resolving at segment "${segment}" — nothing exists there.`,
        { code: "E301", path, segment },
      );
    }
  }

  const last = segments[segments.length - 1]!;

  if (last === APPEND) {
    if (!Array.isArray(cursor)) {
      throw new PathResolutionError(
        `"-" appends to an array, but the value at this path is not an array.`,
        { code: "E301", path, segment: last },
      );
    }
    return {
      parent: cursor,
      key: cursor.length,
      isArray: true,
      isAppend: true,
      concrete: [...concrete, cursor.length],
    };
  }

  const key = stepKey(cursor, last, path, options.allowMissingLeaf);

  return {
    parent: cursor,
    key,
    isArray: Array.isArray(cursor),
    isAppend: false,
    concrete: [...concrete, key],
  };
}

function stepKey(
  container: unknown,
  segment: string,
  path: PatchPath,
  allowMissing = false,
): string | number {
  if (segment.startsWith(ID_PREFIX)) {
    return indexOfId(container, segment.slice(ID_PREFIX.length), path, segment);
  }

  if (Array.isArray(container)) {
    // Numeric indices stay valid for arrays whose members have no id — keyframes,
    // spans, blocks, gradient stops, chart rows (doc 02 §31.3 rule 2).
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0) {
      throw new PathResolutionError(
        `Segment "${segment}" indexes an array, so it must be a non-negative integer or an "id:" reference.`,
        { code: "E301", path, segment },
      );
    }
    if (!allowMissing && index >= container.length) {
      throw new PathResolutionError(
        `Index ${index} is out of range; the array holds ${container.length} item(s).`,
        { code: "E301", path, segment },
      );
    }
    return index;
  }

  if (!isRecord(container)) {
    throw new PathResolutionError(
      `Segment "${segment}" descends into a ${typeof container}, which has no properties.`,
      { code: "E301", path, segment },
    );
  }

  if (!allowMissing && !(segment in container)) {
    throw new PathResolutionError(`Property "${segment}" does not exist at this path.`, {
      code: "E301",
      path,
      segment,
    });
  }

  return segment;
}

/** Read the value a path points at, or undefined when it does not resolve. */
export function readPath(document: unknown, path: PatchPath): unknown {
  try {
    const resolved = resolvePath(document, path, { allowMissingLeaf: true });
    if (resolved.isAppend) return undefined;
    return Array.isArray(resolved.parent)
      ? resolved.parent[resolved.key as number]
      : (resolved.parent as Record<string, unknown>)[resolved.key as string];
  } catch {
    return undefined;
  }
}

/** True when a path resolves against this document. */
export function pathExists(document: unknown, path: PatchPath): boolean {
  try {
    resolvePath(document, path);
    return true;
  } catch {
    return false;
  }
}
