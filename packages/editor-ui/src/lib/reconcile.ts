import { PresentationDocumentSchema, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";

export type ConflictChoice = "local" | "server";
export interface MergeConflict {
  path: string;
  local: unknown;
  server: unknown;
}
export interface ConflictReview {
  base: PresentationDocument;
  local: PresentationDocument;
  server: PresentationDocument;
  serverVersionId: string;
}

/** Top-level replacements use the existing atomic transaction path. Root
 * replacement is deliberately not supported by the shared patch applier. */
export function reconciliationPatch(from: PresentationDocument, to: PresentationDocument): PatchOperation[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap(key => {
    if (equal(from[key], to[key])) return [];
    const path = `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    return [!Object.hasOwn(to, key) ? { op: "remove", path } :
      { op: Object.hasOwn(from, key) ? "replace" : "add", path, value: to[key] }] as PatchOperation[];
  });
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (object(a) && object(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

function identified(v: unknown): v is Array<Record<string, unknown> & { id: string }> {
  return Array.isArray(v) && v.every(item => object(item) && typeof item.id === "string") &&
    new Set(v.map(item => item.id)).size === v.length;
}

/** Three-way merge preserves future fields and compares id-addressed content.
 * A conflict is never silently resolved: the provisional server value is only
 * a preview, and callers must collect choices for every reported conflict.
 */
export function reconcileDocuments(
  base: PresentationDocument,
  local: PresentationDocument,
  server: PresentationDocument,
  choices: Readonly<Record<string, ConflictChoice>> = {},
): { document: PresentationDocument; conflicts: MergeConflict[]; errors: string[] } {
  const conflicts: MergeConflict[] = [];
  function choose(path: string, mine: unknown, theirs: unknown): unknown {
    conflicts.push({ path, local: mine, server: theirs });
    return choices[path] === "local" ? mine : theirs;
  }
  const child = (path: string, key: string) => `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;

  function merge(before: unknown, mine: unknown, theirs: unknown, path: string): unknown {
    if (equal(mine, theirs)) return mine;
    if (equal(mine, before)) return theirs;
    if (equal(theirs, before)) return mine;
    if (object(before) && object(mine) && object(theirs)) {
      return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(mine), ...Object.keys(theirs)])]
        .map(key => [key, merge(before[key], mine[key], theirs[key], child(path, key))] as const)
        .filter(([, value]) => value !== undefined));
    }
    if (identified(before) && identified(mine) && identified(theirs)) {
      const original = new Map(before.map(item => [item.id, item]));
      const localMap = new Map(mine.map(item => [item.id, item]));
      const serverMap = new Map(theirs.map(item => [item.id, item]));
      const values = new Map<string, unknown>();
      for (const id of new Set([...original.keys(), ...localMap.keys(), ...serverMap.keys()])) {
        const value = merge(original.get(id), localMap.get(id), serverMap.get(id), child(path, `id:${id}`));
        if (value !== undefined) values.set(id, value);
      }
      // Compare the relative order of shared original items. Independent
      // insertions/deletions do not count as competing reorder operations.
      const common = new Set(before.filter(v => localMap.has(v.id) && serverMap.has(v.id) && values.has(v.id)).map(v => v.id));
      const ordered = (items: typeof before) => items.map(v => v.id).filter(id => common.has(id));
      const initialOrder = ordered(before), localOrder = ordered(mine), serverOrder = ordered(theirs);
      const localMoved = !equal(initialOrder, localOrder), serverMoved = !equal(initialOrder, serverOrder);
      let preferred = localMoved ? mine : theirs;
      if (localMoved && serverMoved && !equal(localOrder, serverOrder)) {
        const picked = choose(child(path, "@order"), localOrder, serverOrder);
        preferred = picked === localOrder ? mine : theirs;
      }
      const order = preferred.map(v => v.id).filter(id => values.has(id));
      // Weave concurrent insertions next to their nearest surviving predecessor.
      // Both sides' additions survive, and the result is deterministic.
      for (const source of [mine, theirs]) {
        let previous: string | undefined;
        for (const item of source) {
          if (!values.has(item.id)) continue;
          if (!order.includes(item.id)) {
            const index = previous === undefined ? 0 : order.indexOf(previous) + 1;
            order.splice(index, 0, item.id);
          }
          previous = item.id;
        }
      }
      return order.map(id => values.get(id));
    }
    return choose(path || "/", mine, theirs);
  }

  const document = merge(base, local, server, "") as PresentationDocument;
  const parsed = PresentationDocumentSchema.safeParse(document);
  return { document, conflicts, errors: parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) };
}
