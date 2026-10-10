/**
 * How wide the panes beside the slide are, and how tall the dock under it is
 * (UI audit 2026-10-10, unit 3).
 *
 * The strip, the side panel and the dock had fixed sizes (`--dk-strip-width`,
 * `--dk-inspector-width`, `dockBodyHeight`). A person with a wide monitor could
 * not give the inspector room for a long colour list, and one on a laptop could
 * not give the slide the room the strip was holding. Now each has a splitter
 * (`ui/Splitter.tsx`) and the sizes are remembered.
 *
 * Editor state, like the panels (`panels.ts`): kept per browser profile, never
 * written to the deck, read defensively because storage can be missing, full,
 * or hold what an older build wrote. The frozen v1 tokens stay the defaults, so
 * nothing about the design system changes for someone who never drags.
 */

import type { DockTab } from "./dock";
import { dockBodyHeight } from "./dock";
import type { EditorMode } from "./editor-layout";

export interface PaneLimits {
  min: number;
  max: number;
  default: number;
}

/** The slide strip, left of the canvas. Its thumbnails follow its width. */
export const STRIP: PaneLimits = { min: 144, max: 320, default: 176 };
/** The side panel (inspector, Motion, Code, the assistant), right of the canvas. */
export const INSPECTOR: PaneLimits = { min: 280, max: 520, default: 288 };
/** The Assistant's column, beside the side panel (UI audit unit 4). */
export const ASSISTANT: PaneLimits = { min: 360, max: 560, default: 360 };
/**
 * The window width from which the Assistant sits beside the side panel. Below
 * it, opening the Assistant puts the side panel away for as long as it is open:
 * both at once leave a 1440px window's slide a postage stamp. Nothing about the
 * side panel changes, so closing the Assistant brings it back as it was.
 */
export const ASSISTANT_BESIDE = 1600;
/** The dock under the canvas. Its ceiling is a share of the window, not a number. */
export const DOCK_MIN = 160;
export const DOCK_MAX_SHARE = 0.55;

/**
 * The narrowest canvas the layout will leave before it starts putting things
 * away. Below this a 16:9 slide is too small to edit at a laptop's distance.
 * A 1024px window with every pane at its default leaves 512px, which is usable,
 * so that window keeps everything: putting the strip away there would surprise
 * someone who never asked for it.
 */
export const MIN_CANVAS = 480;
/** The insert rail, and the Add library / Layers / Check column beside it. */
export const RAIL_WIDTH = 48;
export const LIBRARY_WIDTH = 300;

export interface LayoutSizes {
  strip: number;
  inspector: number;
  assistant: number;
  /** Dock body heights chosen by dragging, by mode and tab. Absent: the default. */
  dock: Partial<Record<`${EditorMode}:${DockTab}`, number>>;
}

export const DEFAULT_SIZES: LayoutSizes = { strip: STRIP.default, inspector: INSPECTOR.default, assistant: ASSISTANT.default, dock: {} };

const STORAGE_KEY = "deckastra.layout";

