/**
 * The editor chrome's light or dark (editor Phase 8).
 *
 * A preference of the person, not of the deck: it never reaches a document, and
 * it never changes how a slide renders — a slide carries its own theme, and a
 * deck projected from a dark-mode laptop is the same deck. It lives in this
 * browser's storage, per viewer, and follows the operating system unless the
 * person has chosen otherwise.
 *
 * The resolved theme is written once, on the root element
 * (`data-dk-theme="light" | "dark"`), and `tokens.css` defines the two sets
 * against that attribute. One definition of each set, and no media-query copy
 * to drift from it.
 *
 * It is a small module store rather than React state, because several roots
 * mount at once (the editor, a drawer portalled to the body, the presenter's
 * own window) and they must agree. Another window changing the preference is
 * heard through the `storage` event, so the presenter view follows the editor.
 */

import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "deckastra.chrome-theme";
const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

function readPreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_KEY);
    return PREFERENCES.includes(stored as ThemePreference) ? (stored as ThemePreference) : "system";
  } catch {
    // Storage can throw (a private window, blocked site data). The OS decides.
    return "system";
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

interface Snapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

let current: Snapshot | null = null;
const listeners = new Set<() => void>();

function compute(): Snapshot {
  const preference = readPreference();
  return { preference, resolved: resolveTheme(preference, darkQuery()?.matches ?? false) };
}

function publish() {
  const next = compute();
  if (current && next.preference === current.preference && next.resolved === current.resolved) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.dataset.dkTheme = next.resolved;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    darkQuery()?.addEventListener("change", publish);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      darkQuery()?.removeEventListener("change", publish);
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent) {
  if (event.key === THEME_KEY || event.key === null) publish();
}

function snapshot(): Snapshot {
  if (!current) publish();
  return current!;
}

const SERVER: Snapshot = { preference: "system", resolved: "light" };

/** Choose System, Light or Dark. Stored for this viewer only. */
export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") globalThis.localStorage?.removeItem(THEME_KEY);
    else globalThis.localStorage?.setItem(THEME_KEY, preference);
  } catch {
    /* Unstored, the choice still applies to this window until it closes. */
  }
  const resolved = resolveTheme(preference, darkQuery()?.matches ?? false);
  current = { preference, resolved };
  if (typeof document !== "undefined") document.documentElement.dataset.dkTheme = resolved;
  for (const listener of listeners) listener();
}

/**
 * The chrome theme, for any root that draws editor chrome. Mounting it is what
 * writes the attribute; every root calls it, and they agree because they read
 * one store.
 */
export function useChromeTheme(): Snapshot & { setPreference: (preference: ThemePreference) => void } {
  const state = useSyncExternalStore(subscribe, snapshot, () => SERVER);
  return { ...state, setPreference: setThemePreference };
}

/** For tests: forget the cached snapshot so the next read starts fresh. */
export function resetChromeThemeForTests() {
  current = null;
}
