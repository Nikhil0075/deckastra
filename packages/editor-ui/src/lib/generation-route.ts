/**
 * What a person is told before they press Create (final package review,
 * item 19; roadmap 08 §1.2 rules 4 and 6).
 *
 * Every route says who writes the deck and what leaves this machine, because
 * that is the part nobody can see and the part that cannot be taken back once a
 * brief has been sent. Pure, so the wording is testable without a prompt bar.
 *
 * The routes are the ones the service reports since track 2: Deckastra's AI
 * service (`vertex`, run on Google Cloud and paid for in credits), the
 * development template (`stub`), or nothing set up. The own-key and on-device
 * routes are retired, and so are their words.
 */
import type { GenerationStatus } from "@deckastra/workspace-contracts";

import { plain } from "./assistant-words";

export interface GenerationRoute {
  /** One line: who writes it. */
  title: string;
  /** What leaves the machine, or what to do about it. */
  detail: string;
  tone: "neutral" | "waiting" | "danger";
  /** Whether Create can be pressed at all. */
  available: boolean;
  /** Whether to offer the host's set-up screen (signing in, on the desktop). */
  offerSetUp: boolean;
}

export function generationRoute(status: GenerationStatus | undefined): GenerationRoute | null {
  // An older server says nothing about generation. Claiming a route we cannot
  // read would be worse than saying nothing.
  if (!status) return null;

  if (status.available) {
    if (status.provider === "stub") {
      return {
        title: "Demo planner — not a model",
        detail:
          "This build composes decks from a template so the app runs without AI. The words will read like a template, because they are one.",
        tone: "waiting",
        available: true,
        offerSetUp: false,
      };
    }
    return {
      title: "Written by Deckastra AI",
      detail:
        "Your brief, and any repositories you choose, are sent to Google Cloud to write the outline and the deck. It uses your account's credits.",
      tone: "neutral",
      available: true,
      offerSetUp: false,
    };
  }

  const reason = plain(status.reason);
  const signIn = /sign in/i.test(status.reason ?? "");
  if (status.provider === "misconfigured") {
    return {
      title: "Generation is misconfigured",
      detail: reason ?? "This install's AI setting could not be read.",
      tone: "danger",
      available: false,
      // A mistyped setting is not something a set-up screen can fix.
      offerSetUp: false,
    };
  }
  return {
    title: signIn ? "Sign in to write decks with AI" : "AI is not available yet",
    detail:
      reason && reason !== "Not set up yet."
        ? reason
        : "Writing decks with AI is not switched on here yet. You can still start from a blank deck.",
    tone: "waiting",
    available: false,
    offerSetUp: true,
  };
}
