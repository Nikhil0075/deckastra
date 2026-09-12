import { PatchOperationSchema, PresentationDocumentSchema, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";

export interface EditorRecovery {
  format: 1;
  versionId: string;
  document: PresentationDocument;
  operations: PatchOperation[];
  labels: string[];
}

export function recoveryKey(presentationId: string, owner?: string): string {
  const prefix = `deckastra.editor-recovery.v1:${presentationId}`;
  return owner ? `${prefix}:${owner}` : prefix;
}

export function recoveryPointer(presentationId: string): string {
  return `deckastra.editor-recovery.owner:${presentationId}`;
}

function parseRecovery(raw: string): EditorRecovery {
  const saved = JSON.parse(raw) as EditorRecovery;
  if (!saved || saved.format !== 1 || typeof saved.versionId !== "string" ||
      !Array.isArray(saved.operations) || !Array.isArray(saved.labels)) {
    throw new Error("This saved recovery record cannot be read. It has been left intact.");
  }
  if (saved.labels.some(label => typeof label !== "string")) throw new Error("Invalid recovery labels.");
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

export async function openRecoveryJournal(presentationId: string): Promise<RecoveryJournal> {
  const prefix = recoveryKey(presentationId);
  let owner: string | null = null;
  // A missing session store must not prevent unique local recovery copies.
  try { owner = navigator.locks ? sessionStorage.getItem(recoveryPointer(presentationId)) : null; } catch { /* fresh owner */ }
  if (owner && !/^[a-zA-Z0-9-]+$/.test(owner)) owner = null;
  let release = owner ? await lock(recoveryKey(presentationId, owner)) : null;
  if (!release) {
    owner = crypto.randomUUID();
    release = await lock(recoveryKey(presentationId, owner));
  }
  if (!release || !owner) throw new Error("Could not open a separate recovery journal.");
  const key = recoveryKey(presentationId, owner);
  try { sessionStorage.setItem(recoveryPointer(presentationId), owner); } catch { /* explicit recovery remains available */ }
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("This recovery journal is closed."); };
  const read = () => { assertOpen(); const raw = localStorage.getItem(key); return raw ? parseRecovery(raw) : null; };
  const write = (record: EditorRecovery | null) => {
    assertOpen();
    // An unreadable record is never replaced by an unrelated edit.
    const previous = localStorage.getItem(key);
    if (previous) parseRecovery(previous);
    if (record) localStorage.setItem(key, JSON.stringify(record));
    else localStorage.removeItem(key);
  };
  return {
    key, read, write,
    async copies() {
      assertOpen();
      const held = navigator.locks ? (await navigator.locks.query()).held ?? [] : [];
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      return keys.filter((item): item is string => !!item && (item === prefix || item.startsWith(`${prefix}:`)))
        .sort().flatMap(item => {
          const raw = localStorage.getItem(item);
          if (!raw) return [];
          const active = held.some(entry => entry.name === lockName(item));
          try {
            const record = parseRecovery(raw);
            return item === key ? [] : [{ key: item, title: record.document.metadata.title, active }];
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
