import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

/** Hover delay before a tooltip appears; keyboard focus shows it at once. */
export const TOOLTIP_DELAY_MS = 400;

interface TriggerProps {
  "aria-describedby"?: string;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}

export interface TooltipProps {
  content: string;
  children: ReactElement<TriggerProps>;
  placement?: "bottom" | "top" | "right";
}

/**
 * A text tooltip on hover (after a delay) and on keyboard focus (at once), wired
 * with `aria-describedby`. Supplementary only: nothing a user needs is ever
 * *only* in a tooltip, because touch has no hover and a tooltip cannot be read
 * while the pointer is elsewhere.
 */
export function Tooltip({ content, children, placement = "bottom" }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!isValidElement(children)) return children;
  const own = children.props;

  const trigger = cloneElement(children, {
    "aria-describedby": [own["aria-describedby"], open ? id : undefined].filter(Boolean).join(" ") || undefined,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event);
      clear();
      timer.current = setTimeout(() => setOpen(true), TOOLTIP_DELAY_MS);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      own.onPointerLeave?.(event);
      clear();
      setOpen(false);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      // Only for keyboard focus. A click also focuses the button, and a tooltip
      // appearing under the pointer on every click would be noise.
      if (event.currentTarget.matches?.(":focus-visible")) setOpen(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      own.onBlur?.(event);
      clear();
      setOpen(false);
    },
  });

  return (
    <span className="dk-tooltip-anchor">
      {trigger}
      {open && (
        <span role="tooltip" id={id} className={`dk-tooltip dk-tooltip--${placement}`}>
          {content}
        </span>
      )}
    </span>
  );
}
