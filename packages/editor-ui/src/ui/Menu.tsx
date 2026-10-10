import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { rovingIndex, typeaheadIndex } from "../lib/ui-keys";
import { cx } from "./cx";
import { useDismiss } from "./dismiss";
import { useFloating } from "./floating";
import { Icon, type IconName } from "./icons";
import { floatingPortal } from "./overlays";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** A destructive item: red text, and conventionally last. */
  danger?: boolean;
  disabled?: boolean;
  /**
   * One choice among several (the chrome theme). Set on every item of the group
   * and it renders as `menuitemradio` with `aria-checked`, so a screen reader
   * says which is chosen instead of reading three identical buttons.
   */
  checked?: boolean;
  /**
   * `checkbox` for an on/off item that is not one of a set (a panel shown or
   * hidden). Defaults to `radio`, which is what `checked` meant before.
   */
  kind?: "radio" | "checkbox";
  /** A key shown at the end of the row. Display only; the shortcut is handled elsewhere. */
  shortcut?: string;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: (element: HTMLButtonElement | null) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  /** Renders the trigger. Spread the props onto a `<button>` (or `Button`/`IconButton`). */
  trigger: (props: MenuTriggerProps) => ReactNode;
  items: readonly MenuItem[];
  /** Accessible name of the menu itself, e.g. "Deck actions". */
  label: string;
  align?: "start" | "end";
  /**
   * Shown above the items and outside the `menu` role (the account card: who is
   * signed in, and their credits). Read, never focused: the arrows still move
   * only between items.
   */
  header?: ReactNode;
}

/**
 * An action menu (WAI-ARIA menu button pattern): arrows move, Home/End jump,
 * typing jumps by first letter, Enter/Space activates, Escape closes and hands
 * focus back to the trigger. Disabled items are skipped by the keyboard, never
 * landed on.
 */
export function Menu({ trigger, items, label, align = "start", header }: MenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const disabled = new Set(items.flatMap((item, i) => (item.disabled ? [i] : [])));

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  const onDismiss = useCallback((reason: "escape" | "outside") => close(reason === "escape"), [close]);
  useDismiss(open, [listRef, triggerRef], onDismiss);
  // Portalled and placed from the trigger, so a scrolling panel cannot clip it.
  const position = useFloating(open, triggerRef, listRef, { align });

  const openAt = (where: "first" | "last") => {
    const index = rovingIndex(where === "first" ? -1 : items.length, items.length, where === "first" ? "Home" : "End", {
      orientation: "vertical",
      disabled,
    });
    setActive(index ?? 0);
    setOpen(true);
  };

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingIndex(active, items.length, event.key, { orientation: "vertical", disabled });
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      return;
    }
    if (event.key === "Tab") {
      // The list lives at the end of <body>; hand focus back to the trigger so
      // the Tab moves on from where the menu was opened.
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key)) {
      const found = typeaheadIndex(
        items.map((item) => item.label),
        active,
        event.key,
        disabled,
      );
      if (found !== null) setActive(found);
    }
  };

  const rows = items.map((item, index) => (
    <button
      key={item.id}
      ref={(element) => {
        itemRefs.current[index] = element;
      }}
      type="button"
      role={item.checked === undefined ? "menuitem" : item.kind === "checkbox" ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={item.checked}
      tabIndex={index === active ? 0 : -1}
      aria-disabled={item.disabled || undefined}
      className={cx("dk-menu__item", item.danger && "dk-menu__item--danger")}
      onClick={() => activate(item)}
      onPointerMove={() => {
        if (!item.disabled && index !== active) setActive(index);
      }}
    >
      {item.icon && <Icon name={item.icon} size={14} />}
      <span>{item.label}</span>
      {item.shortcut ? <kbd className="dk-menu__shortcut">{item.shortcut}</kbd> : null}
      {item.checked ? <Icon name="check" size={14} className="dk-icon dk-menu__check" /> : null}
    </button>
  ));

  return (
    <span className="dk-popup-anchor">
      {trigger({
        ref: (element) => {
          triggerRef.current = element;
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
        onClick: () => (open ? close(false) : openAt("first")),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(event.key === "ArrowDown" ? "first" : "last");
          }
        },
      })}
      {open &&
        floatingPortal(
          header === undefined ? (
            <div
              ref={listRef}
              id={menuId}
              role="menu"
              aria-label={label}
              className={cx("dk-menu", `dk-menu--${align}`)}
              style={position}
              onKeyDown={onListKeyDown}
            >
              {rows}
            </div>
          ) : (
            // The header sits beside the menu, not inside it: a `menu` may own
            // only items, and a screen reader reads the card as ordinary text.
            <div ref={listRef} className={cx("dk-menu", "dk-menu--carded", `dk-menu--${align}`)} style={position}>
              <div className="dk-menu__header">{header}</div>
              <div id={menuId} role="menu" aria-label={label} className="dk-menu__items" onKeyDown={onListKeyDown}>
                {rows}
              </div>
            </div>
          ),
        )}
    </span>
  );
}
