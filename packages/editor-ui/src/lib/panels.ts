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

import { dockShows, toggleDockTab, type DockState, type DockTab } from "./dock";

/**
 * The regions beside the slide. Notes and the timeline are not here: they are
 * the two tabs of the dock (`dock.ts`), which each mode remembers for itself.
 */
export type PanelName = "tools" | "slides" | "inspector";

export type PanelVisibility = Record<PanelName, boolean>;

/** Everything around the slide that can be put away: the side regions and this mode's dock. */
export interface Chrome {
  panels: PanelVisibility;
  dock: DockState;
}

export const PANELS: ReadonlyArray<{ name: PanelName; label: string; shortcut: string }> = [
  { name: "tools", label: "Insert tools", shortcut: "Ctrl+Alt+1" },
  { name: "slides", label: "Slides", shortcut: "Ctrl+Alt+2" },
  { name: "inspector", label: "Side panel", shortcut: "Ctrl+Alt+3" },
];

/** The dock's tabs as the Panels menu and Ctrl+Alt+4/5 name them. */
export const DOCK_PANELS: ReadonlyArray<{ tab: DockTab; label: string; shortcut: string }> = [
  { tab: "notes", label: "Speaker notes", shortcut: "Ctrl+Alt+4" },
  { tab: "timeline", label: "Timeline", shortcut: "Ctrl+Alt+5" },
];

export const ALL_VISIBLE: PanelVisibility = { tools: true, slides: true, inspector: true };

const STORAGE_KEY = "deckastra.panels";

/**
 * The saved side regions, or all of them when nothing usable is saved. An older
 * build also stored `notes` and `dock` here; those are ignored, because the dock
 * now belongs to each mode and an old "notes: true" would reopen the squeezed
 * canvas this change exists to end.
 */
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
export const FOCUSED: PanelVisibility = { tools: false, slides: false, inspector: false };

export function isFocused(chrome: Chrome): boolean {
  return PANELS.every(({ name }) => !chrome.panels[name]) && !chrome.dock.open;
}

export function showsEverything(chrome: Chrome): boolean {
  return PANELS.every(({ name }) => chrome.panels[name]) && chrome.dock.open;
}

/** Every side region, and the dock open on whichever tab it last showed. */
export function showEverything(chrome: Chrome): Chrome {
  return { panels: { ...ALL_VISIBLE }, dock: { ...chrome.dock, open: true } };
}

/**
 * Focus mode: nothing but the slide, or everything back.
 *
 * The dock too: the canvas fits the slide to the smaller of its width and
 * height, and in a wide window the height is the limit, so hiding only the side
 * panels freed room the slide could not use. "Back" means everything, not "what
 * was open before": a toggle that restores a remembered subset reads as random
 * to someone who does not remember it.
 */
export function toggleFocus(chrome: Chrome): Chrome {
  return isFocused(chrome) ? showEverything(chrome) : { panels: { ...FOCUSED }, dock: { ...chrome.dock, open: false } };
}

/** Whether a Panels menu entry is checked. */
export function dockPanelShown(chrome: Chrome, tab: DockTab): boolean {
  return dockShows(chrome.dock, tab);
}

/** What a host (application menu) command means for the panels, if anything. */
export function panelsForCommand(command: HostCommand, chrome: Chrome): Chrome | null {
  switch (command) {
    case "panel-tools":
      return { ...chrome, panels: togglePanel(chrome.panels, "tools") };
    case "panel-slides":
      return { ...chrome, panels: togglePanel(chrome.panels, "slides") };
    case "panel-inspector":
      return { ...chrome, panels: togglePanel(chrome.panels, "inspector") };
    case "panel-notes":
      return { ...chrome, dock: toggleDockTab(chrome.dock, "notes") };
    case "panel-dock":
      return { ...chrome, dock: toggleDockTab(chrome.dock, "timeline") };
    case "panels-focus":
      return toggleFocus(chrome);
    case "panels-all":
      return showEverything(chrome);
    default:
      return null;
  }
}

/**
 * The keyboard's panel shortcuts: Ctrl+Alt+1..3 toggle a side region, 4 and 5
 * the dock's notes and timeline, and Ctrl+. toggles focus mode. Read by `code`
 * rather than `key` for the digits, because Ctrl+Alt is AltGr on many layouts
 * and `key` then reports a symbol.
 */
export function panelsForKey(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key" | "code">,
  chrome: Chrome,
): Chrome | null {
  const primary = event.ctrlKey || event.metaKey;
  if (!primary || event.shiftKey) return null;
  if (!event.altKey && event.key === ".") return toggleFocus(chrome);
  if (!event.altKey) return null;
  const digit = /^Digit([1-5])$/.exec(event.code)?.[1];
  if (!digit) return null;
  const commands: HostCommand[] = ["panel-tools", "panel-slides", "panel-inspector", "panel-notes", "panel-dock"];
  return panelsForCommand(commands[Number(digit) - 1]!, chrome);
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
