import { z } from "zod";
import { joinPath, splitPath } from "./patch";
import { RichTextDocumentSchema, textContent, type RichTextDocument } from "./text";
import type { PresentationElement } from "./elements";
import type { PresentationDocument, Slide } from "./document";

/**
 * One deck, many languages (integration plan 01 §3.1).
 *
 * A language is an **overlay, not a copy**. A copy per language turns every
 * layout fix into N fixes and every agent edit into N edits that can drift. An
 * overlay keeps one geometry and one mutation path: it holds replacement words
 * for named text slots and nothing else. It can never move, recolour or retype
 * anything, because the only thing an entry can address is a slot on the
 * allowlist below — the same reasoning `isAllowedBindingTarget` applies to data
 * bindings.
 *
 * Entries are keyed by the slot's id-addressed patch path
 * (`/slides/id:sld_…/elements/id:el_…/content`). Index paths would move the
 * moment an earlier sibling was inserted, which is exactly what agents do.
 *
 * Each entry records a hash of the source text it was translated from. When
 * someone edits the source sentence the entry is *outdated*, not wrong: the
 * panel counts it, offers to re-translate exactly those, and keeps showing the
 * old translation until then. No timestamps are compared, so a clock that is
 * wrong on one machine cannot make a translation look current.
 *
 * Which language is showing is editor state, like zoom. It never reaches the
 * document; exports and share links take it as a parameter.
 */

/** BCP-47-shaped: a language subtag and optional script/region/variant subtags. */
export const LocaleTagSchema = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, {
  message: 'Expected a BCP-47 language tag, e.g. "hi-IN" or "ar"',
});

export const LocaleEntrySchema = z.looseObject({
  /** The same shape as the source slot: rich text for a text box, a string for a label. */
  value: z.union([RichTextDocumentSchema, z.string()]),
  /** `localeTextHash` of the source text this was translated from. */
  sourceHash: z.string().min(1).max(64),
  /** "human", "machine", "stub" (the keyless stand-in), or "agent:<id>". */
  origin: z.string().regex(/^(human|machine|stub|agent:[A-Za-z0-9_.:-]{1,64})$/),
  /** Entry review overrides the language-wide default, preserving other reviewed slides. */
  reviewStatus: z.enum(["draft", "reviewed"]).optional(),
});
export type LocaleEntry = z.infer<typeof LocaleEntrySchema>;

export const LocaleFontsSchema = z.looseObject({
  heading: z.string().min(1).max(120).optional(),
  body: z.string().min(1).max(120).optional(),
  mono: z.string().min(1).max(120).optional(),
});

export const LocaleOverlaySchema = z.looseObject({
  locale: LocaleTagSchema,
  /** "reviewed" once a person has read it through; machine output starts "draft". */
  status: z.enum(["draft", "reviewed"]),
  /** Default from the locale (`localeDirection`). */
  direction: z.enum(["ltr", "rtl"]).optional(),
  /** Per-script family overrides, for a brand whose Latin face has no Devanagari. */
  fonts: LocaleFontsSchema.optional(),
  entries: z.record(z.string(), LocaleEntrySchema),
});
export type LocaleOverlay = z.infer<typeof LocaleOverlaySchema>;

// ------------------------------------------------------------------ the slots

/** What a slot accepts: rich text only, a plain string only, or either. */
export type LocaleSlotKind = "rich" | "string" | "either";

export interface LocaleSlot {
  /** Id-addressed patch path, also the overlay entry key. */
  path: string;
  kind: LocaleSlotKind;
  value: RichTextDocument | string;
  /** The slide the slot is on; absent for deck-wide slots (the title). */
  slideId?: string;
  /** The element the slot belongs to, when it belongs to one. */
  elementId?: string;
}

const ELEMENT = String.raw`/slides/id:[^/]+/elements(?:/id:[^/]+/children)*/id:[^/]+`;

/**
 * Every path an overlay entry may name. A regex allowlist rather than a check
 * against the document, so a validator can refuse an entry that could never be
 * a text slot (E320) even when its element has since been deleted — that case is
 * the different, recoverable W320.
 */
export const LOCALIZABLE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/metadata\/title$/,
  /^\/slides\/id:[^/]+\/speakerNotes$/,
  /^\/slides\/id:[^/]+\/narration\/cues\/id:[^/]+\/text$/,
  new RegExp(`^${ELEMENT}/(content|text|label|altText|transcript|metadata/altText)$`),
  new RegExp(`^${ELEMENT}/chartStyle/axis[XY]/title$`),
  new RegExp(`^${ELEMENT}/data/rows/\\d+/[^/]+$`),
  new RegExp(`^${ELEMENT}/columns/id:[^/]+/label$`),
  new RegExp(`^${ELEMENT}/rows/id:[^/]+/cells/\\d+/content$`),
  new RegExp(`^${ELEMENT}/(nodes|edges|groups)/id:[^/]+/(label|sublabel)$`),
];

