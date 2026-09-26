import type { StatusTone } from "../ui";
import type { StalenessState } from "@deckastra/workspace-contracts";

/**
 * Colour and wording for a staleness state, in one place so they cannot diverge.
 *
 * The shapes moved to `@deckastra/workspace-contracts` and the requests to the
 * workspace client; what is left here is the one thing that is genuinely this
 * app's — how a state looks.
 */
export function stalenessTone(state: StalenessState): { tone: StatusTone; label: string } {
  switch (state) {
    case "fresh":
      return { tone: "action", label: "Up to date" };
    case "stale":
      // Waiting on a human: someone should re-index before trusting it.
      return { tone: "waiting", label: "Out of date" };
    case "indexing":
    case "pending":
      return { tone: "neutral", label: "Indexing" };
    case "failed":
      return { tone: "danger", label: "Failed" };
    case "revoked":
      return { tone: "danger", label: "Access withdrawn" };
    default:
      // Deliberately not styled as success. "We cannot tell" is closer to stale
      // than to fresh, and showing it as fine is how a deck drifts unnoticed.
      return { tone: "waiting", label: "Unknown" };
  }
}
