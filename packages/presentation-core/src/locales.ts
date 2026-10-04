import {
  localeEntryPath,
  localeSlots,
  localeTextHash,
  sameLanguage,
  sourceLocale,
  type LocaleEntry,
  type LocaleOverlay,
  type LocaleSlot,
  type PatchOperation,
  type PresentationDocument,
  type RichTextDocument,
} from "@deckastra/presentation-schema";

import { OperationError } from "./operations";

/**
 * Operations over language overlays (integration plan 01 §3.1).
 *
 * Like everything in this package, these emit patches and never return a
 * document. Showing a deck in a language is `localeOperations` applied to a
 * *copy* through `@deckastra/transactions` — the copy is what the scene is built
 * from, and the saved deck is never touched by viewing it.
 */

/** Overlay entries keyed by slot path, or nothing for the source language. */
function overlayOf(document: PresentationDocument, locale: string): LocaleOverlay | undefined {
  if (sameLanguage(locale, sourceLocale(document))) return undefined;
  return document.locales?.[locale];
}

/**
 * The patch that shows `document` in `locale`: every entry whose slot still
 * exists replaces that slot's words, and `metadata.language` names the locale,
 * so text measurement and font fallback know which script they are drawing.
 *
 * The source language, or a locale the deck has no overlay for, is no patch at
 * all — the document as it is.
 *
 * An entry whose target has gone, or whose shape disagrees with its slot, is
 * skipped rather than applied: the validator reports both (W320, E321), and a
 * view must not refuse to open over a translation problem.
 */
export function localeOperations(document: PresentationDocument, locale: string): PatchOperation[] {
  const overlay = overlayOf(document, locale);
  if (!overlay) return [];
  const operations: PatchOperation[] = [];
  for (const slot of localeSlots(document)) {
    const entry = overlay.entries[slot.path];
    if (!entry || !fits(slot, entry.value)) continue;
    operations.push({ op: "replace", path: slot.path, value: entry.value });
  }
  operations.push({
    op: document.metadata.language === undefined ? "add" : "replace",
    path: "/metadata/language",
    value: locale,
  });
  return operations;
}

function fits(slot: LocaleSlot, value: unknown): boolean {
  if (slot.kind === "rich") return typeof value !== "string";
  if (slot.kind === "string") return typeof value === "string";
  return true;
}

/** Add an empty overlay for a language. Refuses the source language and a duplicate. */
export function addLocaleOperations(
  document: PresentationDocument,
  locale: string,
  options: { direction?: "ltr" | "rtl" } = {},
): PatchOperation[] {
  if (sameLanguage(locale, sourceLocale(document))) {
    throw new OperationError(`${locale} is this deck's own language. Its words are the source text.`);
  }
  if (document.locales?.[locale]) throw new OperationError(`This deck already has ${locale}.`);
  const overlay: LocaleOverlay = {
    locale,
    status: "draft",
    ...(options.direction ? { direction: options.direction } : {}),
    entries: {},
  };
  if (!document.locales) return [{ op: "add", path: "/locales", value: { [locale]: overlay } }];
  return [{ op: "add", path: `/locales/${escape(locale)}`, value: overlay }];
}

export function removeLocaleOperations(document: PresentationDocument, locale: string): PatchOperation[] {
  if (!document.locales?.[locale]) return [];
  if (Object.keys(document.locales).length === 1) return [{ op: "remove", path: "/locales" }];
  return [{ op: "remove", path: `/locales/${escape(locale)}` }];
}

export interface LocaleEntryInput {
  slotPath: string;
  value: RichTextDocument | string;
  origin: LocaleEntry["origin"];
}

/**
 * Write translations. Each entry is stamped with the hash of the source text it
 * now translates, so writing one is also how an outdated entry is brought
 * current — a person who reviewed the old words against the new source has
 * done exactly what "re-translate" means.
 *
 * One operation per entry, so an undo takes back one entry rather than the
 * whole overlay, and two people translating different slides do not conflict.
 */
