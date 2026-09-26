import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { groundingLabel, previewProposal, proposalSource } from "../src/lib/proposal-preview";

/**
 * What a pending change would do to the deck on screen (editor Phase 6). The
 * card's pictures and its "Grounded in" line are only as true as this.
 */

describe("previewing a proposal", () => {
  it("applies to a copy and names the slides it changes", () => {
    const deck = loadFixture("technical");
    const slide = deck.slides[2]!;
    const preview = previewProposal(deck, [
      { op: "remove", path: `/slides/id:${slide.id}/elements/id:${slide.elements[0]!.id}` },
    ]);
    expect(preview.error).toBeNull();
    expect(preview.changedSlideIds).toEqual([slide.id]);
    expect(preview.removedSlideIds).toEqual([]);
    expect(preview.deckWide).toBe(false);
    // The deck the editor holds is untouched.
    expect(deck.slides[2]!.elements[0]!.id).toBe(slide.elements[0]!.id);
    expect(preview.after!.slides[2]!.elements).toHaveLength(slide.elements.length - 1);
  });

  it("names a removed slide and a deck-wide change", () => {
    const deck = loadFixture("technical");
    const gone = deck.slides[1]!.id;
    const preview = previewProposal(deck, [
      { op: "remove", path: `/slides/id:${gone}` },
      { op: "replace", path: "/metadata/title", value: "Renamed" },
    ]);
    expect(preview.removedSlideIds).toEqual([gone]);
    expect(preview.deckWide).toBe(true);
  });

  it("reports a change that no longer applies instead of drawing something else", () => {
    const deck = loadFixture("technical");
    const preview = previewProposal(deck, [{ op: "remove", path: `/slides/id:${deck.slides[0]!.id}/elements/id:el_missing` }]);
    expect(preview.after).toBeNull();
    expect(preview.error).toBeTruthy();
  });

  it("is grounded only in the sources the change itself cites", () => {
    const deck = loadFixture("repository");
    const target = deck.slides[0]!.elements[0]!.id;
    const record = {
      id: "prv_01J0000000000000000000000Z",
      targetId: target,
      sourceType: "github" as const,
      sourceReference: "acme/app#docs/architecture.md:12-48",
      createdAt: "2026-09-19T00:00:00.000Z",
    };
    const preview = previewProposal(deck, [{ op: "add", path: "/provenance/-", value: record }]);
    expect(preview.error).toBeNull();
    // The deck's existing citations are not claimed by this change.
    expect(preview.groundedIn).toEqual(["acme/app#docs/architecture.md:12-48"]);
    expect(groundingLabel(["acme/app#README.md", "acme/app#docs/architecture.md:12-48"])).toBe(
      "README.md · docs/architecture.md",
    );
  });

  it("says who proposed it, and cannot be passed off as the product's own agent", () => {
    expect(proposalSource("mcp:codex")).toBe("from codex via MCP");
    expect(proposalSource("layout")).toBe("from the layout agent");
    expect(proposalSource(null)).toBe("from an agent");
  });
});
