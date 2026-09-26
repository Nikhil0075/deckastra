import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { rovingIndex } from "../lib/ui-keys";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";

export interface ChoiceItem<T extends string = string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Small trailing mark, e.g. the dot on "AI" when something waits for review. */
  badge?: ReactNode;
  disabled?: boolean;
  "data-testid"?: string;
}

export interface SegmentedProps<T extends string = string> {
  /** Accessible name of the group ("Fit mode", "Transition"). */
  label: string;
  value: T;
  items: readonly ChoiceItem<T>[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}

/**
 * One choice from a few, all visible (radio group). Arrows move *and* select,
 * per the radio pattern — the difference from `Tabs`, whose arrows select too
 * but which owns a panel. Only the checked item is in the tab order.
 */
export function Segmented<T extends string = string>({
  label,
  value,
  items,
  onChange,
  size = "md",
  className,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const disabled = new Set(items.flatMap((item, i) => (item.disabled ? [i] : [])));
  const checked = items.findIndex((item) => item.value === value);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = rovingIndex(index, items.length, event.key, { orientation: "horizontal", disabled });
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    if (items[next]!.value !== value) onChange(items[next]!.value);
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx("dk-segmented", `dk-segmented--${size}`, className)}>
      {items.map((item, index) => {
        const isChecked = index === checked;
        return (
          <button
            key={item.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={isChecked}
            disabled={item.disabled}
            tabIndex={isChecked || (checked < 0 && index === 0) ? 0 : -1}
            data-testid={item["data-testid"]}
            className={cx("dk-segmented__item", isChecked && "dk-segmented__item--checked")}
            onClick={() => item.value !== value && onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.icon && <Icon name={item.icon} size={14} />}
            <span>{item.label}</span>
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

export interface TabItem<T extends string = string> extends ChoiceItem<T> {
  panel: ReactNode;
}

export interface TabsProps<T extends string = string> {
  label: string;
  value: T;
  items: readonly TabItem<T>[];
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Tabs with their panels (WAI-ARIA tabs, automatic activation). Only the active
 * panel is mounted: a hidden panel that kept polling or holding a subscription
 * would cost the same as a visible one.
 */
export function Tabs<T extends string = string>({ label, value, items, onChange, className }: TabsProps<T>) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const disabled = new Set(items.flatMap((item, i) => (item.disabled ? [i] : [])));
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );
  const active = items[activeIndex];

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = rovingIndex(index, items.length, event.key, { orientation: "horizontal", disabled });
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next]!.value);
  };

  return (
    <div className={cx("dk-tabs", className)}>
      <div role="tablist" aria-label={label} className="dk-tabs__list">
        {items.map((item, index) => (
          <button
            key={item.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${item.value}`}
            aria-selected={index === activeIndex}
            aria-controls={`${id}-panel-${item.value}`}
            tabIndex={index === activeIndex ? 0 : -1}
            disabled={item.disabled}
            data-testid={item["data-testid"]}
            className={cx("dk-tabs__tab", index === activeIndex && "dk-tabs__tab--active")}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.icon && <Icon name={item.icon} size={14} />}
            <span>{item.label}</span>
            {item.badge}
          </button>
        ))}
      </div>
      {active && (
        <div
          role="tabpanel"
          id={`${id}-panel-${active.value}`}
          aria-labelledby={`${id}-tab-${active.value}`}
          tabIndex={0}
          className="dk-tabs__panel"
        >
          {active.panel}
        </div>
      )}
    </div>
  );
}

export interface SectionProps {
  title: string;
  /** Right-aligned summary shown open or closed: "12 objects", "14 versions". */
  meta?: ReactNode;
  /** Controlled open state. Omit for an uncontrolled section. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/**
 * A collapsible inspector section (disclosure pattern). The header is a real
 * button carrying `aria-expanded`; the body is unmounted when closed so a closed
 * section costs nothing.
 */
export function Section({
  title,
  meta,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  className,
  "data-testid": testId,
}: SectionProps) {
  const id = useId();
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const toggle = () => {
    if (open === undefined) setOwn(!isOpen);
    onOpenChange?.(!isOpen);
  };

  return (
    <section className={cx("dk-section", isOpen && "dk-section--open", className)} data-testid={testId}>
      <h3 className="dk-section__heading">
        <button
          type="button"
          className="dk-section__toggle"
          aria-expanded={isOpen}
          aria-controls={`${id}-body`}
          onClick={toggle}
        >
          <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} />
          <span className="dk-section__title">{title}</span>
          {meta !== undefined && <span className="dk-section__meta">{meta}</span>}
        </button>
      </h3>
      {isOpen && (
        <div id={`${id}-body`} className="dk-section__body">
          {children}
        </div>
      )}
    </section>
  );
}
