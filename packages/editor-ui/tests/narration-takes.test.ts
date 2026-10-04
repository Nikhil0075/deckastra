import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { setNarrationTakeOperations } from "@deckastra/presentation-core";
import { applyPatch } from "@deckastra/transactions";

import { takeChoices } from "../src/components/NarrationPanel";

const deck = () => loadFixture("multilingual");
const slide = (document: ReturnType<typeof deck>) => document.slides[1]!;

describe("choosing another recording for a line", () => {
  it("offers every audio file in the deck, named by the words it already says", () => {
    const document = deck();
    const choices = takeChoices(document, "en");
    const audio = document.assets.filter((asset) => asset.type === "audio");
    expect(choices.map((choice) => choice.assetId).sort()).toEqual(audio.map((asset) => asset.id).sort());
    const first = slide(document).narration!.cues[0]!;
    const take = (first.takes as Record<string, { assetId: string; voice?: string }>).en!;
    const named = choices.find((choice) => choice.assetId === take.assetId)!;
    expect(named.label).toContain(first.text.slice(0, 10));
    expect(named.durationMs).toBeGreaterThan(0);
  });

  it("swaps a take in one patch that undoes, keeping the line's script", () => {
    const document = deck();
    const [first, second] = slide(document).narration!.cues;
    const other = takeChoices(document, "en").find((choice) => choice.assetId === (second!.takes as Record<string, { assetId: string }>).en!.assetId)!;
    const applied = applyPatch(
      document,
      setNarrationTakeOperations(document, slide(document).id, first!.id, "en", { assetId: other.assetId, durationMs: other.durationMs, voice: other.voice }),
    );
    const swapped = applied.document.slides[1]!.narration!.cues[0]!;
    expect((swapped.takes as Record<string, { assetId: string }>).en!.assetId).toBe(other.assetId);
    expect(swapped.text).toBe(first!.text);
    expect(applyPatch(applied.document, applied.inverse).document).toEqual(document);
  });

  it("trims a take's volume, and setting it back to 0 dB leaves no field behind", () => {
    const document = deck();
    const cue = slide(document).narration!.cues[0]!;
    const take = (cue.takes as Record<string, { assetId: string; durationMs: number; textHash: string }>).en!;
    const quieter = applyPatch(document, setNarrationTakeOperations(document, slide(document).id, cue.id, "en", { ...take, gainDb: -6 })).document;
    expect((quieter.slides[1]!.narration!.cues[0]!.takes as Record<string, { gainDb?: number }>).en!.gainDb).toBe(-6);
    const { gainDb: _gone, ...rest } = (quieter.slides[1]!.narration!.cues[0]!.takes as Record<string, typeof take & { gainDb?: number }>).en!;
    const back = applyPatch(quieter, setNarrationTakeOperations(quieter, slide(quieter).id, cue.id, "en", rest)).document;
    expect("gainDb" in (back.slides[1]!.narration!.cues[0]!.takes as Record<string, object>).en!).toBe(false);
  });
});
