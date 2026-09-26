/**
 * A deck's colours as things a person manages (colour wizard, 2026-09-26).
 *
 * Three kinds, and the difference between them is the whole design:
 *
 * - **Theme colours** are the roles every theme has (text, accent, background…).
 *   Changing one changes everything that refers to it, which is the point of a
 *   role.
 * - **Named colours** are the person's own, kept in the theme under
 *   `colors.custom` (doc 02 §22). The name *is* the token key, so an element
 *   refers to `token:colors.custom.Brand red` and changing "Brand red" changes
 *   every text run, fill, series and node that uses it. That is what the
 *   schema slot was for; nothing in the editor could write it until now.
 * - **Colours in this deck** are loose values (`#1E4BD2`) written onto elements.
 *   They are listed so they can be found, replaced everywhere, or promoted to a
 *   named colour in one step, which is how a deck built by hand becomes one that
 *   re-themes.
 *
 * Everything here is pure and returns patch operations; the surfaces only
 * gesture. Renaming and deleting a named colour rewrite every reference in the
 * same patch, because a reference to a colour that no longer exists is a
 * validation error (E202) and, worse, a slide that silently draws the fallback.
 */

import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

export type ThemeColorGroup = "Text" | "Brand" | "Surfaces" | "Structure" | "Status" | "Charts";

export interface ThemeColorRole {
  token: string;
  label: string;
  group: ThemeColorGroup;
  /** The role this one is read against, for the contrast readout. */
  against?: string;
}

/** The theme roles a person can edit, in the order a palette reads. */
export const THEME_COLOR_ROLES: readonly ThemeColorRole[] = [
  { token: "foreground", label: "Text", group: "Text", against: "background" },
  { token: "foregroundMuted", label: "Muted text", group: "Text", against: "background" },
  { token: "foregroundSubtle", label: "Subtle text", group: "Text", against: "background" },
  { token: "accent", label: "Accent", group: "Brand", against: "background" },
  { token: "accentForeground", label: "On accent", group: "Brand", against: "accent" },
  { token: "accentMuted", label: "Accent (muted)", group: "Brand" },
  { token: "secondary", label: "Secondary", group: "Brand", against: "background" },
  { token: "secondaryForeground", label: "On secondary", group: "Brand", against: "secondary" },
  { token: "background", label: "Background", group: "Surfaces" },
  { token: "surface", label: "Surface", group: "Surfaces" },
  { token: "surfaceAlt", label: "Surface (alt)", group: "Surfaces" },
  { token: "border", label: "Border", group: "Structure" },
  { token: "borderStrong", label: "Border (strong)", group: "Structure" },
  { token: "divider", label: "Divider", group: "Structure" },
  { token: "success", label: "Success", group: "Status", against: "background" },
  { token: "warning", label: "Warning", group: "Status", against: "background" },
  { token: "danger", label: "Danger", group: "Status", against: "background" },
  { token: "info", label: "Info", group: "Status", against: "background" },
  { token: "chartPositive", label: "Chart: positive", group: "Charts" },
  { token: "chartNegative", label: "Chart: negative", group: "Charts" },
  { token: "chartNeutral", label: "Chart: neutral", group: "Charts" },
];

/** Roles every theme must have (the schema requires them); these cannot be cleared. */
const REQUIRED = new Set(["background", "surface", "surfaceAlt", "overlay", "foreground", "foregroundMuted", "foregroundSubtle", "accent", "accentForeground", "border"]);

export const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const CUSTOM_PREFIX = "token:colors.custom.";

// ------------------------------------------------------------------ reading

type Colors = Record<string, unknown> & { custom?: Record<string, string>; chartSeries?: string[] };

function colorsOf(document: PresentationDocument): Colors {
  return document.theme.colors as unknown as Colors;
}

export function themeColorToken(role: string): string {
  return `token:colors.${role}`;
}

export function namedColorToken(name: string): string {
  return `${CUSTOM_PREFIX}${name}`;
}

/** The named colour a value refers to, if it refers to one. */
export function namedColorOf(value: string | undefined): string | undefined {
  return value?.startsWith(CUSTOM_PREFIX) ? value.slice(CUSTOM_PREFIX.length) : undefined;
}

export interface NamedColor {
  name: string;
  /** As stored: a literal, or a token of another colour. */
  value: string;
  token: string;
}

/** The deck's named colours, in the order they were made. */
export function namedColors(document: PresentationDocument): NamedColor[] {
  const custom = colorsOf(document).custom ?? {};
  return Object.entries(custom).map(([name, value]) => ({ name, value, token: namedColorToken(name) }));
}