export function setLocaleEntriesOperations(
  document: PresentationDocument,
  locale: string,
  entries: readonly LocaleEntryInput[],
): PatchOperation[] {
  if (sameLanguage(locale, sourceLocale(document))) {
    throw new OperationError(`${locale} is this deck's own language; edit the source text instead.`);
  }
  const slots = new Map(localeSlots(document).map((slot) => [slot.path, slot]));
  const operations: PatchOperation[] = [];
  const overlay = document.locales?.[locale];
  if (!overlay) operations.push(...addLocaleOperations(document, locale));
  const existing = overlay?.entries ?? {};
  for (const input of entries) {
    const slot = slots.get(input.slotPath);
    if (!slot) throw new OperationError(`"${input.slotPath}" is not text in this deck.`);
    if (!fits(slot, input.value)) {
      throw new OperationError(`"${input.slotPath}" holds ${slot.kind === "rich" ? "rich text" : "a plain string"}.`);
    }
    const entry: LocaleEntry = { value: input.value, sourceHash: localeTextHash(slot.value), origin: input.origin };
    operations.push({
      op: existing[input.slotPath] ? "replace" : "add",
      path: localeEntryPath(locale, input.slotPath),
      value: entry,
    });
  }
  return operations;
}

export function removeLocaleEntryOperations(
  document: PresentationDocument,
  locale: string,
  slotPath: string,
): PatchOperation[] {
  if (!document.locales?.[locale]?.entries[slotPath]) return [];
  return [{ op: "remove", path: localeEntryPath(locale, slotPath) }];
}

export function setLocaleStatusOperations(
  document: PresentationDocument,
  locale: string,
  status: LocaleOverlay["status"],
): PatchOperation[] {
  const overlay = document.locales?.[locale];
  if (!overlay) return [];
  const operations: PatchOperation[] = overlay.status === status ? [] : [{ op: "replace", path: `/locales/${escape(locale)}/status`, value: status }];
  for (const [path, entry] of Object.entries(overlay.entries)) {
    if (entry.reviewStatus !== status) operations.push({ op: entry.reviewStatus === undefined ? "add" : "replace", path: `/locales/${escape(locale)}/entries/${escape(path)}/reviewStatus`, value: status });
  }
  return operations;
}

export interface LocaleProgress {
  locale: string;
  /** Slots with words in them: what there is to translate. */
  total: number;
  translated: number;
  outdated: number;
  missing: number;
  /** Entries whose slot has gone (kept, W320). */
  stale: number;
  outdatedPaths: string[];
  missingPaths: string[];
}

/**
 * "12 translated, 4 outdated, 3 missing" for the Languages panel, and the paths
 * behind each count so Translate missing and Re-translate outdated act on
 * exactly those.
 */
export function localeProgress(document: PresentationDocument, locale: string): LocaleProgress {
  const overlay = document.locales?.[locale];
  const slots = localeSlots(document).filter((slot) => isWorthTranslating(slot.value));
  const entries = overlay?.entries ?? {};
  const outdatedPaths: string[] = [];
  const missingPaths: string[] = [];
  let translated = 0;
  for (const slot of slots) {
    const entry = entries[slot.path];
    if (!entry) missingPaths.push(slot.path);
    else if (entry.sourceHash !== localeTextHash(slot.value)) outdatedPaths.push(slot.path);
    else translated += 1;
  }
  const live = new Set(localeSlots(document).map((slot) => slot.path));
  const stale = Object.keys(entries).filter((path) => !live.has(path)).length;
  return {
    locale,
    total: slots.length,
    translated,
    outdated: outdatedPaths.length,
    missing: missingPaths.length,
    stale,
    outdatedPaths,
    missingPaths,
  };
}

/** Text worth sending to a translator: not empty, and not only digits and punctuation. */
export function isWorthTranslating(value: RichTextDocument | string): boolean {
  const text = typeof value === "string" ? value : value.blocks.map((block) => block.spans.map((span) => span.text).join("")).join("\n");
  return /\p{L}/u.test(text);
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
