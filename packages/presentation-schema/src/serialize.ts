import { PresentationDocumentSchema, type PresentationDocument } from "./document.js";

/**
 * Deterministic serialization (doc 01 §9.2, doc 02 §2.2).
 *
 * "The same model renders to the same output" has a prerequisite: the same model
 * must *serialize* to the same bytes. Two things threaten that.
 *
 * First, validation is not serialization. `PresentationDocumentSchema.parse()`
 * returns a reconstructed object whose key order follows the schema declaration,
 * with unknown keys appended — so parsing and re-saving an untouched deck can move
 * keys around and make every version diff noise. Parse output is for *checking*;
 * it must never be what gets persisted.
 *
 * Second, object key order is otherwise whatever the writer happened to do, which
 * differs between an editor mutation, an agent patch and a fresh generation.
 *
 * `serializeDocument` fixes both by emitting a canonical byte form: identity keys
 * first so the JSON stays readable, then everything else alphabetically, applied
 * recursively. Two documents that are deeply equal always produce identical
 * bytes, which is what makes content hashing, version diffing and byte-identical
 * render tests mean anything.
 */

/**
 * Keys floated to the top of any object that has them, in this order. Everything
 * else sorts alphabetically after. Purely for human readability — a canonical
 * form nobody can read gets replaced by one that is not canonical.
 */
const PRIORITY_KEYS = [
  "schemaVersion",
  "id",
  "type",
  "op",
  "name",
  "label",
  "title",
  "semanticRole",
  "groupRole",
  "transform",
] as const;

const priorityIndex = new Map<string, number>(PRIORITY_KEYS.map((k, i) => [k, i]));

function compareKeys(a: string, b: string): number {
  const ai = priorityIndex.get(a);
  const bi = priorityIndex.get(b);
  if (ai !== undefined && bi !== undefined) return ai - bi;
  if (ai !== undefined) return -1;
  if (bi !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively reorder object keys into canonical order. Arrays keep their order —
 * array position is load-bearing in this model (slide order, z-order, transform
 * chains, keyframe sequence), so sorting one would change the document's meaning.
 */
export function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareKeys)) {
      const v = source[key];
      // `undefined` is not representable in JSON. The schema's rule is to omit the
      // key rather than write null, so a round-trip cannot turn "absent" into
      // "explicitly null" — those mean different things to a patch.
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface SerializeOptions {
  /** Pretty-print with two spaces. Default true — documents are read by humans in
   *  diffs far more often than they are parsed by machines in a hot loop. */
  pretty?: boolean;
  /** Validate before serializing. Default false: callers that already validated
   *  should not pay for it twice. */
  validate?: boolean;
}

/** Canonical JSON bytes for a document. Deeply equal documents serialize identically. */
export function serializeDocument(
  doc: PresentationDocument,
  options: SerializeOptions = {},
): string {
  const { pretty = true, validate = false } = options;
  if (validate) PresentationDocumentSchema.parse(doc);
  const canonical = canonicalize(doc);
  return JSON.stringify(canonical, null, pretty ? 2 : undefined) + (pretty ? "\n" : "");
}

/**
 * Parse a stored document.
 *
 * Note what this deliberately returns: the raw parsed JSON, not the Zod output.
 * The Zod result is used only to confirm the document is well-formed. Returning it
 * would silently rewrite key order and drop nothing — but "drops nothing" is not
 * good enough when byte-identity is a product requirement.
 */
export function deserializeDocument(json: string): PresentationDocument {
  const raw = JSON.parse(json) as unknown;
  PresentationDocumentSchema.parse(raw);
  return raw as PresentationDocument;
}

/**
 * Stable content hash of a document, over the canonical bytes.
 *
 * Used for change detection, render-cache keys and version deduplication. It must
 * be computed from `serializeDocument` output and nothing else — hashing an
 * arbitrary JSON.stringify would make the hash depend on key insertion order.
 */
export async function documentHash(doc: PresentationDocument): Promise<string> {
  const bytes = new TextEncoder().encode(serializeDocument(doc, { pretty: false }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
