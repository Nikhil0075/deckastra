/**
 * How the "copies from other windows" notice reads. Pure, so tested directly.
 *
 * Presentation only: nothing here decides whether a copy can be recovered (the
 * journal's Web Lock does) and nothing here removes one.
 */

import type { RecoveryCopy } from "./editor-recovery";
import { parseServerTime, relativeTime } from "./deck-list";

export interface RecoveryGroup {
  title: string;
  copies: RecoveryCopy[];
}

const time = (copy: RecoveryCopy) => (copy.savedAt ? parseServerTime(copy.savedAt) : Number.NaN);

/**
 * Copies grouped by deck title, newest first inside a group, and groups ordered
 * by their newest copy. A copy that recorded no time sorts after every one that
 * did; ties keep the journal's own (key) order, so the list does not shuffle
 * between refreshes.
 */
export function groupRecoveryCopies(copies: readonly RecoveryCopy[]): RecoveryGroup[] {
  const newestFirst = (a: RecoveryCopy, b: RecoveryCopy) => {
    const ta = time(a);
    const tb = time(b);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  };
  const groups = new Map<string, RecoveryCopy[]>();
  for (const copy of copies) {
    const list = groups.get(copy.title) ?? [];
    list.push(copy);
    groups.set(copy.title, list);
  }
  return [...groups.entries()]
    .map(([title, list]) => ({ title, copies: [...list].sort(newestFirst) }))
    .sort((a, b) => newestFirst(a.copies[0]!, b.copies[0]!));
}

/** "3 unsaved copies from other windows" — the collapsed notice. */
export function recoverySummary(copies: readonly RecoveryCopy[]): string {
  const n = copies.length;
  return `${n} unsaved ${n === 1 ? "copy" : "copies"} from other windows`;
}

/** "Saved 5 min ago · 3 changes", or what is known when the record is older. */
export function recoveryDetail(copy: RecoveryCopy, now: number): string {
  const when = copy.savedAt ? `Saved ${relativeTime(copy.savedAt, now)}` : "Save time not recorded";
  if (copy.changes === undefined) return when;
  return `${when} · ${copy.changes} ${copy.changes === 1 ? "change" : "changes"}`;
}