export function isLocalizablePath(path: string): boolean {
  return LOCALIZABLE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function hasText(value: unknown): value is string | RichTextDocument {
  if (typeof value === "string") return true;
  return RichTextDocumentSchema.safeParse(value).success;
}

/**
 * Every text slot in a document, in document order.
 *
 * Empty slots are included: an entry naming one is still on target. Callers
 * that translate skip the empty ones themselves.
 */
export function localeSlots(document: PresentationDocument): LocaleSlot[] {
  const out: LocaleSlot[] = [];
  const push = (path: string, kind: LocaleSlotKind, value: unknown, slideId?: string, elementId?: string): void => {
    if (!hasText(value)) return;
    if (kind === "string" && typeof value !== "string") return;
    if (kind === "rich" && typeof value === "string") return;
    out.push({ path, kind, value, ...(slideId ? { slideId } : {}), ...(elementId ? { elementId } : {}) });
  };

  push("/metadata/title", "string", document.metadata?.title);

  for (const slide of document.slides ?? []) {
    const slidePath = `/slides/id:${slide.id}`;
    push(`${slidePath}/speakerNotes`, "either", slide.speakerNotes, slide.id);
    walk(slide.elements ?? [], `${slidePath}/elements`, (element, path) => {
      elementSlots(element, path, (subPath, kind, value) => push(subPath, kind, value, slide.id, element.id));
    });
    for (const cue of narrationCuesOf(slide)) {
      push(`${slidePath}/narration/cues/id:${cue.id}/text`, "string", cue.text, slide.id);
    }
  }
  return out;
}

function walk(
  elements: readonly PresentationElement[],
  containerPath: string,
  visit: (element: PresentationElement, path: string) => void,
): void {
  for (const element of elements) {
    const path = `${containerPath}/id:${element.id}`;
    visit(element, path);
    const children = (element as { children?: PresentationElement[] }).children;
    if (element.type === "group" && Array.isArray(children)) walk(children, `${path}/children`, visit);
  }
}

function elementSlots(
  element: PresentationElement,
  path: string,
  push: (path: string, kind: LocaleSlotKind, value: unknown) => void,
): void {
  const el = element as Record<string, unknown>;
  switch (element.type) {
    case "text":
      push(`${path}/content`, "rich", el.content);
      break;
    case "shape":
      push(`${path}/text`, "rich", el.text);
      break;
    case "line":
      push(`${path}/label`, "rich", el.label);
      break;
    case "audio":
      push(`${path}/transcript`, "string", el.transcript);
      break;
    case "chart": {
      const style = el.chartStyle as { axisX?: { title?: unknown }; axisY?: { title?: unknown } } | undefined;
      push(`${path}/chartStyle/axisX/title`, "string", style?.axisX?.title);
      push(`${path}/chartStyle/axisY/title`, "string", style?.axisY?.title);
      const data = el.data as { type?: string; rows?: Record<string, unknown>[] } | undefined;
      const encoding = el.encoding as { category?: string; series?: string } | undefined;
      if (data?.type === "inline" && Array.isArray(data.rows)) {
        // Only the columns that are words: the category and the series. A value
        // column carrying "12" is a number someone typed as text, and translating
        // it would change the chart.
        const keys = [encoding?.category, encoding?.series].filter((key): key is string => typeof key === "string");
        data.rows.forEach((row, index) => {
          for (const key of new Set(keys)) {
            const cell = row?.[key];
            if (typeof cell === "string" && !/^[\s\d.,%+\-]*$/.test(cell)) {
              push(`${path}/data/rows/${index}/${escapeSegment(key)}`, "string", cell);
            }
          }
        });
      }
      break;
    }
    case "table": {
      for (const column of (el.columns as { id: string; label?: unknown }[] | undefined) ?? []) {
        push(`${path}/columns/id:${column.id}/label`, "string", column.label);
      }
      for (const row of (el.rows as { id: string; cells?: { content?: unknown }[] }[] | undefined) ?? []) {
        (row.cells ?? []).forEach((cell, index) => push(`${path}/rows/id:${row.id}/cells/${index}/content`, "either", cell?.content));
      }
      break;
    }
    case "diagram": {
      for (const node of (el.nodes as { id: string; label?: unknown; sublabel?: unknown }[] | undefined) ?? []) {
        push(`${path}/nodes/id:${node.id}/label`, "string", node.label);
        push(`${path}/nodes/id:${node.id}/sublabel`, "string", node.sublabel);
      }
      for (const edge of (el.edges as { id: string; label?: unknown }[] | undefined) ?? []) {
        push(`${path}/edges/id:${edge.id}/label`, "string", edge.label);
      }
      for (const group of (el.groups as { id: string; label?: unknown }[] | undefined) ?? []) {
        push(`${path}/groups/id:${group.id}/label`, "string", group.label);
      }
      break;
    }
    default:
      break;
  }
  push(`${path}/altText`, "string", el.altText);
  const metadata = el.metadata as { altText?: unknown } | undefined;
  push(`${path}/metadata/altText`, "string", metadata?.altText);
}

/** A key that may contain "/" or "~", made safe as one path segment. */
function escapeSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function narrationCuesOf(slide: Slide): { id: string; step: number; text: string; takes?: Record<string, unknown> }[] {
  const narration = (slide as { narration?: { cues?: unknown } }).narration;
  const cues = narration?.cues;
  return Array.isArray(cues) ? (cues as { id: string; step: number; text: string; takes?: Record<string, unknown> }[]) : [];
}

// --------------------------------------------------------------------- hashes

/**
 * The fingerprint an entry and a narration take keep of the words they came
 * from: FNV-1a 64 over the UTF-8 of the slot's plain text.
 *
 * Plain text, so re-bolding a word does not make every translation outdated.
 * FNV rather than SHA-256 because it has to run synchronously in an editor that
 * has no synchronous digest, and identically in Python, which recomputes it when
 * it translates (`apps/api/deckastra_api/translation.py`). It is a change
 * detector, not a security boundary: nobody gains anything by forging one.
 */
export function localeTextHash(value: RichTextDocument | string | undefined): string {
  const text = value === undefined ? "" : textContent(value);
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

// -------------------------------------------------------------- paths, scripts

/** The patch path of an overlay entry: the slot path escaped as one segment. */
export function localeEntryPath(locale: string, slotPath: string): string {
  return joinPath(["locales", locale, "entries", slotPath]);
}

/** The slot an entry path names, or undefined when the path is not one. */
export function slotOfEntryPath(path: string): { locale: string; slotPath: string } | undefined {
  const segments = splitPath(path);
  if (segments.length < 4 || segments[0] !== "locales" || segments[2] !== "entries") return undefined;
  return { locale: segments[1]!, slotPath: segments[3]! };
}

/** The deck's own language: what the source text is written in. */
export function sourceLocale(document: Pick<PresentationDocument, "metadata">): string {
  const language = document.metadata?.language;
  return typeof language === "string" && language.length > 0 ? language : "en";
}

/** Two tags name the same language when their primary subtags agree, case aside. */
export function sameLanguage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "iw", "ur", "ps", "sd", "ug", "yi", "dv", "ckb"]);

