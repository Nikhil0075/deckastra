import { localeTextHash } from "./locales";

/**
 * Which pronunciations a voiced line used (integration plan 01 §7).
 *
 * A take records this fingerprint as `sayAs`, so changing how a name is said
 * marks exactly the lines that say that name as due for voicing again — a
 * script hash alone could not, because the words did not change. Lines that do
 * not use a changed name keep their recordings, and so does anything recorded
 * or uploaded, which no pronunciation ever touched.
 *
 * Written twice, here and in `apps/api/deckastra_api/speech.py` (`_find`,
 * `say_as_fingerprint`), because the panel counts what is due and the service
 * decides what to voice. Both are held to the same fixed vectors in their
 * tests, so a change to one fails until the other agrees.
 */
export interface Pronunciation {
  term: string;
  say: string;
}

/**
 * A letter, a combining mark, a digit or "_": what a whole word is made of.
 * Marks count — a Devanagari vowel sign is one, and treating it as a boundary
 * found "डेक" inside "डेकास्ट्रा".
 */
const WORD = /^[\p{L}\p{M}\p{N}_]$/u;
const isWord = (char: string | undefined): boolean => char !== undefined && WORD.test(char);

/**
 * Each whole-word use of a term, left to right, longest term first,
 * case-insensitive; the first entry for a term wins. A scan over code points
 * rather than a regular expression, so it says exactly what the Python twin
 * says: two engines' ideas of a word boundary are how two fingerprints of one
 * line come to disagree.
 */
export function findPronunciations(text: string, list: readonly Pronunciation[]): { start: number; end: number; item: Pronunciation }[] {
  const first = new Map<string, Pronunciation>();
  for (const item of list) {
    const key = item.term.toLowerCase();
    if (item.term.trim() && !first.has(key)) first.set(key, item);
  }
  const terms = [...first.values()]
    .map((item) => ({ item, chars: Array.from(item.term.toLowerCase()) }))
    .sort((a, b) => b.chars.length - a.chars.length);
  if (!terms.length) return [];
  const chars = Array.from(text);
  const found: { start: number; end: number; item: Pronunciation }[] = [];
  let i = 0;
  while (i < chars.length) {
    let hit: { start: number; end: number; item: Pronunciation } | undefined;
    if (i === 0 || !isWord(chars[i - 1])) {
      for (const term of terms) {
        const end = i + term.chars.length;
        if (end > chars.length) continue;
        if (chars.slice(i, end).join("").toLowerCase() !== term.chars.join("")) continue;
        if (end < chars.length && isWord(chars[end])) continue;
        hit = { start: i, end, item: term.item };
        break;
      }
    }
    if (hit) {
      found.push(hit);
      i = hit.end;
    } else {
      i += 1;
    }
  }
  return found;
}

/** The pronunciations `text` actually uses, ordered by term. */
export function applicablePronunciations(text: string, list: readonly Pronunciation[]): Pronunciation[] {
  const used = new Map<string, Pronunciation>();
  for (const { item } of findPronunciations(text, list)) used.set(item.term.toLowerCase(), item);
  return [...used.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
}

/** "" when the line uses none; otherwise a hash of what it uses, as a take records it. */
export function sayAsFingerprint(text: string, list: readonly Pronunciation[], rate = 1): string {
  // The speaking rate is part of how a line was delivered, when it is not 1:
  // a line said plainly at the normal rate stays "", so takes voiced before
  // either control existed stay current.
  const parts = applicablePronunciations(text, list).map((item) => `${item.term.toLowerCase()}=${item.say}`);
  if (Math.abs(rate - 1) > 1e-9) parts.push(`rate=${rate.toFixed(2)}`);
  if (!parts.length) return "";
  return localeTextHash(parts.join("\n"));
}

// ------------------------------------------------------------------ pauses

/**
 * A pause written into a narration script: `[pause]` (half a second),
 * `[pause 1.5s]` or `[pause 800ms]`. Plain text, so it travels wherever a
 * script does — an overlay, an agent's proposal, Code mode — and the
 * translator keeps it as it keeps a number. The service turns it into SSML
 * `<break>` (`speech.py`, the same grammar).
 */
export const PAUSE_PATTERN = /\[pause(?:\s+(\d+(?:\.\d+)?)\s*(ms|s))?\]/gi;
export const DEFAULT_PAUSE_MS = 500;

/** The milliseconds a script's pause markers add, as the service counts them. */
export function pauseMsIn(text: string): number {
  let total = 0;
  for (const match of text.matchAll(PAUSE_PATTERN)) {
    if (!match[1]) {
      total += DEFAULT_PAUSE_MS;
      continue;
    }
    const value = Number(match[1]) * (match[2]!.toLowerCase() === "ms" ? 1 : 1000);
    total += Math.max(100, Math.min(10_000, Math.round(value)));
  }
  return total;
}

/** A script as a person reads it: the pause markers taken out. */
export function scriptForDisplay(text: string): string {
  return text.replace(PAUSE_PATTERN, " ").replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:।،])/g, "$1").trim();
}

/** The marker for a pause of `ms`, as the Pause button writes it. */
export function pauseMarker(ms: number): string {
  if (ms === DEFAULT_PAUSE_MS) return "[pause]";
  return ms % 1000 === 0 ? `[pause ${ms / 1000}s]` : `[pause ${ms}ms]`;
}
