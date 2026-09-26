import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * Where a floating panel (popover, menu, select list) goes on screen.
 *
 * Panels used to be `position: absolute` inside their trigger's anchor, so any
 * scrolling ancestor clipped them. The inspector scrolls, and the colour,
 * shape and icon pickers open towards the slide (`align="end"`), so they were
 * cut off at the panel's edge and looked as though they had gone under the
 * slide (design review, 2026-09-27). They are portalled to `document.body` now
 * and placed from the trigger's rectangle, which no ancestor can clip.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  maxHeight: number;
  /** "below" unless there was more room above the trigger. */
  side: "below" | "above";
}

export interface PlaceOptions {
  align: "start" | "end";
  /** Space between trigger and panel. */
  gap?: number;
  /** Space kept from each window edge. */
  margin?: number;
}

/** Pure placement: below when it fits (or has the most room), aligned, clamped. */
export function placePanel(
  trigger: Rect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  { align, gap = 4, margin = 8 }: PlaceOptions,
): Placement {
  const below = viewport.height - (trigger.top + trigger.height) - gap - margin;
  const above = trigger.top - gap - margin;
  const side: Placement["side"] = panel.height <= below || below >= above ? "below" : "above";
  const room = Math.max(0, side === "below" ? below : above);
  const height = Math.min(panel.height, room);
  const top = side === "below" ? trigger.top + trigger.height + gap : trigger.top - gap - height;

  const preferred = align === "start" ? trigger.left : trigger.left + trigger.width - panel.width;
  const maxLeft = viewport.width - margin - panel.width;
  const left = Math.max(margin, Math.min(preferred, maxLeft));

  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(room), side };
}

/**
 * Keep a portalled panel beside its trigger while it is open: on open, on any
 * scroll (capture phase, so the inspector's own scrolling counts), on window
 * resize, and when the panel's own size changes.
 */
export function useFloating(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  options: PlaceOptions & { matchWidth?: boolean },
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const { align, gap, margin, matchWidth } = options;

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel || typeof window === "undefined") return;
      const t = trigger.getBoundingClientRect();
      const minWidth = matchWidth ? t.width : 0;
      // Measure at natural size: a max-height from an earlier placement would
      // otherwise make the panel look shorter than it wants to be.
      const previous = panel.style.maxHeight;
      panel.style.maxHeight = "";
      const width = Math.max(panel.offsetWidth, minWidth);
      const height = panel.scrollHeight || panel.offsetHeight;
      panel.style.maxHeight = previous;
      const placed = placePanel(
        { left: t.left, top: t.top, width: t.width, height: t.height },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        { align, gap, margin },
      );
      setStyle((current) => {
        const next: CSSProperties = {
          left: placed.left,
          top: placed.top,
          maxHeight: placed.maxHeight,
          ...(matchWidth ? { minWidth } : {}),
        };
        return current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight && current.minWidth === next.minWidth
          ? current
          : next;
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [open, align, gap, margin, matchWidth, triggerRef, panelRef]);

  return style;
}

/**
 * Tab past either end of a portalled panel. The panel sits at the end of
 * `<body>`, so the browser's own Tab order would leave the editor; instead the
 * panel closes and focus goes back to its trigger, where the next Tab carries
 * on from the right place.
 */
export function leavesPanel(event: { key: string; shiftKey: boolean }, panel: HTMLElement, focusable: HTMLElement[]): boolean {
  if (event.key !== "Tab") return false;
  const active = panel.ownerDocument.activeElement;
  if (focusable.length === 0) return true;
  if (!event.shiftKey && active === focusable[focusable.length - 1]) return true;
  if (event.shiftKey && (active === focusable[0] || active === panel)) return true;
  return false;
}
