import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

import { hexToRgb, rgbToHex } from "./color-math";
import { contrastBetween, CUSTOM_PREFIX, namedColorToken, resolveColorValue } from "./colors";

/**
 * Colour modes and colour roles (design review, 2026-09-27).
 *
 * A **mode** is a set of colour overrides on the theme (`theme.modes`), chosen
 * per slide (`slide.colorMode`): a dark version of a light deck, or a section
 * in a second palette. Only colours change, and everything that refers to a
 * colour token follows the mode, so one deck can carry both without a second
 * copy of any slide.
 *
 * A **role** is a named colour that points at another colour rather than
 * holding a value: "On primary" is `token:colors.background`. It says what a
 * colour is for, and it follows the colour it names — including into a mode.
 */

type Colors = Record<string, unknown>;
type Mode = { appearance?: "light" | "dark"; colors: Colors };

export function colorModes(document: PresentationDocument): Array<{ name: string; mode: Mode }> {
  const modes = (document.theme.modes ?? {}) as Record<string, Mode>;
  return Object.entries(modes).map(([name, mode]) => ({ name, mode }));
}

export function modeNameProblem(document: PresentationDocument, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Give the mode a name.";
  if (trimmed.length > 40) return "Keep the name under 40 characters.";
  if (/[./~]/.test(trimmed)) return "A mode name cannot contain a full stop or a slash.";
  if (colorModes(document).some((mode) => mode.name.toLowerCase() === trimmed.toLowerCase())) return `There is already a mode called "${trimmed}".`;
  return undefined;
}

/**
 * The opposite appearance of the theme, generated: surfaces and text swap
 * lightness, keeping their hue; brand colours stay, and the text that sits on
 * each brand colour is re-chosen so it still reads. The result is a starting
 * point a person then adjusts, not a verdict.
 */
export function generateOppositeMode(document: PresentationDocument): Mode {
  const colors = document.theme.colors as unknown as Colors;
  const dark = (document.theme.mode ?? "light") !== "dark";
  const resolve = (token: string) => resolveColorValue(document, `token:colors.${token}`);
  const out: Colors = {};

  for (const token of ["background", "surface", "surfaceAlt", "foreground", "foregroundMuted", "foregroundSubtle", "border", "borderStrong", "divider", "accentMuted"]) {
    const value = resolve(token);
    if (typeof colors[token] === "string" && value) out[token] = invertLightness(value);
  }
  out.overlay = dark ? "#000000B3" : "#FFFFFFCC";

  for (const [brand, on] of [["accent", "accentForeground"], ["secondary", "secondaryForeground"]] as const) {
    const fill = resolve(brand);
    if (!fill || typeof colors[on] !== "string") continue;
    const light = "#FFFFFF";
    const deep = "#111111";
    out[on] = (contrastBetween(light, fill) ?? 0) >= (contrastBetween(deep, fill) ?? 0) ? light : deep;
  }
  return { appearance: dark ? "dark" : "light", colors: out };
}

export function addModeOperations(document: PresentationDocument, name: string, mode: Mode): PatchOperation[] {
  const trimmed = name.trim();
  return document.theme.modes
    ? [{ op: "add", path: `/theme/modes/${escape(trimmed)}`, value: mode }]
    : [{ op: "add", path: "/theme/modes", value: { [trimmed]: mode } }];
}

/** Delete a mode, and put the slides that used it back on the theme's colours, in one patch. */
export function removeModeOperations(document: PresentationDocument, name: string): PatchOperation[] {
  if (!(document.theme.modes ?? {})[name]) return [];
  const operations: PatchOperation[] = document.slides
    .filter((slide) => slide.colorMode === name)
    .map((slide) => ({ op: "remove", path: `/slides/id:${slide.id}/colorMode` }));
  operations.push(
    Object.keys(document.theme.modes ?? {}).length === 1 ? { op: "remove", path: "/theme/modes" } : { op: "remove", path: `/theme/modes/${escape(name)}` },
  );
  return operations;
}

/** Set (or, with `undefined`, clear back to the theme's) one colour in a mode. */
export function setModeColorOperations(document: PresentationDocument, name: string, token: string, value: string | undefined): PatchOperation[] {
  const mode = ((document.theme.modes ?? {}) as Record<string, Mode>)[name];
  if (!mode) return [];
  const path = `/theme/modes/${escape(name)}/colors/${escape(token)}`;
  const exists = mode.colors?.[token] !== undefined;
  if (value === undefined) return exists ? [{ op: "remove", path }] : [];
  if (exists && mode.colors[token] === value) return [];
  return [{ op: exists ? "replace" : "add", path, value }];
}

