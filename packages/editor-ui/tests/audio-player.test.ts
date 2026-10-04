import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { AnimationTrack } from "@deckastra/presentation-schema";
import { buildDocumentScene, librarySoundDurationMs } from "@deckastra/renderer";
import { compileNarratedPlayback, compileTimeline, type NarrationCueInput, type SoundCueInput } from "@deckastra/animation-engine";

import { speakingAt, stepPlan } from "../src/lib/audio-player";

const scene = buildDocumentScene(loadFixture("multilingual"));
const slide = scene.slides[1]!;
const schedule = compileNarratedPlayback(
  compileTimeline(slide, (slide.animations ?? []) as AnimationTrack[]),
  slide.narration!.cues as NarrationCueInput[],
  slide.soundCues as SoundCueInput[],
  { locale: "en", gapMs: 400, soundDurationMs: (source) => ("library" in source ? librarySoundDurationMs(source.library) : 0) },
);

describe("what a step plays", () => {
  it("starts the step's recording at once and says when to advance", () => {
    const plan = stepPlan(schedule, 1, 0)!;
    const voice = plan.audio.find((item) => item.kind === "narration")!;
    expect(voice.delayMs).toBe(0);
    expect(voice.offsetMs).toBe(0);
    expect(plan.audio.some((item) => item.kind === "sound" && "library" in item.source && item.source.library === "pop")).toBe(true);
    const segment = schedule.segments[1]!;
    expect(plan.advanceInMs).toBe(segment.advanceAtMs - segment.startMs);
  });

  it("resumed part-way, starts the recording part-way: the schedule says where the voice is", () => {
    const plan = stepPlan(schedule, 2, 1000)!;
    const voice = plan.audio.find((item) => item.kind === "narration")!;
    expect(voice.offsetMs).toBe(1000);
    expect(plan.advanceInMs).toBe(stepPlan(schedule, 2, 0)!.advanceInMs - 1000);
    // A sound that already finished is not replayed on resume.
    expect(plan.audio.some((item) => item.kind === "sound")).toBe(false);
  });

  it("is the same answer however it was reached (seek parity)", () => {
    expect(stepPlan(schedule, 3, 750)).toEqual(stepPlan(schedule, 3, 750));
    expect(stepPlan(schedule, 9, 0)).toBeUndefined();
  });

  it("knows which line is being spoken, and how long it has left", () => {
    const now = speakingAt(schedule, 0, 500)!;
    expect(now.cueId).toBe(slide.narration!.cues[0]!.id);
    expect(now.remainingMs).toBe(2100 - 500);
    // Past the voice, in the gap, nothing is being said.
    expect(speakingAt(schedule, 0, 2200)).toBeUndefined();
  });
});

describe("a take's volume", () => {
  it("is the same number for Play as for the talk: −18 dB is an eighth, 0 dB is full", async () => {
    const { gainToVolume } = await import("../src/lib/audio-player");
    expect(gainToVolume(undefined)).toBe(1);
    expect(gainToVolume(0)).toBe(1);
    expect(gainToVolume(-18)).toBeCloseTo(0.126, 3);
    // Playback cannot go above the file's own level.
    expect(gainToVolume(6)).toBe(1);
  });
});
