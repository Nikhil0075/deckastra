import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { parseNumberInput, stepNumber } from "../lib/ui-keys";
import { cx } from "./cx";

/** The uppercase, tracked micro-label every field and section header uses. */
export function Label({ children, htmlFor, id }: { children: ReactNode; htmlFor?: string; id?: string }) {
  return (
    <label className="dk-label" htmlFor={htmlFor} id={id}>
      {children}
    </label>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  /** Visually hide the label but keep it as the accessible name — for search boxes with an icon. */
  hideLabel?: boolean;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hideLabel, value, onChange, hint, error, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  return (
    <div className={cx("dk-field", className)}>
      <label className={hideLabel ? "dk-visually-hidden" : "dk-label"} htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className={cx("dk-input", error && "dk-input--invalid")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? hintId : undefined}
        {...rest}
      />
      {(error || hint) && (
        <span id={hintId} className={cx("dk-field__hint", error && "dk-field__hint--error")}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
});

export interface NumberFieldProps {
  /** Short visible label ("X", "W", "Size"). */
  label: string;
  /** Longer accessible name when the visible one is a single letter ("X position"). */
  ariaLabel?: string;
  value: number;
  /**
   * Called once per committed edit — Enter, blur, or an arrow step — and never
   * for a value the field refused. The caller turns this into *one* patch; a
   * field that committed per keystroke would put every intermediate digit in the
   * undo history.
   */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
  /**
   * The selected objects disagree (several selected). The field shows "Mixed"
   * and any number typed is committed, even one equal to `value`, because it
   * is equal to only some of them.
   */
  mixed?: boolean;
}

/**
 * A number input that edits a draft and commits on intent.
 *
 * Invalid or out-of-range text commits nothing and snaps back to the last good
 * value (see `parseNumberInput`). Escape abandons the draft. ArrowUp/ArrowDown
 * step and commit immediately; Shift steps by ten.
 */
export function NumberField({
  label,
  ariaLabel,
  value,
  onCommit,
  min,
  max,
  step = 1,
  integer,
  unit,
  disabled,
  className,
  "data-testid": testId,
  mixed = false,
}: NumberFieldProps) {
  const id = useId();
  const shown = (current: number) => (mixed ? "" : format(current));
  const [draft, setDraft] = useState(() => shown(value));
  const editing = useRef(false);

  // An outside change (undo, another field, the canvas) replaces the draft —
  // but not while someone is mid-edit, or their typing would be overwritten.
  useEffect(() => {
    if (!editing.current) setDraft(shown(value));
    // `shown` only reads `mixed`, which is listed.
  }, [value, mixed]);

  const commit = (text: string) => {
    editing.current = false;
    const parsed = parseNumberInput(text, { min, max, integer });
    if (parsed === null || (parsed === value && !mixed)) {
      setDraft(shown(value));
      return;
    }
    setDraft(format(parsed));
    onCommit(parsed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Escape") {
      editing.current = false;
      setDraft(shown(value));
      event.currentTarget.blur();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const base = parseNumberInput(draft, { integer }) ?? value;
      const next = stepNumber(base, event.key === "ArrowUp" ? 1 : -1, { step, large: event.shiftKey, min, max });
      editing.current = false;
      setDraft(format(next));
      if (next !== value || mixed) onCommit(next);
    }
  };

  return (
    <div className={cx("dk-numfield", disabled && "dk-numfield--disabled", className)}>
      <label className="dk-numfield__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="dk-numfield__input"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={draft}
        placeholder={mixed ? "Mixed" : undefined}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => {
          editing.current = true;
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (editing.current) commit(draft);
        }}
        onKeyDown={onKeyDown}
      />
      {unit && <span className="dk-numfield__unit">{unit}</span>}
    </div>
  );
}

function format(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : "";
}
