import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Icon, type IconName } from "./icons";
import { Tooltip } from "./Tooltip";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary` is blue and there should be one per surface — the Bauhaus rule is
   * that blue means "the action", and two blue buttons side by side mean neither.
   * `danger` is for destructive confirmation only, never for a plain "Cancel".
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  children?: ReactNode;
}

/**
 * The button. Defaults to `type="button"`: a button inside a form that submits
 * because nobody said otherwise is a classic way to lose an inspector edit.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("dk-btn", `dk-btn--${variant}`, `dk-btn--${size}`, className)}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 12 : 14} />}
      {children !== undefined && <span className="dk-btn__label">{children}</span>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /**
   * Required: an icon has no accessible name of its own. Becomes `aria-label`
   * and the tooltip text, so what a sighted user reads on hover and what a
   * screen reader announces cannot drift apart.
   */
  label: string;
  /** Shown after the label in the tooltip, e.g. "Ctrl+Z". */
  shortcut?: string;
  /** A toggle's state. Present only on toggles, so plain buttons are not announced as "not pressed". */
  pressed?: boolean;
  size?: ButtonSize;
  variant?: "ghost" | "secondary" | "primary";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, pressed, size = "md", variant = "ghost", className, type = "button", ...rest },
  ref,
) {
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={cx("dk-iconbtn", `dk-iconbtn--${size}`, `dk-iconbtn--${variant}`, className)}
        {...rest}
      >
        <Icon name={icon} size={size === "sm" ? 14 : 16} />
      </button>
    </Tooltip>
  );
});
