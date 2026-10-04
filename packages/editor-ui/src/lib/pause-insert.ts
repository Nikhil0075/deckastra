import { DEFAULT_PAUSE_MS, pauseMarker } from "@deckastra/presentation-schema";

const WORD = /[\p{L}\p{M}\p{N}]/u;

/**
 * Where the Pause button puts `[pause]` in a script, and where the caret goes
 * after. A pause belongs between words, so a caret inside one moves to the end
 * of that word first; a selection is replaced; the marker gets the spaces it
 * needs and no more. Marks count as part of a word, so a Devanagari vowel sign
 * is never split from its letter.
 */
export function insertPause(text: string, start: number, end = start): { text: string; caret: number } {
  let at = Math.max(0, Math.min(start, text.length));
  let to = Math.max(at, Math.min(end, text.length));
  if (at === to) {
    while (at > 0 && at < text.length && WORD.test(text[at - 1]!) && WORD.test(text[at]!)) at += 1;
    to = at;
  }
  const before = text.slice(0, at);
  const after = text.slice(to);
  const marker = `${before && !/\s$/.test(before) ? " " : ""}${pauseMarker(DEFAULT_PAUSE_MS)}${after && !/^\s/.test(after) ? " " : ""}`;
  return { text: before + marker + after, caret: at + marker.length };
}
