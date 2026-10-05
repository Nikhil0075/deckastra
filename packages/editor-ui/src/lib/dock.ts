/**
 * The dock under the canvas: speaker notes and the motion timeline, as two tabs
 * of one collapsible region (roadmap 08 §1.2, rule 1: the canvas comes first).
 *
 * Both used to sit open under the slide in every mode, which left the slide
 * about 40% of a 1080p window. Each mode now remembers its own dock: closed in
 * Design and Code, where the slide is the work, and open on the timeline in
 * Motion, where the timeline is. A person who opens the notes in Design keeps
 * them open in Design without the timeline following them into every mode.
 *
 * Editor state, never document state — the same rule as `panels.ts`, and kept
 * per browser profile for the same reasons, read just as defensively.
 */

import type { EditorMode } from "./editor-layout";

export type DockTab = "notes" | "timeline";

export interface DockState {
  open: boolean;
  tab: DockTab;
}

export type DockLayout = Record<EditorMode, DockState>;

export const DOCK_TABS: ReadonlyArray<{ value: DockTab; label: string }> = [
  { value: "notes", label: "Notes" },
  { value: "timeline", label: "Timeline" },
];

export const DEFAULT_DOCK: DockLayout = {
  design: { open: false, tab: "notes" },
  motion: { open: true, tab: "timeline" },
  code: { open: false, tab: "notes" },
};

const STORAGE_KEY = "deckastra.dock";
const MODES = Object.keys(DEFAULT_DOCK) as EditorMode[];

/** The saved dock for every mode, each falling back to its default on its own. */
export function loadDock(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): DockLayout {
  const out = cloneDefault();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<Record<EditorMode, Partial<DockState>>>;
    for (const mode of MODES) {
      const saved = parsed?.[mode];
      // Only real values count; anything else keeps that mode's default, so one
      // damaged entry does not reset the other modes.
      if (typeof saved?.open === "boolean") out[mode].open = saved.open;
      if (saved?.tab === "notes" || saved?.tab === "timeline") out[mode].tab = saved.tab;
    }
    return out;
  } catch {
    return cloneDefault();
  }
}

export function saveDock(layout: DockLayout, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* Not remembered, which is all a refused write costs here. */
  }
}

/**
 * Show one tab, or put the dock away if that tab is already showing. What a
 * menu item or Ctrl+Alt+4/5 means: the same key that brought the notes up puts
 * them away again.
 */
export function toggleDockTab(state: DockState, tab: DockTab): DockState {
  if (state.open && state.tab === tab) return { ...state, open: false };
  return { open: true, tab };
}

/** Pressing a tab: opens the dock on it. Pressing the tab already showing leaves it showing. */
export function selectDockTab(_state: DockState, tab: DockTab): DockState {
  return { open: true, tab };
}

/** Whether `tab` is on screen. */
export function dockShows(state: DockState, tab: DockTab): boolean {
  return state.open && state.tab === tab;
}

/** How tall the open dock's body is, in px. Motion mode gives the timeline room to work. */
export function dockBodyHeight(mode: EditorMode, tab: DockTab): number {
  if (tab === "timeline" && mode === "motion") return 300;
  return 168;
}

function cloneDefault(): DockLayout {
  return Object.fromEntries(MODES.map((mode) => [mode, { ...DEFAULT_DOCK[mode] }])) as DockLayout;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
