import { PatchOperationSchema, PresentationDocumentSchema, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";

export interface EditorRecovery {
  format: 1;
  versionId: string;
  document: PresentationDocument;
  operations: PatchOperation[];
  labels: string[];
  /**
   * When this journal was last written (ISO 8601 UTC). Optional, and stamped by
   * the journal rather than by callers: records written before it existed stay
   * readable and simply cannot say when they were saved.
   */
  savedAt?: string;
}

export function recoveryKey(presentationId: string, owner?: string): string {
  const prefix = `deckastra.editor-recovery.v1:${presentationId}`;
  return owner ? `${prefix}:${owner}` : prefix;
}

export function recoveryPointer(presentationId: string): string {
  return `deckastra.editor-recovery.owner:${presentationId}`;
}

/** Every key this module owns: the journals themselves and their pointers. */
const RECOVERY_PREFIX = "deckastra.editor-recovery.";

export interface RecoveryEntry {
  key: string;
  value: string;
}

/**
 * Every recovery record in this origin's storage, for a backup to carry
 * (desktop item 14).
 *
 * Read as **strings**, not parsed. A backup that understood the format would be
 * a second description of it, and this one has already been through a version
 * bump; carrying bytes means a journal written by a newer build survives a
 * backup taken by an older one. The pointers travel too, because a journal
 * whose owner pointer is missing comes back as an anonymous copy in a collapsed
 * list rather than as the work someone was in the middle of.
 *
 * Storage that refuses to be read answers empty. Backing up the decks is worth
 * more than failing over the unsaved edits.
 */
export function allRecoveryEntries(): RecoveryEntry[] {
  const entries: RecoveryEntry[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(RECOVERY_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries.push({ key, value });
    }
  } catch {
    return [];
  }
  return entries;
}

/**
 * Put recovery records back after a restore, and say how many landed.
 *
 * Only this module's own keys are written, whatever arrived: the entries have
 * crossed two process boundaries, and "it came from our own backup" is a claim
 * about where a file has been rather than about what is in it.
 */
export function writeRecoveryEntries(entries: readonly RecoveryEntry[]): number {
  let written = 0;
  for (const entry of entries) {
    if (!entry?.key?.startsWith(RECOVERY_PREFIX) || typeof entry.value !== "string") continue;
    try {
      localStorage.setItem(entry.key, entry.value);
      written += 1;
    } catch {
      // A full quota stops this one record, not the rest: a partial recovery is
      // strictly better than none, and the decks are already back either way.
    }
  }
  return written;
}

function parseRecovery(raw: string): EditorRecovery {
  const saved = JSON.parse(raw) as EditorRecovery;
  if (!saved || saved.format !== 1 || typeof saved.versionId !== "string" ||
      !Array.isArray(saved.operations) || !Array.isArray(saved.labels)) {
    throw new Error("This saved recovery record cannot be read. It has been left intact.");
  }
  if (saved.labels.some(label => typeof label !== "string")) throw new Error("Invalid recovery labels.");
  // A malformed timestamp costs the copy its time, never the copy.
  if (saved.savedAt !== undefined && (typeof saved.savedAt !== "string" || !Number.isFinite(Date.parse(saved.savedAt)))) {
    delete saved.savedAt;
  }
  return { ...saved, document: PresentationDocumentSchema.parse(saved.document),
    operations: saved.operations.map(operation => PatchOperationSchema.parse(operation)) };
}

export function readRecovery(presentationId: string, owner?: string): EditorRecovery | null {
  const raw = localStorage.getItem(recoveryKey(presentationId, owner));
  if (!raw) return null;
  // Treat browser storage as untrusted input. A future field still survives
  // through the schema's loose objects; malformed known elements do not.
  return parseRecovery(raw);
}

export interface RecoveryCopy {
  key: string;
  title: string;
  active: boolean;
  error?: string;
  /** From the record, when it recorded one. */
  savedAt?: string;
  /** Edits in the copy that never reached the server. */
  changes?: number;
}

const lockName = (key: string) => `deckastra.recovery-lock:${key}`;

/** A tab's sessionStorage can be cloned by Duplicate Tab. The browser lock,
 * not that pointer, grants ownership. Never share an unlocked writable journal.
 * Without Web Locks every mount uses a fresh key and recovery is explicit. */
async function lock(key: string): Promise<(() => void) | null> {
  if (!navigator.locks) return () => {};
  return new Promise((resolve, reject) => {
    void navigator.locks.request(lockName(key), { ifAvailable: true }, held => {
      if (!held) { resolve(null); return; }
      return new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}

export interface RecoveryJournal {
  key: string;
  read: () => EditorRecovery | null;
  write: (record: EditorRecovery | null) => void;
  copies: () => Promise<RecoveryCopy[]>;
  take: (key: string) => Promise<EditorRecovery>;
  close: () => void;
}

/**
 * Where the pointer to "this editor's journal" is kept.
 *
 * `session` (the default, and the web's): per tab, so a reload finds its journal
 * and a new tab starts its own. `local`: survives the process ending — the
 * desktop's, where a window that closed or an app that quit while a save could
 * not finish must find its journal on the next launch rather than leave it as an
 * anonymous copy in a collapsed list (final package review, item 01). The lock
 * below still keeps a second window off a journal the first one holds.
 */
export type RecoveryPointerStore = "session" | "local";

export async function openRecoveryJournal(
  presentationId: string,
  { pointer = "session" }: { pointer?: RecoveryPointerStore } = {},
): Promise<RecoveryJournal> {
  const prefix = recoveryKey(presentationId);
  const pointers = (): Storage => (pointer === "local" ? localStorage : sessionStorage);
  let owner: string | null = null;
  // A missing session store must not prevent unique local recovery copies.
  try { owner = navigator.locks ? pointers().getItem(recoveryPointer(presentationId)) : null; } catch { /* fresh owner */ }
  if (owner && !/^[a-zA-Z0-9-]+$/.test(owner)) owner = null;
  let release = owner ? await lock(recoveryKey(presentationId, owner)) : null;
  if (!release) {
    owner = crypto.randomUUID();
    release = await lock(recoveryKey(presentationId, owner));
  }
  if (!release || !owner) throw new Error("Could not open a separate recovery journal.");
  const key = recoveryKey(presentationId, owner);
  try { pointers().setItem(recoveryPointer(presentationId), owner); } catch { /* explicit recovery remains available */ }
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("This recovery journal is closed."); };
  const read = () => { assertOpen(); const raw = localStorage.getItem(key); return raw ? parseRecovery(raw) : null; };
  const write = (record: EditorRecovery | null) => {
    assertOpen();
    // An unreadable record is never replaced by an unrelated edit.
    const previous = localStorage.getItem(key);
    if (previous) parseRecovery(previous);
    if (record) localStorage.setItem(key, JSON.stringify({ ...record, savedAt: new Date().toISOString() }));
    else localStorage.removeItem(key);
  };
  return {
    key, read, write,
    async copies() {
      assertOpen();
      const held = navigator.locks ? (await navigator.locks.query()).held ?? [] : [];
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      return keys.filter((item): item is string => !!item && (item === prefix || item.startsWith(`${prefix}:`)))
        .sort().flatMap((item): RecoveryCopy[] => {
          const raw = localStorage.getItem(item);
          if (!raw) return [];
          const active = held.some(entry => entry.name === lockName(item));
          try {
            const record = parseRecovery(raw);
            return item === key ? [] : [{
              key: item, title: record.document.metadata.title, active,
              changes: record.operations.length,
              ...(record.savedAt ? { savedAt: record.savedAt } : {}),
            }];
          }
          catch { return [{ key: item, title: "Unreadable saved copy", active, error: "The original data has been retained." }]; }
        });
    },
    async take(sourceKey) {
      assertOpen();
      if (sourceKey === key || !(sourceKey === prefix || sourceKey.startsWith(`${prefix}:`))) throw new Error("Invalid recovery copy.");
      const sourceRelease = await lock(sourceKey);
      if (!sourceRelease) throw new Error("That copy is still open in another tab. Close that editor before recovering it here.");
      try {
        assertOpen();
        if (localStorage.getItem(key)) throw new Error("Save or reconcile this tab's edits before opening another copy.");
        const raw = localStorage.getItem(sourceKey);
        if (!raw) throw new Error("That recovery copy is no longer available.");
        const record = parseRecovery(raw);
        // Write before removing: quota/errors always leave the original intact.
        localStorage.setItem(key, raw);
        // Old shared journals and browsers without locks have no exclusive
        // ownership guarantee. Copy them, retaining the source for older tabs.
        if (navigator.locks && sourceKey !== prefix) localStorage.removeItem(sourceKey);
        return record;
      } finally { sourceRelease(); }
    },
    close() { if (!closed) { closed = true; release(); } },
  };
}
