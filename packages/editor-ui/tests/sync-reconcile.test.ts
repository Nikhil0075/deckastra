/**
 * The merge a diverged deck needs is the merge this product already has (D5.3).
 *
 * `GET /presentations/{id}/sync?documents=true` answers with three documents —
 * the base the refused change was written against, this device's head, and what
 * the server had when it refused. This file is the claim that those three are
 * the right three: that `reconcileDocuments`, written for the autosave conflict,
 * also resolves a sync divergence without a second implementation beside it.
 *
 * That claim is worth checking in its own language rather than assumed, because
 * getting it wrong is invisible until someone is standing in front of a conflict
 * they cannot resolve. The other half — that the API records *these* three and
 * not, say, the oldest version it can find — is asserted on the Python side
 * (`test_sync_divergence.py`), because that is where the choice is made.
 *
 * Why there is no Python merge: a three-way merge over this schema is the
 * hardest logic in the product, and a second one would be held together by
 * nobody. So the editor merges, commits through the ordinary transaction path,
 * and tells the API which version did it.
 */

import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { reconcileDocuments } from "../src/lib/reconcile";

/**
 * The shape a divergence actually has, which is not the shape an autosave
 * conflict has.
 *
 * An autosave conflict is one editor against one other save. A divergence is a
 * device that has been working offline: **several** changes since the base, met
 * by several on the other side. So the local document here is three edits past
 * the base rather than one — if the merge only coped with a single step it would
 * pass every existing test in `reconcile.test.ts` and fail the first real plane
 * journey.
 */
function diverged(): {
  base: PresentationDocument;
  local: PresentationDocument;
  remote: PresentationDocument;
} {
  const base = structuredClone(loadFixture("technical"));
  const local = structuredClone(base);
  const remote = structuredClone(base);

  // A day's work on the plane.
  local.metadata.title = "Offline draft";
  local.slides[0]!.elements[0]!.name = "Rewritten headline";
  local.slides[1]!.elements[0]!.name = "Rewritten second slide";

  // Meanwhile, in the office, on different elements.
  remote.slides[0]!.elements[1]!.name = "Subtitle from the office";
  remote.slides[2]!.elements[0]!.name = "Third slide from the office";

  return { base, local, remote };
}

describe("reconciling a deck that diverged while it was offline", () => {
  it("keeps every edit from both sides when they touched different things", () => {
    // The common case and the one that must never need a person: two people
    // working on different slides is not a disagreement, and asking someone to
    // adjudicate one trains them to click through the ones that matter.
    const { base, local, remote } = diverged();

    const merged = reconcileDocuments(base, local, remote);

    expect(merged.conflicts).toEqual([]);
    expect(merged.errors).toEqual([]);
    expect(merged.document.metadata.title).toBe("Offline draft");
    expect(merged.document.slides[0]!.elements[0]!.name).toBe("Rewritten headline");
    expect(merged.document.slides[0]!.elements[1]!.name).toBe("Subtitle from the office");
    expect(merged.document.slides[1]!.elements[0]!.name).toBe("Rewritten second slide");
    expect(merged.document.slides[2]!.elements[0]!.name).toBe("Third slide from the office");
  });

  it("asks rather than picking a side when both changed the same thing", () => {
    const { base, local, remote } = diverged();
    remote.metadata.title = "Office draft";

    const review = reconcileDocuments(base, local, remote);

    expect(review.conflicts).toContainEqual({
      path: "/metadata/title",
      local: "Offline draft",
      server: "Office draft",
    });

    // And the answer is honoured. Everything else still merges, so resolving one
    // real disagreement does not cost the rest of the day's work.
    const resolved = reconcileDocuments(base, local, remote, {
      "/metadata/title": "local",
    });
    expect(resolved.document.metadata.title).toBe("Offline draft");
    expect(resolved.document.slides[2]!.elements[0]!.name).toBe(
      "Third slide from the office",
    );
  });

  it("is a merge, not a preference for whoever uploaded first", () => {
    // The negative control. "Take the server's copy" resolves every divergence
    // and loses the whole offline session; "take mine" loses the office's. If
    // either were what happened here, the case above would pass just as well.
    const { base, local, remote } = diverged();

    const merged = reconcileDocuments(base, local, remote).document;

    expect(merged).not.toEqual(local);
    expect(merged).not.toEqual(remote);
  });

  it("does not report an edit nobody made", () => {
    // A merge run against the *wrong* base reports every change since that base
    // as a conflict — which is how a device that recorded the deck's first
    // version instead of the refused change's parent would fail: not by erroring,
    // but by asking a person to adjudicate their own uncontested work.
    const { base, local } = diverged();

    const merged = reconcileDocuments(base, local, structuredClone(base));

    expect(merged.conflicts).toEqual([]);
    expect(merged.document.metadata.title).toBe("Offline draft");
  });

  it("leaves the documents it was given alone", () => {
    // They are what the review screen is still showing, and what the person is
    // comparing. A merge that edited its own inputs would change the evidence
    // under them while they read it.
    const { base, local, remote } = diverged();
    const untouched = structuredClone(remote);

    reconcileDocuments(base, local, remote, { "/metadata/title": "local" });

    expect(remote).toEqual(untouched);
  });
});
