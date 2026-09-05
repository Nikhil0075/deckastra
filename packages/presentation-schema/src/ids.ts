import { monotonicFactory } from "ulid";
import { z } from "zod";

/**
 * Identifiers (doc 02 §0.2).
 *
 *   "{prefix}_{ULID}"   e.g. "el_01JB8Z9K2QW4RN7F3XG5HTMD6A"
 *
 * Rules that the rest of the system depends on:
 *   1. Unique within a document (validation error E001).
 *   2. Stable forever — assigned at creation, never changed by a rename or a move.
 *   3. Never reused, so undo and history stay unambiguous.
 *   4. ULID, not a counter and not UUIDv4: lexicographically sortable by creation
 *      time, which is what makes diffs and logs readable.
 *   5. Prefixes are advisory. A validator may check them; code must not parse an
 *      id for meaning beyond that.
 */
export type Id = string;

export const ID_PREFIXES = {
  document: "doc",
  slide: "sld",
  element: "el",
  animationTrack: "anm",
  animationClip: "clp",
  asset: "ast",
  component: "cmp",
  dataSource: "src",
  theme: "thm",
  transaction: "txn",
  provenance: "prv",
  /** Text blocks are addressed positionally in patches but still carry ids. */
  textBlock: "blk",
  /** Diagram nodes, edges, groups; table columns and rows. */
  node: "nd",
  edge: "edg",
  group: "grp",
  column: "col",
  row: "row",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ID_RE = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/;

const ulid = monotonicFactory();

/** Mint a new id. Monotonic within a process so a burst of creates cannot collide. */
export function newId(prefix: IdPrefix): Id {
  return `${prefix}_${ulid()}`;
}

export function isId(value: unknown): value is Id {
  return typeof value === "string" && ID_RE.test(value);
}

export function idPrefix(id: Id): string | undefined {
  const i = id.indexOf("_");
  return i > 0 ? id.slice(0, i) : undefined;
}

export function hasPrefix(id: Id, prefix: IdPrefix): boolean {
  return idPrefix(id) === prefix;
}

/** Creation time recoverable from the ULID half — useful in logs and diffs. */
export function idTimestamp(id: Id): number | undefined {
  const raw = id.slice(id.indexOf("_") + 1);
  if (!ULID_RE.test(raw)) return undefined;
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ms = 0;
  for (const ch of raw.slice(0, 10)) ms = ms * 32 + ENCODING.indexOf(ch);
  return ms;
}

export const IdSchema = z.string().regex(ID_RE, {
  message: 'Expected an id of the form "{prefix}_{ULID}", e.g. "el_01JB8Z9K2QW4RN7F3XG5HTMD6A"',
});

/** An id constrained to one prefix, for places where the kind is known. */
export function prefixedId(prefix: IdPrefix) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), {
      message: `Expected an id prefixed "${prefix}_"`,
    });
}
