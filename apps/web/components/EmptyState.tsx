"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Empty states and failures (gap register doc 01 S2).
 *
 * The gap: first-run, an empty project, an agent run that failed mid-generation,
 * a stale repository index, a missing font — "these shape a large share of the
 * perceived quality and are absent".
 *
 * One component rather than a dozen, because they are all the same shape and the
 * shape is what matters: **say what is true, then say what to do about it.** The
 * failure mode this avoids is the empty state that only says "Nothing here",
 * which tells a user their software is working and leaves them stuck.
 *
 * Three rules the props enforce:
 *
 * - **An action is not optional for a failure.** A `tone: "error"` with no
 *   `action` is a dead end, and a dead end is where a user leaves.
 * - **The message says what happened, not what went wrong.** "The model did not
 *   return a valid plan" over "An error occurred" — the first is something a user
 *   can retry with different words.
 * - **Nothing is red unless it is broken.** An empty project is not a problem,
 *   and colouring it like one trains people to ignore the colour.
 */

export type Tone = "empty" | "waiting" | "warning" | "error";

export interface EmptyStateProps {
  tone?: Tone;
  title: string;
  /** What is true, in a sentence a user would say. */
  message: ReactNode;
  /** What to do next. Required for an error — see the module docstring. */
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
  /** Technical detail, folded away. Present for support, absent from the eye. */
  detail?: string;
}

export function EmptyState({
  tone = "empty",
  title,
  message,
  action,
  secondary,
  detail,
}: EmptyStateProps) {
  return (
    <div
      // `status` rather than `alert` for anything that is not an error: an alert
      // interrupts a screen-reader user mid-sentence, and an empty project is not
      // worth interrupting for (WCAG 2.1 AA, 4.1.3).
      role={tone === "error" ? "alert" : "status"}
      style={{ ...container, borderLeftColor: accentFor(tone) }}
    >
      <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--fg)" }}>{title}</h3>
      <div style={{ color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.5 }}>{message}</div>

      {action || secondary ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {action ? (
            <button style={primary} onClick={action.onClick}>
              {action.label}
            </button>
          ) : null}
          {secondary ? (
            <button style={quiet} onClick={secondary.onClick}>
              {secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}

      {detail ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer" }}>
            Technical detail
          </summary>
          <pre style={detailStyle}>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

function accentFor(tone: Tone): string {
  switch (tone) {
    case "error":
      return "var(--danger)";
    case "warning":
      return "var(--warning)";
    case "waiting":
      return "var(--accent)";
    default:
      // An empty project is not a problem. Colouring it like one trains people
      // to ignore the colour when something is.
      return "var(--border)";
  }
}

// ---------------------------------------------------------- the named states

/**
 * The five doc 01 S2 names, written once.
 *
 * Written as functions rather than left to each call site, because the wording
 * *is* the product here. A message rewritten slightly differently in three
 * places is three different explanations of the same situation, and a user who
 * sees two of them learns the software is inconsistent.
 */

export function NoDecksYet({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      title="No decks yet"
      message={
        <>
          Describe what you want to present and Deckastra will write a first draft
          you can edit. Or start from a blank deck and build it yourself — the
          editor does not need the AI.
        </>
      }
      action={{ label: "Describe a deck", onClick: onCreate }}
    />
  );
}

export function GenerationFailed({
  reason,
  onRetry,
  onStartBlank,
}: {
  reason: string;
  onRetry: () => void;
  onStartBlank: () => void;
}) {
  return (
    <EmptyState
      tone="error"
      title="That generation did not finish"
      message={
        <>
          Nothing was saved, so nothing is half-written. Trying again with more
          specific wording usually works — the model has a better chance with a
          clear audience and a clear point.
        </>
      }
      action={{ label: "Try again", onClick: onRetry }}
      secondary={{ label: "Start from a blank deck", onClick: onStartBlank }}
      detail={reason}
    />
  );
}

export function QuotaReached({
  limit,
  used,
  allowed,
  resetsAt,
}: {
  limit: string;
  used: number;
  allowed: number;
  resetsAt: string;
}) {
  const when = new Date(resetsAt);
  const months = "January February March April May June July August September October November December".split(" ");

  return (
    <EmptyState
      tone="warning"
      title={`This workspace has used its ${limit} for the month`}
      message={
        <>
          {used} of {allowed} used. The allowance resets on {when.getUTCDate()}{" "}
          {months[when.getUTCMonth()]}. Editing, presenting and exporting all keep
          working — only new generations are paused.
        </>
      }
    />
  );
}

export function StaleRepository({
  name,
  onReindex,
}: {
  name: string;
  onReindex: () => void;
}) {
  return (
    <EmptyState
      tone="warning"
      title={`${name} has changed since it was indexed`}
      message={
        <>
          A deck generated now would cite the code as it was, not as it is.
          Re-indexing takes a few seconds.
        </>
      }
      action={{ label: "Re-index now", onClick: onReindex }}
    />
  );
}

export function MissingFont({ family, substitute }: { family: string; substitute: string }) {
  return (
    <EmptyState
      tone="warning"
      title={`${family} is not available here`}
      message={
        <>
          {substitute} is being used instead. It is metric-matched, so the layout
          holds — but the letterforms differ, and an export from this machine will
          differ from one made where {family} is installed.
        </>
      }
    />
  );
}

// ------------------------------------------------------------------- styles

const container: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderLeftWidth: 3,
  borderLeftStyle: "solid",
  borderRadius: 10,
  padding: "16px 18px",
};

const primary: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg)",
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
};

const quiet: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--fg-muted)",
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 13,
};

const detailStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: "var(--fg-subtle)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 140,
  overflow: "auto",
};
