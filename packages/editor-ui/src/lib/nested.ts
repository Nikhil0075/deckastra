import type { PatchOperation } from "@deckastra/presentation-schema";

/**
 * `setPropertyDeep` for paths that pass through arrays (colour wizard,
 * 2026-09-26): a table's rows and cells, a diagram's nodes, edges and groups.
 *
 * A step is an object key, or an array position. A position whose item has an
 * id is written as `id:<id>` — arrays with ids are always id-addressed, because
 * an index breaks the moment an earlier item is inserted — and one without (a
 * table cell) by index. Like `setPropertyDeep`, a missing object is added around
 * the value, and `undefined` removes the property.
 */
export type Step = string | { at: number };

export function setAtOperations(root: unknown, rootPath: string, steps: Step[], value: unknown): PatchOperation[] {
  let cursor: unknown = root;
  let path = rootPath;
  for (let depth = 0; depth < steps.length; depth += 1) {
    const step = steps[depth]!;
    const last = depth === steps.length - 1;

    if (typeof step !== "string") {
      if (!Array.isArray(cursor)) throw new Error(`Expected a list at ${path}.`);
      const item = cursor[step.at] as { id?: unknown } | undefined;
      if (item === undefined) throw new Error(`Nothing at position ${step.at} of ${path}.`);
      path = `${path}/${typeof item?.id === "string" ? `id:${item.id}` : step.at}`;
      cursor = item;
      if (last) return value === undefined ? [{ op: "remove", path }] : [{ op: "replace", path, value }];
      continue;
    }

    const container = cursor as Record<string, unknown> | null;
    if (!container || typeof container !== "object") throw new Error(`Expected an object at ${path}.`);
    const segment = step.replace(/~/g, "~0").replace(/\//g, "~1");
    const exists = container[step] !== undefined;
    const here = `${path}/${segment}`;
    if (!exists) {
      if (value === undefined) return [];
      let built: unknown = value;
      for (let inner = steps.length - 1; inner > depth; inner -= 1) {
        const key = steps[inner]!;
        if (typeof key !== "string") throw new Error(`Cannot create a list position under ${here}.`);
        built = { [key]: built };
      }
      return [{ op: "add", path: here, value: built }];
    }
    if (last) {
      if (value === undefined) return [{ op: "remove", path: here }];
      if (container[step] === value) return [];
      return [{ op: "replace", path: here, value }];
    }
    path = here;
    cursor = container[step];
  }
  return [];
}
