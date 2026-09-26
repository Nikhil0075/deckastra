/**
 * Moving between the editor's regions with F6 (editor Phase 8).
 *
 * The desktop convention for "go to the next part of the window": app bar, tool
 * rail, slide strip, canvas, notes, timeline, the right panel, and round again.
 * Tab moves between controls; F6 moves between regions, so reaching the panel
 * from the app bar is one key rather than forty.
 *
 * Each region's root carries `data-region`. Order is the DOM's, so a region
 * that is not rendered (the dock with no slide) is simply not a stop.
 */

export const REGION_ATTRIBUTE = "data-region";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function nextRegionIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}

/** Focus the next (or previous) region. Returns its name, or null if none. */
export function focusNextRegion(root: Document, backwards: boolean): string | null {
  const regions = [...root.querySelectorAll<HTMLElement>(`[${REGION_ATTRIBUTE}]`)].filter(
    (region) => !region.closest("[hidden]"),
  );
  const active = root.activeElement;
  const current = regions.findIndex((region) => region === active || region.contains(active));
  const next = regions[nextRegionIndex(current, regions.length, backwards)];
  if (!next) return null;
  // A region that is itself a focus target (the canvas) takes focus; otherwise
  // its first control does, and a region with none is made focusable once.
  const target =
    next.tabIndex >= 0 ? next : (next.querySelector<HTMLElement>(FOCUSABLE) ?? next);
  if (target === next && next.tabIndex < 0) next.tabIndex = -1;
  target.focus({ preventScroll: false });
  return next.getAttribute(REGION_ATTRIBUTE);
}
