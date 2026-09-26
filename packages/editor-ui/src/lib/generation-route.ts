/**
 * What a person is told before they press Generate (final package review,
 * item 19).
 *
 * Every route says who writes the deck and what leaves this machine, because
 * that is the part nobody can see and the part that cannot be taken back once a
 * brief has been sent. Pure, so the wording is testable without a drawer.
 */
import type { GenerationStatus } from "@deckastra/workspace-contracts";

export interface GenerationRoute {
  /** One line: who writes it. */
  title: string;
  /** What leaves the machine, or what to do about it. */
  detail: string;
  tone: "neutral" | "waiting" | "danger";
  /** Whether Generate can be pressed at all. */
  available: boolean;
  /** Whether to offer the host's set-up screen. */
  offerSetUp: boolean;
}

export function generationRoute(status: GenerationStatus | undefined): GenerationRoute | null {
  // An older server says nothing about generation. Claiming a route we cannot
  // read would be worse than saying nothing.
  if (!status) return null;

  if (status.available) {
    switch (status.provider) {
      case "cloud":
        return {
          title: "Written by a cloud model (Anthropic)",
          detail: "Your brief, and any repositories you choose, are sent to Anthropic to write the outline and the deck.",
          tone: "neutral",
          available: true,
          offerSetUp: true,
        };
      case "local":
        return {
          title: "Written by a model on this computer",
          detail: "Nothing is sent anywhere. Generating can take several minutes.",
          tone: "neutral",
          available: true,
          offerSetUp: true,
        };
      default:
        return {
          title: "Demo planner — not a model",
          detail:
            "This build composes decks from a template so the app runs without a model. The words will read like a template, because they are one.",
          tone: "waiting",
          available: true,
          offerSetUp: false,
        };
    }
  }

  return {
    title: status.provider === "misconfigured" ? "Generation is misconfigured" : "Generation is not set up",
    detail: status.reason ?? "Nothing here can write a deck yet.",
    tone: status.provider === "misconfigured" ? "danger" : "waiting",
    available: false,
    // A mistyped setting is not something a set-up screen can fix.
    offerSetUp: status.provider !== "misconfigured",
  };
}
