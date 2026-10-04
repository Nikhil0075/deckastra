import {
  isLocalizablePath,
  joinPath,
  localeEntryPath,
  localeSlots,
  localeTextHash,
  sameLanguage,
  sourceLocale,
  splitPath,
  textContent,
  type LocaleEntry,
  type LocaleSlot,
  type PatchOperation,
  type PresentationDocument,
  type RichTextDocument,
} from "@deckastra/presentation-schema";
import { localeOperations } from "@deckastra/presentation-core";
import { applyPatch, deepEqual, readPath } from "@deckastra/transactions";

/**
 * Editing a deck while it is shown in another language (integration plan 01 §3.2).
 *
 * The editor shows a **localized copy** — the saved deck with a language's
 * overlay applied — and every surface reads that copy without knowing it is one:
 * the canvas, the inspector, the notes, the strip, Code mode. What they write is
 * a patch against the copy, and this module is the one place that turns it into
 * a patch against the saved deck. It is a lens, and it has two rules:
 *
 * 1. **Words go to the overlay.** An edit inside a text slot — typing in a box,
 *    a notes change, a chart label — writes that language's entry for the slot,
 *    stamped with the hash of the source text it now translates. The source
 *    sentence is untouched; the English deck is still the English deck.
 * 2. **Everything else is shared.** Moving, recolouring, adding a slide: one
 *    geometry for every language, so those operations pass through unchanged
 *    and the UI says "moving this moves it in every language".
 *
 * The hard case is an operation that writes a whole object containing words —
 * duplicating a text box, pasting a slide, replacing an element. Its value was
 * read from the localized copy, so applied as-is it would write Hindi into the
 * English source. The lens applies it, then looks at every slot whose words
 * changed: words that are a translation the overlay already holds are put back
 * to their source and the translation is carried to the new slot; words that
 * are nobody's translation were typed fresh, and stay where they were written.
 *
 * Everything returned is an ordinary patch for the one applier, so undo,
 * autosave and history need nothing new.
 */

/** The deck as it shows in `locale`. The source language is the deck itself. */
export function localizeDocument(document: PresentationDocument, locale: string | null): PresentationDocument {
  if (!locale || sameLanguage(locale, sourceLocale(document))) return document;
  const operations = localeOperations(document, locale);
  if (operations.length === 0) return document;
  return applyPatch(document, operations).document;
}

/** True when `locale` is a language other than the deck's own and the deck has it. */
export function isOverlayLocale(document: PresentationDocument, locale: string | null): locale is string {
  return Boolean(locale && !sameLanguage(locale, sourceLocale(document)) && document.locales?.[locale]);
}

/**
 * Rewrite operations authored against the localized copy into operations on
 * the saved deck. `source` is the saved deck; the copy is derived from it.
 */
export function localizeWrite(
  source: PresentationDocument,
  locale: string,
  operations: readonly PatchOperation[],
): PatchOperation[] {
  if (!isOverlayLocale(source, locale)) return [...operations];
  const out: PatchOperation[] = [];
  let current = source;
  for (const operation of operations) {
    const viewed = localizeDocument(current, locale);
    const rewritten = rewriteOne(current, viewed, locale, operation);
    if (rewritten.length === 0) continue;
    current = applyPatch(current, rewritten).document;
    out.push(...rewritten);
  }
  return out;
}

function rewriteOne(
  source: PresentationDocument,
  viewed: PresentationDocument,
  locale: string,
  operation: PatchOperation,
): PatchOperation[] {
  const path = canonicalPath(viewed, operation.path);
  const slots = slotIndex(viewed);

  // Rule 1: inside (or exactly) a text slot that exists — the overlay.
  const slot = slotContaining(slots, path);
  if (slot) return [overlayWrite(source, viewed, locale, slot, operation)];

  // A slot-shaped path whose slot does not exist yet (a first label on a shape,
  // the first notes on a slide): new words, written where they were written.
  if (isLocalizablePath(path)) return [operation];

  // `/metadata/language` is the copy's own marker of which language it shows.
  // Writing it back would quietly change the deck's source language.
  if (path === "/metadata/language") return [];

  // Rule 2, with the whole-object case handled.
  if (operation.op === "remove" || operation.op === "move" || operation.op === "test") return [operation];
  return [operation, ...repairWords(source, viewed, locale, operation, path)];
}

interface SlotIndex {
  byPath: Map<string, LocaleSlot>;
}

function slotIndex(document: PresentationDocument): SlotIndex {
  return { byPath: new Map(localeSlots(document).map((slot) => [slot.path, slot])) };
}

function slotContaining(index: SlotIndex, path: string): LocaleSlot | undefined {
  const exact = index.byPath.get(path);
  if (exact) return exact;
  for (const [slotPath, slot] of index.byPath) {
    if (path.startsWith(`${slotPath}/`)) return slot;
  }
  return undefined;
}

