import type { ReactNode } from "react";

import { Button } from "./Button";
import { cx } from "./cx";

/**
 * Something is being read (UI audit Unit 9). A placeholder the shape of what
 * is coming, so the page does not jump when it arrives, where a "Reading…"
 * sentence was one line tall and the answer was ten.
 *
 * The words are still there for a screen reader: `label` is the status the
 * region announces, and the bars are decorative. It does not pulse under
 * reduced motion.
 */
export function Skeleton({
  label,
  lines = 3,
  className,
  "data-testid": testId,
}: {
  /** What is being read, said to a screen reader ("Reading your account"). */
  label: string;
  lines?: number;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cx("dk-skeleton", className)} role="status" aria-busy="true" aria-label={label} data-testid={testId}>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <span key={index} className="dk-skeleton__line" aria-hidden="true" />
      ))}
    </div>
  );
}

/**
 * A grid of card placeholders, for the deck list and the template gallery. The
 * same grid class the real cards use, so the columns do not reflow on arrival.
 */
export function SkeletonCards({
  label,
  count = 6,
  gridClassName,
  "data-testid": testId,
}: {
  label: string;
  count?: number;
  /** The real grid's class, so placeholders and cards share one layout. */
  gridClassName: string;
  "data-testid"?: string;
}) {
  return (
    <div className={gridClassName} role="status" aria-busy="true" aria-label={label} data-testid={testId}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="dk-skeleton-card" aria-hidden="true">
          <span className="dk-skeleton-card__thumb" />
          <span className="dk-skeleton__line" />
          <span className="dk-skeleton__line dk-skeleton__line--short" />
        </div>
      ))}
    </div>
  );
}

/**
 * Something failed, said where it failed (UI audit Unit 9), with the one thing
 * that might help: trying again. A retry is offered only when the caller has
 * one, because a button that cannot work teaches people to stop pressing it.
 */
export function InlineError({
  children,
  onRetry,
  retryLabel = "Try again",
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cx("dk-inline-error", className)} role="alert" data-testid={testId}>
      <span className="dk-inline-error__text">{children}</span>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry} data-testid={testId ? `${testId}-retry` : undefined}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