export function clamp(value: number, limits: Pick<PaneLimits, "min" | "max">): number {
  if (!Number.isFinite(value)) return limits.min;
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

export function dockLimits(windowHeight: number): Pick<PaneLimits, "min" | "max"> {
  return { min: DOCK_MIN, max: Math.max(DOCK_MIN, Math.floor(windowHeight * DOCK_MAX_SHARE)) };
}

/** The dock body height for a mode and tab: what was dragged, or the default, within the window. */
export function dockHeight(sizes: LayoutSizes, mode: EditorMode, tab: DockTab, windowHeight: number): number {
  const chosen = sizes.dock[`${mode}:${tab}`] ?? dockBodyHeight(mode, tab);
  return clamp(chosen, dockLimits(windowHeight));
}

export function withDock(sizes: LayoutSizes, mode: EditorMode, tab: DockTab, height: number, windowHeight: number): LayoutSizes {
  return { ...sizes, dock: { ...sizes.dock, [`${mode}:${tab}`]: clamp(height, dockLimits(windowHeight)) } };
}

export function loadLayout(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): LayoutSizes {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw) as Partial<Record<keyof LayoutSizes, unknown>>;
    const out = cloneDefault();
    // Only numbers count, and they are brought back inside today's limits: an
    // older build may have allowed something this one does not.
    if (typeof parsed.strip === "number") out.strip = clamp(parsed.strip, STRIP);
    if (typeof parsed.inspector === "number") out.inspector = clamp(parsed.inspector, INSPECTOR);
    if (typeof parsed.assistant === "number") out.assistant = clamp(parsed.assistant, ASSISTANT);
    if (parsed.dock && typeof parsed.dock === "object") {
      for (const [key, value] of Object.entries(parsed.dock as Record<string, unknown>)) {
        if (/^(design|motion|code):(notes|timeline)$/.test(key) && typeof value === "number" && Number.isFinite(value)) {
          out.dock[key as keyof LayoutSizes["dock"]] = Math.max(DOCK_MIN, Math.round(value));
        }
      }
    }
    return out;
  } catch {
    return cloneDefault();
  }
}

export function saveLayout(sizes: LayoutSizes, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    /* A remembered width is a convenience: it simply is not remembered. */
  }
}

export interface Visible {
  tools: boolean;
  library: boolean;
  slides: boolean;
  inspector: boolean;
  /** The Assistant's column is open. It is never trimmed: it was just asked for. */
  assistant?: boolean;
}

export interface FittedLayout {
  strip: number;
  inspector: number;
  /** The strip is put away for now because the window cannot hold it. */
  stripCollapsed: boolean;
}

/**
 * What the window can actually hold, without changing what was chosen.
 *
 * Only below `MIN_CANVAS` does anything yield: the strip and then the side
 * panel come down toward their minimums, and then the strip is put away.
 * Above it the chosen sizes stand. Trimming panes earlier, to give a laptop's
 * slide a target share, was tried and dropped (2026-10-10): at 1366px even
 * both minimums leave the slide 59%, so it bought a smaller strip at the
 * desktop's own window size for a target it could not reach. It never puts away the side panel or the
 * library: those are what someone just opened or is working in, and closing one
 * under them would make the button that opened it look broken. Nothing here is
 * saved: widen the window and the chosen sizes come back.
 */
export function fitLayout(sizes: LayoutSizes, windowWidth: number, visible: Visible): FittedLayout {
  let strip = clamp(sizes.strip, STRIP);
  let inspector = clamp(sizes.inspector, INSPECTOR);
  const fixed =
    (visible.tools ? RAIL_WIDTH : 0) +
    (visible.library ? LIBRARY_WIDTH : 0) +
    (visible.assistant ? clamp(sizes.assistant, ASSISTANT) : 0);
  const canvas = (stripShown: boolean) =>
    windowWidth - fixed - (stripShown && visible.slides ? strip : 0) - (visible.inspector ? inspector : 0);

  if (canvas(true) >= MIN_CANVAS) return { strip, inspector, stripCollapsed: false };

  // Give back what the panes have above their minimums, the strip first: the
  // side panel holds the controls being used.
  let short = MIN_CANVAS - canvas(true);
  if (visible.slides) {
    const give = Math.min(short, strip - STRIP.min);
    strip -= give;
    short -= give;
  }
  if (short > 0 && visible.inspector) {
    inspector -= Math.min(short, inspector - INSPECTOR.min);
  }
  if (canvas(true) >= MIN_CANVAS) return { strip, inspector, stripCollapsed: false };
  return { strip, inspector, stripCollapsed: visible.slides };
}

/** Whether the side panel shows: it gives way to an open Assistant in a narrow window. */
export function sidePanelShows(inspectorWanted: boolean, assistantOpen: boolean, windowWidth: number): boolean {
  return inspectorWanted && !(assistantOpen && windowWidth < ASSISTANT_BESIDE);
}

function cloneDefault(): LayoutSizes {
  return { ...DEFAULT_SIZES, dock: {} };
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
