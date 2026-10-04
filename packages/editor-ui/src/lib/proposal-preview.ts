/**
 * What a pending change would do to the deck on screen (editor Phase 6, Figma
 * frame "previewing a proposal as an image"). Pure, so tested directly.
 *
 * The card draws Before and After with the editor's own renderer. "After" is the
 * deck the person is looking at with the proposal's operations applied — through
 * the same applier every edit goes through, onto a copy. That is what approving
 * means, so it is what the picture shows; nothing here applies anything to the
 * document the editor holds.
 */

import { splitPath, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";

import { localizeDocument } from "./locale-lens";
import { compareSlides, deckWideDiffers } from "./version-history";

export interface ProposalPreview {
  /** The deck with the change applied, or null when it no longer applies. */
  after: PresentationDocument | null;
  /** Why it does not apply, in the applier's words. */
  error: string | null;
  /** Slides the change alters or adds, in the order the after-deck has them. */
  changedSlideIds: string[];
  /** Slides the change removes. They have an After of nothing. */
  removedSlideIds: string[];
  /** Theme, metadata or anything else outside the slides differs. */
  deckWide: boolean;
  /**
   * The language the pictures are drawn in (integration plan 01): a translation
   * is shown in the language it translates into, so Before and After differ by
   * exactly the words it proposes; anything else in the language on screen.
   */
  locale: string | null;
  /** The decks as drawn: `before` and `after`, each shown in `locale`. */
  shownBefore: PresentationDocument;
  shownAfter: PresentationDocument | null;
  /**
   * What the change cites: the provenance records it adds, by reference. The
   * only sources a proposal can truthfully claim to be grounded in are the ones
   * it writes into the deck; a run's whole research set would claim more.
   */
  groundedIn: string[];
}

/**
 * The language a change writes, when it writes only one language's overlay —
 * a translation, or a person's edit made while that language was showing.
 */
export function proposalLocale(operations: readonly PatchOperation[]): string | null {
  let found: string | null = null;
  for (const operation of operations) {
    const segments = splitPath(operation.path);
    if (segments[0] !== "locales") return null;
    let tag: string | undefined = segments[1];
    if (!tag && operation.op === "add" && "value" in operation && operation.value && typeof operation.value === "object") {
      const keys = Object.keys(operation.value as object);
      tag = keys.length === 1 ? keys[0] : undefined;
    }
    if (!tag || (found && found !== tag)) return null;
    found = tag;
  }
  return found;
}

export function previewProposal(
  before: PresentationDocument,
  operations: readonly PatchOperation[],
  showing: string | null = null,
): ProposalPreview {
  const locale = proposalLocale(operations) ?? showing;
  let after: PresentationDocument;
  try {
    after = applyPatch(before, operations).document;
  } catch (error) {
    return {
      after: null,
      error: error instanceof Error ? error.message : "This change no longer applies to the deck.",
      changedSlideIds: [],
      removedSlideIds: [],
      deckWide: false,
      groundedIn: [],
      locale,
      shownBefore: localizeDocument(before, locale),
      shownAfter: null,
    };
  }
  const shownBefore = localizeDocument(before, locale);
  const shownAfter = localizeDocument(after, locale);

  // Read from the after-deck's side: "added" there is new, "removed" is gone.
  // Compared as drawn, so a translation marks the slides whose words it changes.
  const comparison = compareSlides(shownAfter, shownBefore);
  const known = new Set((before.provenance ?? []).map((record) => record.id));
  const groundedIn = [
    ...new Set(
      (after.provenance ?? [])
        .filter((record) => !known.has(record.id))
        .map((record) => record.sourceReference)
        .filter((reference) => reference.trim().length > 0),
    ),
  ];

  return {
    after,
    error: null,
    changedSlideIds: comparison
      .filter((entry) => entry.change === "changed" || entry.change === "added")
      .map((entry) => entry.slideId),
    removedSlideIds: comparison.filter((entry) => entry.change === "removed").map((entry) => entry.slideId),
    // An overlay lives outside the slides, so a translation is "deck-wide" by
    // structure; what a person sees change is the slides, and that is reported.
    deckWide: proposalLocale(operations) ? deckWideDiffers(shownAfter, shownBefore) && !onlyLocales(operations) : deckWideDiffers(after, before),
    groundedIn,
    locale,
    shownBefore,
    shownAfter,
  };
}

function onlyLocales(operations: readonly PatchOperation[]): boolean {
  return operations.every((operation) => splitPath(operation.path)[0] === "locales");
}

/**
 * "README.md · docs/architecture.md" — the Figma's grounding line. A reference
 * like `owner/repo#docs/architecture.md:12-48` is shown by its path, because the
 * repository is usually the same for every source and the lines are detail.
 */
export function groundingLabel(references: readonly string[]): string {
  const short = references.map((reference) => {
    const afterRepo = reference.includes("#") ? reference.slice(reference.indexOf("#") + 1) : reference;
    return afterRepo.replace(/:\d+(-\d+)?$/, "");
  });
  return [...new Set(short)].join(" · ");
}

/** "High risk · from codex via MCP" — who proposed it, in words. */
export function proposalSource(agentId: string | null): string {
  if (!agentId) return "from an agent";
  // The server prefixes an external client's label, so it cannot pass itself
  // off as the product's own agent.
  if (agentId.startsWith("mcp:")) return `from ${agentId.slice(4) || "an external agent"} via MCP`;
  return `from the ${agentId} agent`;
}