/** A theme colour token or literal, resolved to something CSS can draw. */
export function resolveColorValue(document: PresentationDocument, value: string | undefined, depth = 0): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("token:")) return value;
  if (depth > 4) return undefined;
  let cursor: unknown = document.theme;
  for (const key of value.slice("token:".length).split(".")) {
    cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
  }
  return typeof cursor === "string" ? resolveColorValue(document, cursor, depth + 1) : undefined;
}

/**
 * Why a name cannot be used, or undefined when it can.
 *
 * A dot would split the token path, and a slash or tilde would need escaping in
 * every patch path that names it; neither is worth allowing for a colour name.
 */
export function namedColorProblem(document: PresentationDocument, name: string, except?: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Give the colour a name.";
  if (trimmed.length > 40) return "Keep the name under 40 characters.";
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(trimmed)) return "Use letters, numbers, spaces, hyphens and underscores.";
  const taken = Object.keys(colorsOf(document).custom ?? {}).some(
    (existing) => existing.toLowerCase() === trimmed.toLowerCase() && existing !== except,
  );
  return taken ? `There is already a colour called "${trimmed}".` : undefined;
}

// ----------------------------------------------------------- walking colours

interface Found {
  /** An id-addressed JSON Pointer to the string. */
  path: string;
  value: string;
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Every string that is a colour, with an id-addressed path to it.
 *
 * "Is a colour" is decided by where it sits rather than by what it looks like:
 * a `color` property, or an item of a `palette` or `chartSeries` list. A slide
 * of text that happens to say "#1E4BD2" is words, and replacing it would edit
 * what someone wrote.
 */
function findColors(value: unknown, path: string, inPalette: boolean, out: Found[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const id = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : undefined;
      const next = `${path}/${id ? `id:${id}` : index}`;
      if (typeof item === "string") {
        if (inPalette) out.push({ path: next, value: item });
      } else {
        findColors(item, next, false, out);
      }
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    const next = `${path}/${escape(key)}`;
    if (typeof inner === "string") {
      if (key === "color") out.push({ path: next, value: inner });
    } else {
      findColors(inner, next, key === "palette" || key === "chartSeries" || key === "series", out);
    }
  }
}

/** Colours written on slides (elements, backgrounds, charts), not the theme's own. */
function slideColors(document: PresentationDocument): Found[] {
  const out: Found[] = [];
  document.slides.forEach((slide) => findColors(slide, `/slides/id:${slide.id}`, false, out));
  return out;
}

/** The theme's own references to colours (a role pointing at a named colour, say). */
function themeColorReferences(document: PresentationDocument): Found[] {
  const out: Found[] = [];
  const colors = colorsOf(document);
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === "string") out.push({ path: `/theme/colors/${escape(key)}`, value });
    else if (Array.isArray(value)) value.forEach((item, index) => typeof item === "string" && out.push({ path: `/theme/colors/${escape(key)}/${index}`, value: item }));
    else if (key === "custom" && value && typeof value === "object") {
      for (const [name, color] of Object.entries(value)) typeof color === "string" && out.push({ path: `/theme/colors/custom/${escape(name)}`, value: color });
    }
  }
  const rest = { ...(document.theme as unknown as Record<string, unknown>) };
  delete rest.colors;
  findColors(rest, "/theme", false, out);
  return out;
}

/** A literal as one spelling, so "#1e4bd2" and "#1E4BD2" count as one colour. */
export function normaliseColor(value: string): string {
  const text = value.trim();
  if (!HEX_COLOR.test(text)) return text.toLowerCase();
  let hex = text.slice(1).toUpperCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 8 && hex.endsWith("FF")) hex = hex.slice(0, 6);
  return `#${hex}`;
}

export interface DeckColor {
  /** Normalised literal. */
  value: string;
  count: number;
}

