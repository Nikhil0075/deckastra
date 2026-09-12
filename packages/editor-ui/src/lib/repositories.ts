import type { StalenessState } from "@deckastra/workspace-contracts";

/**
 * Colour and wording for a staleness state, in one place so they cannot diverge.
 *
 * The shapes moved to `@deckastra/workspace-contracts` and the requests to the
 * workspace client; what is left here is the one thing that is genuinely this
 * app's — how a state looks.
 */
export function stalenessTone(state: StalenessState): { colour: string; label: string } {
  switch (state) {
    case "fresh":
      return { colour: "var(--accent)", label: "Up to date" };
    case "stale":
      return { colour: "var(--warning)", label: "Out of date" };
    case "indexing":
    case "pending":
      return { colour: "var(--fg-subtle)", label: "Indexing" };
    case "failed":
      return { colour: "var(--danger)", label: "Failed" };
    case "revoked":
      return { colour: "var(--danger)", label: "Access withdrawn" };
    default:
      // Deliberately not styled as success. "We cannot tell" is closer to stale
      // than to fresh, and showing it as fine is how a deck drifts unnoticed.
      return { colour: "var(--fg-subtle)", label: "Unknown" };
  }
}