export function localeDirection(locale: string): "ltr" | "rtl" {
  const primary = locale.split("-")[0]!.toLowerCase();
  return RTL_LANGUAGES.has(primary) ? "rtl" : "ltr";
}

export type Script =
  | "latin"
  | "devanagari"
  | "bengali"
  | "tamil"
  | "telugu"
  | "kannada"
  | "malayalam"
  | "gujarati"
  | "gurmukhi"
  | "oriya"
  | "arabic"
  | "hebrew"
  | "japanese"
  | "korean"
  | "chinese"
  | "cyrillic"
  | "greek"
  | "thai";

const SCRIPT_BY_LANGUAGE: Record<string, Script> = {
  hi: "devanagari", mr: "devanagari", ne: "devanagari", sa: "devanagari", kok: "devanagari", mai: "devanagari",
  bn: "bengali", as: "bengali",
  ta: "tamil", te: "telugu", kn: "kannada", ml: "malayalam", gu: "gujarati", pa: "gurmukhi", or: "oriya",
  ar: "arabic", fa: "arabic", ur: "arabic", ps: "arabic", sd: "arabic", ckb: "arabic", ug: "arabic",
  he: "hebrew", iw: "hebrew", yi: "hebrew",
  ja: "japanese", ko: "korean", zh: "chinese",
  ru: "cyrillic", uk: "cyrillic", bg: "cyrillic", sr: "cyrillic", be: "cyrillic", kk: "cyrillic", mk: "cyrillic",
  el: "greek", th: "thai",
};

/** The script a locale is written in, as far as typography needs to know. */
export function localeScript(locale: string): Script {
  const parts = locale.split("-");
  const primary = parts[0]!.toLowerCase();
  // An explicit script subtag wins: "sr-Latn" is Latin, "pa-Arab" is Arabic.
  const explicit = parts.find((part) => part.length === 4)?.toLowerCase();
  if (explicit === "latn") return "latin";
  if (explicit === "arab") return "arabic";
  if (explicit === "deva") return "devanagari";
  if (explicit === "cyrl") return "cyrillic";
  if (explicit === "hans" || explicit === "hant") return "chinese";
  return SCRIPT_BY_LANGUAGE[primary] ?? "latin";
}
