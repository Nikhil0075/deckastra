import type { Script, TypographyStyle } from "@deckastra/presentation-schema";

/**
 * Typography rules per script, as data (integration plan 01 §3.9).
 *
 * A deck is designed in one script and shown in others, and some of what the
 * designer chose has no meaning — or the wrong meaning — in the second one:
 *
 * - **Indic scripts carry marks above and below the line.** At a Latin line
 *   height the matras of one line touch the descenders of the next, so the line
 *   height grows by a quarter.
 * - **Uppercase does nothing** to Devanagari, Arabic or CJK, and `uppercase`
 *   on a Latin brand word inside a Hindi heading turns it into shouting.
 * - **There is no italic** in those scripts. A browser asked for one slants the
 *   glyphs synthetically, which reads as broken type rather than emphasis.
 * - **Arabic and Hebrew run right to left**, and so does their alignment.
 *
 * Applied in the scene build, before text is measured, so the measured box and
 * the drawn box are the same box.
 */

export interface ScriptRules {
  lineHeightScale: number;
  allowUppercase: boolean;
  allowItalic: boolean;
  direction: "ltr" | "rtl";
}

const LATIN: ScriptRules = { lineHeightScale: 1, allowUppercase: true, allowItalic: true, direction: "ltr" };
const INDIC: ScriptRules = { lineHeightScale: 1.25, allowUppercase: false, allowItalic: false, direction: "ltr" };
const CJK: ScriptRules = { lineHeightScale: 1.1, allowUppercase: false, allowItalic: false, direction: "ltr" };
const RTL: ScriptRules = { lineHeightScale: 1.15, allowUppercase: false, allowItalic: false, direction: "rtl" };

export const SCRIPT_RULES: Record<Script, ScriptRules> = {
  latin: LATIN,
  cyrillic: LATIN,
  greek: LATIN,
  devanagari: INDIC,
  bengali: INDIC,
  tamil: INDIC,
  telugu: INDIC,
  kannada: INDIC,
  malayalam: INDIC,
  gujarati: INDIC,
  gurmukhi: INDIC,
  oriya: INDIC,
  thai: { ...INDIC, lineHeightScale: 1.2 },
  arabic: RTL,
  hebrew: { ...RTL, lineHeightScale: 1 },
  japanese: CJK,
  korean: CJK,
  chinese: CJK,
};

/** The default line height a style gets when it names none (doc 02 §12). */
const DEFAULT_LINE_HEIGHT = 1.3;

/**
 * A typography style adjusted for the script it will draw. Latin is returned
 * as it came, the same object, so a deck in its source language builds exactly
 * the scene it always built.
 */
export function applyScriptRules(typography: TypographyStyle, script: Script | undefined): TypographyStyle {
  const rules = script ? SCRIPT_RULES[script] : undefined;
  if (!rules || rules === LATIN) return typography;
  const next: TypographyStyle = { ...typography };
  if (rules.lineHeightScale !== 1) {
    next.lineHeight = Math.round((typography.lineHeight ?? DEFAULT_LINE_HEIGHT) * rules.lineHeightScale * 100) / 100;
  }
  if (!rules.allowUppercase && (typography.textTransform === "uppercase" || typography.textTransform === "capitalize")) {
    next.textTransform = "none";
  }
  if (!rules.allowItalic && typography.fontStyle === "italic") next.fontStyle = "normal";
  return next;
}

/**
 * Whether words may be slanted: false when any of them is in a script with no
 * italic (Devanagari, Arabic, CJK and the rest of `SCRIPT_RULES`).
 *
 * Judged on the words themselves, not the deck's language, because a span's own
 * `italic: true` bypassed the typography rule entirely: a Hindi word set italic
 * in any deck was drawn with a synthetic slant the script does not have, and a
 * Latin brand name inside a Hindi deck keeps the italic it was given.
 */
export function italicAllowed(text: string): boolean {
  for (const script of scriptsIn(text)) {
    if (SCRIPT_RULES[script]?.allowItalic === false) return false;
  }
  return true;
}

/** Left and right swap in a right-to-left script; centre and justify stay. */
export function mirrorAlign<T extends string | undefined>(align: T, direction: "ltr" | "rtl"): T {
  if (direction !== "rtl") return align;
  if (align === "left") return "right" as T;
  if (align === "right") return "left" as T;
  return align;
}

/** Unicode blocks per script, for telling which scripts a run of text uses. */
const SCRIPT_RANGES: readonly [Script, number, number][] = [
  ["devanagari", 0x0900, 0x097f],
  ["bengali", 0x0980, 0x09ff],
  ["gurmukhi", 0x0a00, 0x0a7f],
  ["gujarati", 0x0a80, 0x0aff],
  ["oriya", 0x0b00, 0x0b7f],
  ["tamil", 0x0b80, 0x0bff],
  ["telugu", 0x0c00, 0x0c7f],
  ["kannada", 0x0c80, 0x0cff],
  ["malayalam", 0x0d00, 0x0d7f],
  ["thai", 0x0e00, 0x0e7f],
  ["hebrew", 0x0590, 0x05ff],
  ["arabic", 0x0600, 0x06ff],
  ["arabic", 0x0750, 0x077f],
  ["arabic", 0x08a0, 0x08ff],
  ["arabic", 0xfb50, 0xfdff],
  ["arabic", 0xfe70, 0xfeff],
  ["greek", 0x0370, 0x03ff],
  ["cyrillic", 0x0400, 0x04ff],
  ["japanese", 0x3040, 0x30ff],
  ["korean", 0x1100, 0x11ff],
  ["korean", 0xac00, 0xd7af],
  ["chinese", 0x4e00, 0x9fff],
];

/** The non-Latin scripts a string uses. Latin, digits and punctuation are not reported. */
export function scriptsIn(text: string): Set<Script> {
  const found = new Set<Script>();
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x0370) continue;
    for (const [script, low, high] of SCRIPT_RANGES) {
      if (code >= low && code <= high) {
        found.add(script);
        break;
      }
    }
  }
  return found;
}