/** Loose colours on the slides, most used first. */
export function deckColors(document: PresentationDocument): DeckColor[] {
  const counts = new Map<string, number>();
  for (const found of slideColors(document)) {
    if (found.value.startsWith("token:") || found.value === "transparent") continue;
    const key = normaliseColor(found.value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** How many places on the slides refer to this token (a theme role or a named colour). */
export function tokenUseCount(document: PresentationDocument, token: string): number {
  return slideColors(document).filter((found) => found.value === token).length +
    themeColorReferences(document).filter((found) => found.value === token).length;
}

// ------------------------------------------------------------------ writing

/** Change a theme role's colour. Everything that refers to the role follows. */
export function setThemeColorOperations(document: PresentationDocument, role: string, value: string | undefined): PatchOperation[] {
  const colors = colorsOf(document);
  const path = `/theme/colors/${escape(role)}`;
  if (value === undefined) {
    if (REQUIRED.has(role) || colors[role] === undefined) return [];
    return [{ op: "remove", path }];
  }
  if (colors[role] === value) return [];
  return [{ op: colors[role] === undefined ? "add" : "replace", path, value }];
}

/** Make a named colour. Returns the token to use it by. */
export function addNamedColorOperations(
  document: PresentationDocument,
  name: string,
  value: string,
): { operations: PatchOperation[]; token: string } {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const problem = namedColorProblem(document, trimmed);
  if (problem) throw new Error(problem);
  const custom = colorsOf(document).custom;
  const operations: PatchOperation[] = custom
    ? [{ op: "add", path: `/theme/colors/custom/${escape(trimmed)}`, value }]
    : [{ op: "add", path: "/theme/colors/custom", value: { [trimmed]: value } }];
  return { operations, token: namedColorToken(trimmed) };
}

export function setNamedColorOperations(document: PresentationDocument, name: string, value: string): PatchOperation[] {
  const custom = colorsOf(document).custom ?? {};
  if (custom[name] === undefined || custom[name] === value) return [];
  return [{ op: "replace", path: `/theme/colors/custom/${escape(name)}`, value }];
}

/** Point every reference to `from` at `to`, on the slides and in the theme. */
function rewriteReferences(document: PresentationDocument, from: string, to: string, skip?: string): PatchOperation[] {
  return [...slideColors(document), ...themeColorReferences(document)]
    .filter((found) => found.value === from && found.path !== skip)
    .map((found) => ({ op: "replace" as const, path: found.path, value: to }));
}

/** Rename, rewriting every reference in the same patch so nothing is left pointing at the old name. */
export function renameNamedColorOperations(document: PresentationDocument, name: string, next: string): PatchOperation[] {
  const trimmed = next.trim().replace(/\s+/g, " ");
  if (trimmed === name) return [];
  const problem = namedColorProblem(document, trimmed, name);
  if (problem) throw new Error(problem);
  const value = (colorsOf(document).custom ?? {})[name];
  if (value === undefined) return [];
  return [
    { op: "add", path: `/theme/colors/custom/${escape(trimmed)}`, value },
    ...rewriteReferences(document, namedColorToken(name), namedColorToken(trimmed), `/theme/colors/custom/${escape(name)}`),
    { op: "remove", path: `/theme/colors/custom/${escape(name)}` },
  ];
}

/**
 * Delete a named colour. Whatever used it is given `replacement` — by default
 * the colour it was, as a literal, so nothing on a slide changes appearance
 * because a name was tidied away.
 */
export function deleteNamedColorOperations(document: PresentationDocument, name: string, replacement?: string): PatchOperation[] {
  const value = (colorsOf(document).custom ?? {})[name];
  if (value === undefined) return [];
  const into = replacement ?? resolveColorValue(document, value) ?? value;
  return [
    ...rewriteReferences(document, namedColorToken(name), into, `/theme/colors/custom/${escape(name)}`),
    { op: "remove", path: `/theme/colors/custom/${escape(name)}` },
  ];
}

/** Replace one loose colour everywhere on the slides (any spelling of it). */
export function replaceColorOperations(document: PresentationDocument, from: string, to: string): PatchOperation[] {
  const wanted = normaliseColor(from);
  return slideColors(document)
    .filter((found) => !found.value.startsWith("token:") && normaliseColor(found.value) === wanted && found.value !== to)
    .map((found) => ({ op: "replace" as const, path: found.path, value: to }));
}

/**
 * Turn a loose colour into a named one: the name is made with that value, and
 * every use of the value on the slides now refers to the name. One patch, so one
 * Undo puts the deck back as it was.
 */
export function promoteColorOperations(document: PresentationDocument, value: string, name: string): PatchOperation[] {
  const made = addNamedColorOperations(document, name, normaliseColor(value));
  return [...made.operations, ...replaceColorOperations(document, value, made.token)];
}

/** Replace the chart series palette (the theme's, which every chart without its own uses). */
export function setChartSeriesOperations(document: PresentationDocument, series: string[]): PatchOperation[] {
  if (series.length < 6) throw new Error("A chart palette needs at least six colours.");
  return [{ op: "replace", path: "/theme/colors/chartSeries", value: series }];
}

// ----------------------------------------------------------------- contrast

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbOf(value: string | undefined): [number, number, number] | undefined {
  if (!value || !HEX_COLOR.test(value)) return undefined;
  let hex = value.slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** WCAG contrast between two resolved colours, or undefined when either is not a plain hex. */
export function contrastBetween(a: string | undefined, b: string | undefined): number | undefined {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return undefined;
  const lum = ([r, g, bl]: [number, number, number]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** The WCAG verdict a person needs: AA for text, AA for large text only, or neither. */
export function contrastVerdict(ratio: number | undefined): "AA" | "AA large" | "Low" | undefined {
  if (ratio === undefined) return undefined;
  return ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "Low";
}
