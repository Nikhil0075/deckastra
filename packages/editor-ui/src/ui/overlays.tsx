import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cx } from "./cx";
import { focusableWithin, useDismiss } from "./dismiss";
import { IconButton } from "./Button";
import { leavesPanel, useFloating } from "./floating";

export interface PopoverTriggerProps {
  ref: (element: HTMLButtonElement | null) => void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
}

export interface PopoverProps {
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Accessible name of the panel ("Share", "Export"). */
  label: string;
  align?: "start" | "end";
  /** Controlled open state; omit to let the popover manage itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  /**
   * Keep the panel's content mounted while closed (hidden). For panels that own
   * work in progress — an export polling its job would otherwise forget the job
   * the moment someone closed the popover to keep editing.
   */
  keepMounted?: boolean;
  "data-testid"?: string;
}

/**
 * A non-modal panel anchored under its trigger — Share and Export in the top
 * bar, the colour, shape, icon and font pickers. Focus moves into it on open
 * and back to the trigger on Escape. A press outside closes it without
 * stealing focus back, because that press was the user going somewhere else.
 *
 * The panel is portalled to `document.body` and placed from the trigger's
 * rectangle (`useFloating`), so a scrolling inspector cannot clip it.
 */
export function Popover({
  trigger,
  label,
  align = "end",
  open,
  onOpenChange,
  children,
  className,
  keepMounted = false,
  "data-testid": testId,
}: PopoverProps) {
  const id = useId();
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setOwn(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );
  const onDismiss = useCallback(
    (reason: "escape" | "outside") => {
      setOpen(false);
      if (reason === "escape") triggerRef.current?.focus();
    },
    [setOpen],
  );
  useDismiss(isOpen, [panelRef, triggerRef], onDismiss);
  const position = useFloating(isOpen, triggerRef, panelRef, { align });

  useEffect(() => {
    if (!isOpen || !panelRef.current) return;
    (focusableWithin(panelRef.current)[0] ?? panelRef.current).focus();
  }, [isOpen]);

  return (
    <span className="dk-popup-anchor">
      {trigger({
        ref: (element) => {
          triggerRef.current = element;
        },
        "aria-haspopup": "dialog",
        "aria-expanded": isOpen,
        "aria-controls": isOpen ? id : undefined,
        onClick: () => setOpen(!isOpen),
      })}
      {(isOpen || keepMounted) &&
        floatingPortal(
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            hidden={!isOpen}
            data-testid={testId}
            className={cx("dk-popover", `dk-popover--${align}`, className)}
            style={position}
            onKeyDown={(event) => {
              const panel = panelRef.current;
              if (!panel || !leavesPanel(event, panel, focusableWithin(panel))) return;
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            {children}
          </div>,
        )}
    </span>
  );
}

/**
 * Put a floating panel at the end of `<body>`. Outside a browser (a server
 * render) it stays inline, which is where it always used to be.
 */
export function floatingPortal(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Right-aligned beside the title ("14 versions"). */
  meta?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /**
   * Modal drawers dim and block the editor behind them (version history, where
   * the canvas shows a *past* version and editing it would be a lie). Non-modal
   * drawers leave the editor live.
   */
  modal?: boolean;
  width?: number;
  /**
   * Where it sits. `side` is the panel from the right edge. `center` is a wide
   * modal dialog, and `full` fills the window (Settings on the desktop, where
   * there is nothing behind it worth keeping in view).
   */
  placement?: "side" | "center" | "full";
  "data-testid"?: string;
}

/**
 * A panel from the right edge. Portalled to `document.body` so no ancestor's
 * `overflow` or `transform` clips it. When modal, Tab cycles inside it, Escape
 * and the scrim close it, and focus returns to whatever opened it.
 */
export function Drawer({
  open,
  onClose,
  title,
  meta,
  footer,
  children,
  modal = true,
  width,
  placement = "side",
  "data-testid": testId,
}: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) (focusableWithin(panel)[0] ?? panel).focus();
    return () => {
      returnTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!modal || event.key !== "Tab" || !panelRef.current) return;
    const focusable = focusableWithin(panelRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={cx("dk-drawer-layer", modal && "dk-drawer-layer--modal")}>
      {modal && <div className="dk-scrim" onClick={onClose} aria-hidden="true" />}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx("dk-drawer", placement !== "side" && `dk-drawer--${placement}`)}
        data-placement={placement}
        style={width && placement !== "full" ? { width } : undefined}
        data-testid={testId}
        onKeyDown={trapTab}
      >
        <header className="dk-drawer__header">
          <h2 id={titleId} className="dk-drawer__title">
            {title}
          </h2>
          {meta !== undefined && <span className="dk-drawer__meta">{meta}</span>}
          <IconButton icon="close" label={`Close ${title.toLowerCase()}`} size="sm" onClick={onClose} />
        </header>
        <ScrollArea className="dk-drawer__body">{children}</ScrollArea>
        {footer && <footer className="dk-drawer__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Give the region a name and make it keyboard-scrollable. Without a label it
   * is a plain styled scroller — naming every scrolling div would flood the
   * landmarks list.
   */
  label?: string;
}

/** A scroll container with the thin black Bauhaus scrollbar. */
export function ScrollArea({ label, className, children, ...rest }: ScrollAreaProps) {
  return (
    <div
      className={cx("dk-scroll", className)}
      role={label ? "region" : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}