/** The colour a mode draws a theme token with: its override, or the theme's. */
export function modeColor(document: PresentationDocument, mode: string | undefined, token: string): string | undefined {
  const override = mode ? ((document.theme.modes ?? {}) as Record<string, Mode>)[mode]?.colors?.[token] : undefined;
  const value = typeof override === "string" ? override : ((document.theme.colors as unknown as Colors)[token] as string | undefined);
  if (!value) return undefined;
  if (!mode || !value.startsWith("token:")) return resolveColorValue(document, value);
  // A reference inside a mode resolves against the mode too.
  const target = value.slice("token:colors.".length);
  return target.includes(".") ? resolveColorValue(document, value) : modeColor(document, mode, target);
}

/** Put slides in a mode, or back on the theme's colours with `undefined`. */
export function slideModeOperations(document: PresentationDocument, slideIds: readonly string[], mode: string | undefined): PatchOperation[] {
  const operations: PatchOperation[] = [];
  for (const slide of document.slides) {
    if (!slideIds.includes(slide.id) || slide.colorMode === mode) continue;
    const path = `/slides/id:${slide.id}/colorMode`;
    if (mode === undefined) operations.push({ op: "remove", path });
    else operations.push({ op: slide.colorMode === undefined ? "add" : "replace", path, value: mode });
  }
  return operations;
}

// ------------------------------------------------------------------- roles

/** The roles a deck is offered, each pointing at the theme colour it usually is. */
export const STANDARD_ROLES: ReadonlyArray<{ name: string; token: string }> = [
  { name: "Primary", token: "accent" },
  { name: "On primary", token: "accentForeground" },
  { name: "Surface", token: "surface" },
  { name: "On surface", token: "foreground" },
  { name: "Data positive", token: "chartPositive" },
  { name: "Data negative", token: "chartNegative" },
  { name: "Warning", token: "warning" },
];

/** Add the standard roles the deck does not have yet, as references, in one patch. */
export function standardRolesOperations(document: PresentationDocument): PatchOperation[] {
  const colors = document.theme.colors as unknown as Colors;
  const custom = (colors.custom ?? {}) as Record<string, string>;
  const missing = STANDARD_ROLES.filter((role) => custom[role.name] === undefined && typeof colors[role.token] === "string");
  if (missing.length === 0) return [];
  const entries = Object.fromEntries(missing.map((role) => [role.name, `token:colors.${role.token}`]));
  if (!colors.custom) return [{ op: "add", path: "/theme/colors/custom", value: entries }];
  return Object.entries(entries).map(([name, value]) => ({ op: "add" as const, path: `/theme/colors/custom/${escape(name)}`, value }));
}

/** What a named colour points at, when it is a reference: a theme role or another name. */
export function aliasOf(value: string | undefined): string | undefined {
  return value?.startsWith("token:colors.") ? value : undefined;
}

/**
 * Whether pointing `name` at `target` would make a loop: `target`, followed
 * through the references it makes, arriving back at `name`.
 */
export function wouldLoop(document: PresentationDocument, name: string, target: string): boolean {
  const custom = ((document.theme.colors as unknown as Colors).custom ?? {}) as Record<string, string>;
  let current: string | undefined = target;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (current === namedColorToken(name)) return true;
    if (!current.startsWith(CUSTOM_PREFIX)) return false;
    current = aliasOf(custom[current.slice(CUSTOM_PREFIX.length)]);
  }
  return Boolean(current);
}

// ------------------------------------------------------------------ helpers

function invertLightness(hex: string): string {
  const rgb = hexToRgb(hex.slice(0, 7));
  if (!rgb) return hex;
  const [h, s, l] = toHsl(...rgb);
  // Not a straight 1 − L: pure black and white read harshly as surfaces, so
  // the inverted value is kept a little off each end.
  const inverted = Math.min(0.97, Math.max(0.06, 1 - l));
  return rgbToHex(...fromHsl(h, s * 0.9, inverted)) + (hex.length === 9 ? hex.slice(7) : "");
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6 : max === gn ? ((bn - rn) / d + 2) / 6 : ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)];
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
