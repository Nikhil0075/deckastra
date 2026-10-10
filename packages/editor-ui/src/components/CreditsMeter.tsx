import { useCallback, useEffect, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { CreditBalance } from "@deckastra/workspace-contracts";

import { creditsLine, creditsUnavailable, planLabel, remainingShare, resetLine } from "../lib/credits";
import { Button } from "../ui";
import { cx } from "../ui/cx";

type State =
  | { kind: "reading" }
  | { kind: "shown"; balance: CreditBalance }
  | { kind: "unavailable"; signIn: boolean; text: string };

/**
 * The account's AI credits (roadmap 08 §1.5 `CreditsMeter`).
 *
 * Read from the service, never computed here. Absent where the service offers
 * no account (`client.session.credits` is optional): a meter that could only
 * ever say "unavailable" would be a broken surface rather than a missing one.
 *
 * Asked again whenever the window regains focus and whenever `refreshToken`
 * changes (the assistant bumps it when a run finishes), so a balance someone
 * just spent is not shown as though it were still there.
 *
 * Two shapes: `inline` for the assistant's header ("42 of 60 credits this
 * month"), and `card` for the home and Settings, with the plan, a bar and when
 * the allowance resets. Purchases and subscriptions are not shown: none can
 * exist until payment verification does (roadmap 08 track 3).
 */
export function CreditsMeter({
  variant = "inline",
  refreshToken = 0,
  onOpenSettings,
}: {
  variant?: "inline" | "card";
  refreshToken?: number;
  /** Where signing in happens (the desktop's Settings › Account). */
  onOpenSettings?: () => void;
}) {
  const client = useWorkspaceClient();
  const read = client.session.credits;
  const [state, setState] = useState<State>({ kind: "reading" });

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!read) return;
      read
        .call(client.session, signal ? { signal } : undefined)
        .then((balance) => {
          if (!signal?.aborted) setState({ kind: "shown", balance });
        })
        .catch((error: unknown) => {
          if (!signal?.aborted) setState({ kind: "unavailable", ...creditsUnavailable(error) });
        });
    },
    [client, read],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [load, refreshToken]);

  if (!read) return null;

  if (variant === "inline") {
    if (state.kind === "reading") return null;
    return (
      <span className={cx("dk-credits", "dk-credits--inline")} data-testid="credits-meter" data-credits-state={state.kind}>
        {state.kind === "shown" ? creditsLine(state.balance) : state.text}
      </span>
    );
  }

  return (
    <section className={cx("dk-credits", "dk-credits--card")} aria-label="AI credits" data-testid="credits-card" data-credits-state={state.kind}>
      {state.kind === "reading" ? (
        <p className="dk-muted" role="status">
          Reading your credits…
        </p>
      ) : state.kind === "unavailable" ? (
        <>
          <p className={state.signIn ? "dk-credits__line" : "dk-muted"}>{state.text}</p>
          {state.signIn && onOpenSettings ? (
            <Button size="sm" variant="secondary" onClick={() => onOpenSettings()} data-testid="credits-sign-in">
              Sign in
            </Button>
          ) : !state.signIn ? (
            <Button size="sm" variant="ghost" onClick={() => load()}>
              Try again
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <p className="dk-credits__plan">{planLabel(state.balance.plan)}</p>
          <p className="dk-credits__line">{creditsLine(state.balance)}</p>
          <span
            className="dk-credits__bar"
            role="meter"
            aria-label="Credits left this month"
            aria-valuemin={0}
            aria-valuemax={state.balance.monthly_allowance}
            aria-valuenow={Math.floor(state.balance.remaining_credits)}
          >
            <span className="dk-credits__fill" style={{ width: `${Math.round(remainingShare(state.balance) * 100)}%` }} />
          </span>
          {resetLine(state.balance) ? <p className="dk-muted">{resetLine(state.balance)}</p> : null}
        </>
      )}
    </section>
  );
}
