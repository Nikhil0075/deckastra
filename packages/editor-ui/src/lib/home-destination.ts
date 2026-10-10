/**
 * Which half of the home is on screen: the person's own decks, or the template
 * catalog (UI audit 2026-10-10, unit 1).
 *
 * They used to share one scroll, with 24 template cards above the decks, so
 * opening the home to find yesterday's deck meant scrolling past a catalog, and
 * the bar's search only ever searched decks while sitting above both. Each is a
 * destination now, with its own scroll and its own search.
 *
 * Editor state, like the panels (`panels.ts`): kept per browser profile and read
 * defensively, because that storage can be missing, full, or hold something an
 * older build wrote.
 */

export type HomeDestination = "projects" | "templates";

export const DEFAULT_DESTINATION: HomeDestination = "projects";

const STORAGE_KEY = "deckastra.home";

export function loadDestination(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): HomeDestination {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    // Only the two known words count. Anything else reads as Projects: a person
    // who opens the app is more often looking for a deck than for a template.
    return raw === "templates" || raw === "projects" ? raw : DEFAULT_DESTINATION;
  } catch {
    return DEFAULT_DESTINATION;
  }
}

export function saveDestination(
  destination: HomeDestination,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, destination);
  } catch {
    /* A remembered destination is a convenience: it simply is not remembered. */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
