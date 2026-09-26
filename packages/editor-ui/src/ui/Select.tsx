import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { rovingIndex, typeaheadIndex } from "../lib/ui-keys";
import { cx } from "./cx";
import { useDismiss } from "./dismiss";
import { Icon } from "./icons";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  label: string;
  hideLabel?: boolean;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * A single-choice dropdown (button + listbox), replacing the native `<select>`
 * the editor used everywhere — which could not be styled to match and rendered
 * the OS's own popup on top of a Bauhaus layout.
 *
 * Choosing an option calls `onChange` once. Moving through options with the
 * arrows does not: a font picker that applied every font you arrowed past would
 * fill the undo history with fonts nobody chose.
 */
export function Select<T extends string = string>({
  label,
  hideLabel,
  value,
  options,
  onChange,
  disabled,
  className,
  "data-testid": testId,
}: SelectProps<T>) {
  const id = useId();
  const labelId = `${id}-label`;
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [active, setActive] = useState(selectedIndex);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const disabledSet = new Set(options.flatMap((option, i) => (option.disabled ? [i] : [])));
  const current = options.find((option) => option.value === value);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);
  const onDismiss = useCallback((reason: "escape" | "outside") => close(reason === "escape"), [close]);
  useDismiss(open, [listRef, buttonRef], onDismiss);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const show = () => {
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const next = rovingIndex(active, options.length, event.key, {
      orientation: "vertical",
      wrap: false,
      disabled: disabledSet,
    });
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Tab") {
      close(false);
    } else if (event.key.length === 1) {
      const found = typeaheadIndex(
        options.map((option) => option.label),
        active,
        event.key,
        disabledSet,
      );
      if (found !== null) setActive(found);
    }
  };

  return (
    <div className={cx("dk-field dk-select", className)}>
      <span id={labelId} className={hideLabel ? "dk-visually-hidden" : "dk-label"}>
        {label}
      </span>
      <span className="dk-popup-anchor">
        <button
          ref={buttonRef}
          type="button"
          className="dk-select__button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-labelledby={`${labelId} ${id}-value`}
          disabled={disabled}
          data-testid={testId}
          onClick={() => (open ? close(false) : show())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              show();
            }
          }}
        >
          <span id={`${id}-value`}>{current?.label ?? value}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        {open && (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={labelId}
            aria-activedescendant={`${id}-opt-${active}`}
            className="dk-menu dk-menu--start dk-select__list"
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={cx(
                  "dk-menu__item",
                  index === active && "dk-menu__item--active",
                  option.value === value && "dk-menu__item--selected",
                )}
                onPointerMove={() => {
                  if (!option.disabled && index !== active) setActive(index);
                }}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <Icon name="check" size={12} />}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
}
