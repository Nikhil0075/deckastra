import { useState } from "react";
import { Button } from "@deckastra/editor-ui/ui";

import type { DesktopBridge, ServiceFailureKind, ServiceStatus } from "../shared/ipc";

/**
 * A service that will not start, said in words someone can act on, with the
 * one action that might fix it (final package review, item 17).
 *
 * It used to show the reason and nothing else, which leaves a person with a
 * sentence and no way forward except the task manager. Each kind gets its own
 * advice, because the useful answer differs — and **none of them is "clear your
 * workspace"**. A migration that failed is the case where the data matters more
 * than the app starting, and an app that offers to delete it to make itself run
 * is offering the worst trade there is.
 */

export function advice(kind: ServiceFailureKind | undefined): string {
  switch (kind) {
    case "missing":
      return "Part of this installation is missing. Reinstalling Deckastra is the fix; trying again will not help.";
    case "permission":
      return "Something on this computer refused access — antivirus, or a policy on your user folder. Check that Deckastra may write to its own data folder, then try again.";
    case "migration":
      return "Your decks are still on this computer and nothing has been changed or deleted. Your database could not be brought up to date for this version: reinstall the version you were using before, or send this message with a support report.";
    case "mismatch":
      return "This copy of Deckastra and its background service come from different builds. Reinstall Deckastra so the two match.";
    case "crashed":
      return "The service stopped on its own. Trying again is worth a go; if it keeps stopping, export a diagnostics report.";
    default:
      return "Trying again is worth a go. If it keeps failing, export a diagnostics report.";
  }
}

/** Whether pressing a button could plausibly change anything. */
export function worthRetrying(kind: ServiceFailureKind | undefined): boolean {
  return kind !== "missing" && kind !== "mismatch";
}

/**
 * The retry itself, so the startup screen and the outage banner offer the same
 * one action and report it the same way.
 */
export function ServiceRetry({
  bridge,
  onStatus,
  onOutcome,
}: {
  bridge: DesktopBridge;
  onStatus: (status: ServiceStatus) => void;
  onOutcome?: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    onOutcome?.(null);
    try {
      const next = await bridge.restartService();
      onStatus(next);
      // Said out loud: a button that appears to do nothing is worse than one
      // that reports the same failure again.
      onOutcome?.(next.state === "ready" ? null : "It still could not start.");
    } catch (error) {
      onOutcome?.(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="primary" disabled={busy} onClick={() => void retry()} data-testid="service-retry">
      {busy ? "Trying…" : "Try again"}
    </Button>
  );
}

export function ServiceFailure({
  status,
  bridge,
  onStatus,
}: {
  status: ServiceStatus;
  bridge: DesktopBridge;
  onStatus: (status: ServiceStatus) => void;
}) {
  const [lastTry, setLastTry] = useState<string | null>(null);

  return (
    <div className="dk-startup__card" data-testid="service-failure" data-kind={status.kind ?? "unknown"}>
      <span className="dk-accent-rule" aria-hidden="true" />
      <p className="dk-startup__title">Deckastra's background service is not running.</p>
      <p className="dk-startup__advice">{advice(status.kind)}</p>
      {/* The real reason, not a generic apology. It is the only thing that
          makes this reportable. */}
      <p className="dk-startup__detail">{status.detail}</p>
      {lastTry ? (
        <p className="dk-startup__detail" role="status">
          {lastTry}
        </p>
      ) : null}
      {worthRetrying(status.kind) ? (
        <ServiceRetry bridge={bridge} onStatus={onStatus} onOutcome={setLastTry} />
      ) : null}
    </div>
  );
}
