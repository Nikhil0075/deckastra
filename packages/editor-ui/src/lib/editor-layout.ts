/**
 * Editor layout state: which mode the right panel is in, and how big the canvas
 * is drawn.
 *
 * All of it is **editor state**, never document state (doc 02 §4.1: camera and
 * zoom are facts nobody else needs to agree on). It lives in pure functions so
 * the rules are testable without rendering the shell, which nothing in this
 * repository does — the editor measures text, and jsdom has no layout.
 */

/**
 * The editor's modes (doc 01 §6). Present is not one of them: it replaces the
 * whole window and is entered with a button, not switched to from a panel.
 */
export type EditorMode = "design" | "motion" | "code";

export const EDITOR_MODES: ReadonlyArray<{ value: EditorMode; label: string }> = [
  { value: "design", label: "Design" },
  { value: "motion", label: "Motion" },
  // Read-only in V1 (doc 01 §6.4): a view of the canonical JSON, never an editor
  // of it. Editing JSON directly would be a second mutation path.
  { value: "code", label: "Code" },
];

// ----------------------------------------------------------------------- zoom

/**
 * `"fit"` follows the available width; a number is a fixed scale where 1 draws
 * the slide at its logical size (1920 wide for a 1080p deck).
 */
export type Zoom = "fit" | number;

/** The discrete steps − and + move between. */
export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

/** Padding kept clear around the slide inside the stage, per side, in px. */
export const STAGE_PADDING = 32;

/**
 * Clearance above the slide for the canvas toolbar (zoom, frame readout), which
 * floats over the stage's top-left. Without it a height-limited fit puts the
 * slide's top edge under the toolbar. `.dk-stage`'s padding must match.
 */
export const STAGE_TOP = 56;

/**
 * The scale "fit" means for a stage of `available` × `availableHeight` px: the
 * whole slide visible with padding on every side. Both axes, one factor — the
 * same rule as `fitToDisplay`, because a slide scaled per-axis is distorted.
 * Never zero or negative, so a collapsed window still draws something.
 */
export function fitScale(
  available: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  const width = Math.max(1, available.width - STAGE_PADDING * 2);
  const height = Math.max(1, available.height - STAGE_TOP - STAGE_PADDING);
  const scale = Math.min(width / viewport.width, height / viewport.height);
  return Math.max(0.05, round(scale));
}

/** The scale actually drawn for a zoom setting. */
export function resolveScale(zoom: Zoom, fit: number): number {
  return zoom === "fit" ? fit : zoom;
}

/**
 * The next step in `direction` from the scale currently drawn. From "fit" that
 * is the nearest step beyond the fitted scale, so − after fit always makes the
 * slide smaller and + always larger — never a no-op that lands on the same size.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0]!;
}

/** "46%". */
export function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
