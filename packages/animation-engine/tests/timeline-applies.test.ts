/**
 * Timeline operations, applied to a real document (D4.2).
 *
 * The other authoring tests read the patches. That proves the arithmetic and
 * proves nothing about whether the paths resolve, whether the result parses, or
 * whether a split leaves a deck the product would refuse to open — and a patch
 * that cannot apply is worse than one that computes the wrong number, because it
 * fails at the transaction rather than on screen.
 *
 * So this runs them through `applyPatch`, the one path that changes a `.mydeck`
 * document, and validates what comes out. It uses the committed fixture rather
 * than a literal for the same reason the morph test does: a hand-built clip is a
 * thing I wrote to pass, and the conformance deck is a thing the product ships.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { applyPatch } from "@deckastra/transactions";
import { validateDocument, type PresentationDocument } from "@deckastra/presentation-schema";

import { splitClip, rippleOperations, setKeyframeOperations, openPresetOperations } from "../src/timeline";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "presentation-schema",
  "fixtures",
  "animation-test.mydeck.json",
);

function deck(): PresentationDocument {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as PresentationDocument;
}

/** The first clip that is still a preset, with no property tracks of its own. */
function firstClosedClip(document: PresentationDocument) {
  for (const slide of document.slides) {
    for (const track of slide.animations ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.preset && !clip.propertyTracks?.length) return { slide, track, clip };
      }
    }
  }
  throw new Error("Every clip in the fixture is already open, which defeats the test.");
}

/** The first slide that actually animates something, with its first clip. */
function firstClip(document: PresentationDocument) {
  for (const slide of document.slides) {
    const track = (slide.animations ?? [])[0];
    const clip = track?.clips?.[0];
    if (track && clip) return { slide, track, clip };
  }
  throw new Error("The animation fixture has no clips, which cannot be right.");
}

function expectValid(document: PresentationDocument) {
  const report = validateDocument(document);
  expect(report.errors).toEqual([]);
  expect(report.valid).toBe(true);
}

describe("applying timeline operations to the conformance deck", () => {
  it("splits a clip into two the schema accepts", () => {
    const document = deck();
    const { slide, track, clip } = firstClip(document);

    const split = splitClip(
      slide.id,
      { ...clip, trackId: track.id } as never,
      Math.round(clip.durationMs / 2),
      "clp_01JB8Z9K2QW4RN7F3X09000000",
    );
    expect(split.operations.length).toBeGreaterThan(0);

    // `applyPatch` throws a PatchError when a path does not resolve, so getting
    // a result back *is* the assertion that these operations addressed real
    // things. An `errors` array was checked here at first — it does not exist,
    // so the check asserted nothing until the typechecker said so.
    const applied = applyPatch(document, split.operations);
    expectValid(applied.document);

    const after = applied.document.slides.find((one) => one.id === slide.id)!;
    const clips = (after.animations ?? []).find((one) => one.id === track.id)!.clips;
    expect(clips).toHaveLength(track.clips.length + 1);

    // The two halves are contiguous: the second begins where the first ends, on
    // the same axis, which is what stops a split from leaving a gap.
    const first = clips.find((one) => one.id === clip.id)!;
    const second = clips.find((one) => one.id === "clp_01JB8Z9K2QW4RN7F3X09000000")!;
    expect(second.startMs).toBe(first.startMs + first.durationMs);
    expect(first.durationMs + second.durationMs).toBe(clip.durationMs);
  });

  it("produces an inverse that puts the clip back", () => {
    // Every timeline gesture is a transaction in the same history as a text
    // edit, so undo has to work on it without anything being wired specially.
    const document = deck();
    const { slide, track, clip } = firstClip(document);

    const split = splitClip(
      slide.id,
      { ...clip, trackId: track.id } as never,
      Math.round(clip.durationMs / 2),
      "clp_01JB8Z9K2QW4RN7F3X09000001",
    );
    const applied = applyPatch(document, split.operations);
    const undone = applyPatch(applied.document, applied.inverse);

    const after = undone.document.slides.find((one) => one.id === slide.id)!;
    const clips = (after.animations ?? []).find((one) => one.id === track.id)!.clips;
    expect(clips).toHaveLength(track.clips.length);
    expect(clips.find((one) => one.id === clip.id)!.durationMs).toBe(clip.durationMs);
  });

  it("opens a preset and then takes a keyframe edit", () => {
    const document = deck();
    // A clip that has not been opened already — the fixture's first one carries
    // explicit tracks, and opening it is correctly a no-op.
    const { slide, track, clip } = firstClosedClip(document);

    const opened = openPresetOperations(
      slide.id,
      { ...clip, trackId: track.id } as never,
      {
        bounds: { x: 0, y: 0, width: 800, height: 200 },
        motion: { defaultDurationMs: 400, defaultEasing: "easeOut", staggerMs: 60 },
      },
    );
    expect(opened.operations.length).toBeGreaterThan(0);

    const withTracks = applyPatch(document, opened.operations);
    expectValid(withTracks.document);

    // The preset name survives as provenance, so the panel can still say what
    // this started as after it has been taken apart.
    const openedSlide = withTracks.document.slides.find((one) => one.id === slide.id)!;
    const openedClip = (openedSlide.animations ?? []).find((one) => one.id === track.id)!.clips[0]!;
    expect(openedClip.preset).toBe(clip.preset);
    expect(openedClip.propertyTracks?.length).toBeGreaterThan(0);

    const property = openedClip.propertyTracks![0]!.property;
    const edited = setKeyframeOperations(
      slide.id,
      { ...openedClip, trackId: track.id } as never,
      property,
      Math.round(openedClip.durationMs / 2),
      0.5,
    );
    const result = applyPatch(withTracks.document, edited.operations);
    expectValid(result.document);
  });

  it("ripples without writing a path that does not resolve", () => {
    const document = deck();
    const { slide, track } = firstClip(document);

    const { operations } = rippleOperations(
      slide.id,
      track.id,
      track.clips.map((one) => ({ id: one.id, startMs: one.startMs, durationMs: one.durationMs })),
      0,
      120,
    );

    const applied = applyPatch(document, operations);
    expectValid(applied.document);

    const after = applied.document.slides.find((one) => one.id === slide.id)!;
    const moved = (after.animations ?? []).find((one) => one.id === track.id)!.clips;
    for (const [index, clip] of moved.entries()) {
      expect(clip.startMs).toBe(track.clips[index]!.startMs + 120);
    }
  });

  it("refuses a path that does not resolve, rather than applying half a gesture", () => {
    // The failure mode this whole file exists for: an operation whose path is
    // wrong fails at the transaction, not on screen, and every one of these
    // builders writes paths by hand.
    expect(() =>
      applyPatch(deck(), [{ op: "replace", path: "/slides/id:sld_nope/animations/id:x/clips/id:y/startMs", value: 1 }]),
    ).toThrow();
  });
});
