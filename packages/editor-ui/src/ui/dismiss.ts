import { useEffect, type RefObject } from "react";

/**
 * Close a floating surface (menu, select, popover) on Escape or on a pointer
 * press outside it.
 *
 * `pointerdown` rather than `click`: a click outside that *starts* a canvas drag
 * should close the menu at once, not when the drag ends. And the listener is on
 * the document in the capture phase, because the canvas stops propagation for
 * its own gestures and a bubbling listener would never hear about them.
 */
export function useDismiss(
  open: boolean,
  inside: ReadonlyArray<RefObject<HTMLElement | null>>,
  onDismiss: (reason: "escape" | "outside") => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && inside.some((ref) => ref.current?.contains(target))) return;
      onDismiss("outside");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onDismiss("escape");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    // `inside` is a fresh array each render; the refs in it are stable, so it is
    // deliberately not a dependency.
  }, [open, onDismiss]);
}

/** Every element inside `root` that can take keyboard focus, in tab order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
    "[contenteditable='true']",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute("inert"));
}
