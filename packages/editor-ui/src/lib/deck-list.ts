/**
 * The deck list's rules (Phase 4, Figma frame "the deck list per project"):
 * how a card describes a deck, how the list is searched and sorted. Pure, so
 * tested directly.
 */

import type { PresentationSummary } from "@deckastra/workspace-contracts";

export type DeckSort = "recent" | "name";

/**
 * "edited 2h ago", written without `Intl`: relative-time output depends on the
 * ICU compiled into the runtime, the same reason number formatting in the
 * renderer is hand-written. Past a week it is a date, because "23 days ago" is
 * arithmetic the reader has to do.
 */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "never edited";
  const then = parseServerTime(iso);
  if (!Number.isFinite(then)) return "never edited";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(then);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A server timestamp as epoch milliseconds. The API stores UTC, but SQLite
 * hands a timezone-aware column back without its zone, so the desktop's
 * service answers "2026-09-19T11:53:00" where PostgreSQL answers "…+00:00".
 * `Date.parse` reads a zone-less date-time as *local* time, which put every
 * desktop timestamp hours in the past (or the future) — so no zone means UTC.
 */
export function parseServerTime(iso: string): number {
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) || !iso.includes("T") ? iso : `${iso}Z`;
  return Date.parse(zoned);
}

/** "12 slides · edited 2h ago" — the line under a card's name. */
export function deckSummary(deck: PresentationSummary, now: number): string {
  const count = deck.slide_count;
  const slides = count === null || count === undefined ? null : `${count} slide${count === 1 ? "" : "s"}`;
  const edited = `edited ${relativeTime(deck.updated_at, now)}`;
  return slides ? `${slides} · ${edited}` : edited;
}

/** "12 decks · updated 2h ago" — the line under the project title. */
export function projectSummary(decks: readonly PresentationSummary[], now: number): string {
  const count = `${decks.length} deck${decks.length === 1 ? "" : "s"}`;
  const latest = decks
    .map((deck) => deck.updated_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return latest ? `${count} · updated ${relativeTime(latest, now)}` : count;
}

/**
 * Search by title (every word must appear, case-insensitively), then sort.
 * Recent is most recently changed first — the order the API returns — with the
 * title as the tie-break so equal times do not shuffle between renders.
 */
export function visibleDecks<T extends PresentationSummary>(
  decks: readonly T[],
  query: string,
  sort: DeckSort,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = words.length
    ? decks.filter((deck) => {
        const title = deck.title.toLowerCase();
        return words.every((word) => title.includes(word));
      })
    : [...decks];

  const byTitle = (a: PresentationSummary, b: PresentationSummary) =>
    a.title.localeCompare(b.title, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);

  return matching.sort(
    sort === "name"
      ? byTitle
      : (a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || byTitle(a, b),
  );
}
