import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";

/**
 * What a status *means*, not what colour it is. This is the only way to put a
 * status colour on screen, which is how the palette keeps one meaning per
 * colour:
 *
 * - `waiting` — yellow: a human is expected to look (paused, pending, auto-paired).
 * - `danger`  — red: a finding or a refusal.
 * - `action`  — blue: the active or applied state.
 * - `neutral` — outlined: information with no call to act (manual, draft).
 */
export type StatusTone = "waiting" | "danger" | "action" | "neutral";

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Always a word. Colour alone never carries state (WCAG 1.4.1). */
  children: ReactNode;
}

export function StatusChip({ tone, children, className, ...rest }: StatusChipProps) {
  return (
    <span className={cx("dk-chip", `dk-chip--${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

/**
 * A small status dot beside a count ("● 2 findings"). The label is required and
 * becomes the accessible text; the dot itself is decorative.
 */
export function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="dk-dot-label">
      <span className={cx("dk-dot", `dk-dot--${tone}`)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/**
 * A design-token reference, e.g. `colors.foreground`. Monospaced and outlined,
 * because a token is a name to be read exactly, not a value to be glanced at.
 * The optional swatch shows what it resolves to.
 */
export function TokenChip({ name, swatch }: { name: string; swatch?: string }) {
  return (
    <span className="dk-token" title={name}>
      {swatch && <span className="dk-token__swatch" style={{ background: swatch }} aria-hidden="true" />}
      <span className="dk-token__name">{name}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="dk-kbd">{children}</kbd>;
}

/** The short blue bar Bauhaus headings sit under — the Figma's accent rule. */
export function AccentRule() {
  return <span className="dk-accent-rule" aria-hidden="true" />;
}
