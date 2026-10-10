import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { cx } from "./cx";

/** Arrow-key steps, in px: a plain press and a Shift press. */
export const SPLITTER_STEP = 16;
export const SPLITTER_BIG_STEP = 64;

export interface SplitterProps {
  /** What it resizes, as a person would say it: "Slides width". The accessible name. */
  label: string;
  /**
   * `vertical` sits between two columns and changes a width; `horizontal` sits
   * between two rows and changes a height. The ARIA orientation of the line.
   */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  /** Where double-click and Enter put it back. */
  defaultValue: number;
  /**
   * Which way the size grows. `1`: dragging right (or down) makes it bigger, a
   * pane on the splitter's left (or above). `-1`: a pane on its right (or below).
   */
  grows: 1 | -1;
  /** Called every animation frame of a drag, so the host can show it without a render. */
  onPreview?: (value: number) => void;
  /** The size chosen: once per intent — a drag's release, a key press, a reset. */
  onChange: (value: number) => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * A line between two panes that can be dragged, or moved with the keyboard
 * (UI audit 2026-10-10, unit 3).
 *
 * The canvas's rules hold here for the canvas's reasons: pointer moves are
 * coalesced into one animation frame, the size is committed once on release
 * (so a drag is one change, not sixty), and a cancelled drag puts the size back
 * and commits nothing. A splitter is also a WAI-ARIA window splitter: focusable,
 * named, with its value and range announced, and operable without a mouse.
 */
export function Splitter({
  label,
  orientation,
  value,
  min,
  max,
  defaultValue,
  grows,
  onPreview,
  onChange,
  className,
  "data-testid": testId,
}: SplitterProps) {
  const drag = useRef<{
    start: number;
    from: number;
    latest: number;
    frame: number | null;
    pointer: number;
    release: () => void;
  } | null>(null);

  const bounded = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  const along = (event: PointerEvent) => (orientation === "vertical" ? event.clientX : event.clientY);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The release is also listened for on the window. A pointer let go outside
    // the line, or one whose capture was lost, must still end the drag, or the
    // size is shown on screen and never kept.
    const ended = (commit: boolean) => () => finish(commit);
    const onUp = ended(true);
    const onCancel = ended(false);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("pointercancel", onCancel);
    drag.current = {
      start: along(event),
      from: value,
      latest: value,
      frame: null,
      pointer: event.pointerId,
      release: () => {
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      },
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Not every environment captures; the drag still works while over the line. */
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    current.latest = bounded(current.from + grows * (along(event) - current.start));
    if (current.frame !== null) return;
    current.frame = requestAnimationFrame(() => {
      if (!drag.current) return;
      drag.current.frame = null;
      onPreview?.(drag.current.latest);
    });
  };

  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    current.release();
    drag.current = null;
    if (commit && current.latest !== current.from) onChange(current.latest);
    else onPreview?.(current.from);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SPLITTER_BIG_STEP : SPLITTER_STEP;
    // The arrow that moves the line toward the pane makes it smaller.
    const less = orientation === "vertical" ? (grows === 1 ? "ArrowLeft" : "ArrowRight") : grows === 1 ? "ArrowUp" : "ArrowDown";
    const more = orientation === "vertical" ? (grows === 1 ? "ArrowRight" : "ArrowLeft") : grows === 1 ? "ArrowDown" : "ArrowUp";
    let next: number | null = null;
    if (event.key === less) next = value - step;
    else if (event.key === more) next = value + step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") next = defaultValue;
    if (next === null) return;
    event.preventDefault();
    const target = bounded(next);
    if (target !== value) onChange(target);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title={`${label}. Drag, or use the arrow keys. Double-click to reset.`}
      className={cx("dk-splitter", `dk-splitter--${orientation}`, className)}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => {
        if (value !== defaultValue) onChange(bounded(defaultValue));
      }}
      onKeyDown={onKeyDown}
    />
  );
}
