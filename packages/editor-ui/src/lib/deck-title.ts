import type { PatchOperation } from "@deckastra/presentation-schema";

/**
 * Renaming a deck (2026-10-17). A deck's name is `metadata.title`, and the
 * store copies it onto the row on every commit, so the home and every list
 * follow a rename with no route of its own: it is one ordinary operation,
 * with ordinary undo and history.
 */

/** Long enough for a real title, short enough for a card and a tab. */
export const MAX_DECK_TITLE = 200;

/** The name as it would be stored: trimmed, single-spaced, bounded. */
export function cleanDeckTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_DECK_TITLE);
}

/**
 * The one operation that renames a deck, or none when there is nothing to
 * change: an empty name keeps the old one rather than storing a blank deck
 * name, and the same name would be a version in the history that did nothing.
 */
export function renameOperations(current: string | undefined, next: string): PatchOperation[] {
  const title = cleanDeckTitle(next);
  if (!title || title === (current ?? "")) return [];
  return [{ op: "replace", path: "/metadata/title", value: title }];
}