/** The slot's new words in the copy, written as this language's entry for it. */
function overlayWrite(
  source: PresentationDocument,
  viewed: PresentationDocument,
  locale: string,
  slot: LocaleSlot,
  operation: PatchOperation,
): PatchOperation {
  const after = applyPatch(viewed, [operation]).document;
  let value = readPath(after, slot.path) as RichTextDocument | string | undefined;
  if (value === undefined) {
    // Clearing the field in this language means this language says nothing
    // there — not "fall back to the source". An empty translation is a choice.
    value = typeof slot.value === "string" ? "" : { version: 1, blocks: [] };
  }
  const sourceValue = readPath(source, slot.path) as RichTextDocument | string | undefined;
  const entry: LocaleEntry = { value, sourceHash: localeTextHash(sourceValue), origin: "human" };
  const exists = source.locales?.[locale]?.entries[slot.path] !== undefined;
  return { op: exists ? "replace" : "add", path: localeEntryPath(locale, slot.path), value: entry };
}

/**
 * After a whole-object write: put back source words the copy leaked, and carry
 * translations to slots that received them (plan 01 §3.2, the duplicate case).
 */
function repairWords(
  source: PresentationDocument,
  viewed: PresentationDocument,
  locale: string,
  operation: PatchOperation,
  path: string,
): PatchOperation[] {
  let afterSource: PresentationDocument;
  try {
    afterSource = applyPatch(source, [operation]).document;
  } catch {
    // The applier will refuse it again when the caller applies it, with its
    // own message; nothing to repair in an operation that does not apply.
    return [];
  }
  const fixes: PatchOperation[] = [];

  // The copy's language marker, written into the source by a write over
  // `/metadata` or the whole document.
  if (path === "/" || path === "/metadata") {
    const was = source.metadata.language;
    const now = afterSource.metadata.language;
    if (now !== was) {
      fixes.push(was === undefined ? { op: "remove", path: "/metadata/language" } : { op: "replace", path: "/metadata/language", value: was });
    }
  }

  const entries = source.locales?.[locale]?.entries ?? {};
  const translationsByText = new Map<string, string>();
  for (const [slotPath, entry] of Object.entries(entries)) {
    if (readPath(source, slotPath) !== undefined) translationsByText.set(textContent(entry.value), slotPath);
  }

  // What matters is what the write did to the *source*: every slot whose saved
  // words it changed. The copy is only where its values were read from.
  for (const slot of localeSlots(afterSource)) {
    const original = readPath(source, slot.path) as RichTextDocument | string | undefined;
    if (original !== undefined && deepEqual(original, slot.value)) continue;
    const words = textContent(slot.value);

    const own = entries[slot.path];
    if (own && original !== undefined && textContent(own.value) === words && textContent(original) !== words) {
      // This slot's own translation, written back over its source words.
      fixes.push({ op: "replace", path: slot.path, value: original });
      continue;
    }

    const from = translationsByText.get(words);
    if (from && from !== slot.path) {
      // Words that are another slot's translation: a copy of that slot. Its
      // source words go in the source, and its translation comes with it.
      const sourceWords = readPath(source, from) as RichTextDocument | string;
      fixes.push({ op: "replace", path: slot.path, value: keepBlockIds(sourceWords, slot.value) });
      const entry = entries[from]!;
      fixes.push({
        op: entries[slot.path] ? "replace" : "add",
        path: localeEntryPath(locale, slot.path),
        value: { ...entry, value: keepBlockIds(entry.value, slot.value) },
      });
    }
    // Otherwise the words were typed fresh: they stay where they were written.
  }
  return fixes;
}

/** `value` with the block ids of `shape`, when both are rich text with as many blocks. */
function keepBlockIds<T extends RichTextDocument | string>(value: T, shape: RichTextDocument | string): T {
  if (typeof value === "string" || typeof shape === "string") return value;
  const rich = value as RichTextDocument;
  if (rich.blocks.length !== shape.blocks.length) return value;
  return { ...rich, blocks: rich.blocks.map((block, index) => ({ ...block, id: shape.blocks[index]!.id })) } as unknown as T;
}

/**
 * A path with every numeric index into an array of id-bearing members rewritten
 * as `id:`, so `/slides/0/elements/2/content` and its id form name one slot.
 */
export function canonicalPath(document: unknown, path: string): string {
  const segments = splitPath(path);
  const out: string[] = [];
  let cursor: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      let member: unknown;
      if (segment.startsWith("id:")) {
        member = cursor.find((item) => (item as { id?: unknown })?.id === segment.slice(3));
        out.push(segment);
      } else if (/^\d+$/.test(segment)) {
        member = cursor[Number(segment)];
        const id = (member as { id?: unknown } | undefined)?.id;
        out.push(typeof id === "string" ? `id:${id}` : segment);
      } else {
        out.push(segment);
        member = undefined;
      }
      cursor = member;
    } else {
      out.push(segment);
      cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[segment] : undefined;
    }
  }
  return out.length ? joinPath(out) : "/";
}
