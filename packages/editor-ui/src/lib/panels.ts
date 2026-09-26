/**
 * Which parts of the editor are on screen (Design tab review, 2026-09-26).
 *
 * Every region used to be permanent: the insert rail, the slide strip, the right
 * panel and the dock under the canvas. On a laptop that leaves the slide a
 * postage stamp, and a person who wants to look at the slide itself had no way
 * to clear the room around it.
 *
 * Editor state, never document state: which panels someone keeps open says
 * nothing about the deck and is not something a colleague who opens it should
 * inherit. Kept per browser profile in `localStorage`, read defensively because
 * that storage can be missing, full, or holding something an older build wrote.
 */

import type { HostCommand } from "@deckastra/workspace-contracts";

export type PanelName = "tools" | "slides" | "inspector" | "notes" | "dock";

export type PanelVisibility = Record<PanelName, boolean>;

export const PANELS: ReadonlyArray<{ name: PanelName; label: string; shortcut: string }> = [
  { name: "tools", label: "Insert tools", shortcut: "Ctrl+Alt+1" },
  { name: "slides", label: "Slides", shortcut: "Ctrl+Alt+2" },
  { name: "inspector", label: "Side panel", shortcut: "Ctrl+Alt+3" },
  { name: "notes", label: "Speaker notes", shortcut: "Ctrl+Alt+4" },
  { name: "dock", label: "Timeline", shortcut: "Ctrl+Alt+5" },
];

export const ALL_VISIBLE: PanelVisibility = { tools: true, slides: true, inspector: true, notes: true, dock: true };

const STORAGE_KEY = "deckastra.panels";

/** The saved layout, or everything visible when nothing usable is saved. */
export function loadPanels(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): PanelVisibility {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...ALL_VISIBLE };
    const parsed = JSON.parse(raw) as Partial<Record<PanelName, unknown>>;
    const out = { ...ALL_VISIBLE };
    for (const { name } of PANELS) {
      // Only a real boolean counts. Anything else an older build or a person
      // with devtools left there reads as "visible", which is the safe answer:
      // a panel that cannot be found is worse than one that can be closed.
      if (typeof parsed?.[name] === "boolean") out[name] = parsed[name] as boolean;
    }
    return out;
  } catch {
    return { ...ALL_VISIBLE };
  }
}

export function savePanels(
  visibility: PanelVisibility,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    /* A layout preference is not worth an error: it simply is not remembered. */
  }
}

export function togglePanel(visibility: PanelVisibility, name: PanelName): PanelVisibility {
  return { ...visibility, [name]: !visibility[name] };
}

/** Nothing but the slide. */
export const FOCUSED: PanelVisibility = { tools: false, slides: false, inspector: false, notes: false, dock: false };

export function isFocused(visibility: PanelVisibility): boolean {
  return PANELS.every(({ name }) => !visibility[name]);
}

/**
 * Focus mode: nothing but the slide, or everything back.
 *
 * Everything, including the notes and the timeline: the canvas fits the slide
 * to the smaller of its width and height, and in a wide window the height is
 * the limit, so hiding only the side panels freed room the slide could not use.
 * "Back" means everything, not "what was open before": a toggle that restores a
 * remembered subset reads as random to someone who does not remember it.
 */
export function toggleFocus(visibility: PanelVisibility): PanelVisibility {
  return isFocused(visibility) ? { ...ALL_VISIBLE } : { ...FOCUSED };
}

/** What a host (application menu) command means for the panels, if anything. */
export function panelsForCommand(command: HostCommand, visibility: PanelVisibility): PanelVisibility | null {
  switch (command) {
    case "panel-tools":
      return togglePanel(visibility, "tools");
    case "panel-slides":
      return togglePanel(visibility, "slides");
    case "panel-inspector":
      return togglePanel(visibility, "inspector");
    case "panel-notes":
      return togglePanel(visibility, "notes");
    case "panel-dock":
      return togglePanel(visibility, "dock");
    case "panels-focus":
      return toggleFocus(visibility);
    case "panels-all":
      return { ...ALL_VISIBLE };
    default:
      return null;
  }
}

/**
 * The keyboard's panel shortcuts: Ctrl+Alt+1..5 toggle one panel, Ctrl+.
 * toggles focus mode. Read by `code` rather than `key` for the digits, because
 * Ctrl+Alt is AltGr on many layouts and `key` then reports a symbol.
 */
export function panelsForKey(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key" | "code">,
  visibility: PanelVisibility,
): PanelVisibility | null {
  const primary = event.ctrlKey || event.metaKey;
  if (!primary || event.shiftKey) return null;
  if (!event.altKey && event.key === ".") return toggleFocus(visibility);
  if (!event.altKey) return null;
  const digit = /^Digit([1-5])$/.exec(event.code)?.[1];
  if (!digit) return null;
  return togglePanel(visibility, PANELS[Number(digit) - 1]!.name);
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
