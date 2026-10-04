import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { AnimationTrack } from "@deckastra/presentation-schema";
import { buildDocumentScene, librarySoundDurationMs } from "@deckastra/renderer";

import {
  compileNarratedPlayback,
  compileTimeline,
  narrationAt,
  narrationBars,
  segmentAt,
  soundsAt,
  soundsBetween,
  steppedClock,
  type NarrationCueInput,
  type SoundCueInput,
} from "../src/index";

const scene = buildDocumentScene(loadFixture("multilingual"));
const slide = scene.slides[1]!;
const cues = slide.narration!.cues as NarrationCueInput[];
const sounds = slide.soundCues as SoundCueInput[];
const timelineFor = (reduced = false) =>
  compileTimeline(slide, (slide.animations ?? []) as AnimationTrack[], { userMotionPreference: reduced ? "reduced" : "full" });
const soundDurationMs = (source: SoundCueInput["source"]) => ("library" in source ? librarySoundDurationMs(source.library) : 0);

describe("narrated playback", () => {
  it("gives three click phases plus the arrival four narrated segments", () => {
    const schedule = compileNarratedPlayback(timelineFor(), cues, sounds, { locale: "en", gapMs: 400, soundDurationMs });
    expect(schedule.segments).toHaveLength(4);
    expect(schedule.segments.map((segment) => segment.narration.length)).toEqual([1, 1, 1, 1]);
    expect(schedule.orphaned).toEqual([]);
  });

  it("advances each step at max(animation end, narration end) + gap", () => {
    const timeline = timelineFor();
    const schedule = compileNarratedPlayback(timeline, cues, sounds, { locale: "en", gapMs: 400 });
    for (const segment of schedule.segments) {
      const source = timeline.segments[segment.index]!;
      const animation = source.endMs - source.startMs;
      const narration = segment.narration.reduce((sum, clip) => sum + (clip.endMs - clip.startMs), 0);
      expect(segment.advanceAtMs).toBe(segment.startMs + Math.max(animation, narration) + 400);
    }
    // Each segment starts where the one before advanced.
    for (let i = 1; i < schedule.segments.length; i += 1) {
      expect(schedule.segments[i]!.startMs).toBe(schedule.segments[i - 1]!.advanceAtMs);
    }
    expect(schedule.totalMs).toBe(schedule.segments.at(-1)!.advanceAtMs);
  });

  it("plays the take for the language on show, and Hindi takes longer", () => {
    const english = compileNarratedPlayback(timelineFor(), cues, [], { locale: "en" });
    const hindi = compileNarratedPlayback(timelineFor(), cues, [], { locale: "hi-IN" });
    expect(hindi.totalMs).toBeGreaterThan(english.totalMs);
    expect(hindi.segments[0]!.narration[0]!.assetId).not.toBe(english.segments[0]!.narration[0]!.assetId);
    // A language with no recordings narrates nothing, and says which cues are silent.
    const french = compileNarratedPlayback(timelineFor(), cues, [], { locale: "fr" });
    expect(french.segments.every((segment) => segment.narration.length === 0)).toBe(true);
    expect(french.segments.flatMap((segment) => segment.missing)).toHaveLength(4);
  });

  it("seeking to t and playing to t put the voice in the same place", () => {
    const schedule = compileNarratedPlayback(timelineFor(), cues, sounds, { locale: "en", gapMs: 400, soundDurationMs });
    // Play: a stepped clock walks narrated time forward, frame by frame.
    const clock = steppedClock(1000 / 60);
    const played = new Map<number, ReturnType<typeof narrationAt>>();
    const instants = Array.from({ length: 10 }, (_, i) => Math.round(((i * 7919) % 1000) / 1000 * schedule.totalMs));
    let frames = 0;
    while (clock.now() <= schedule.totalMs) {
      for (const at of instants) if (!played.has(at) && clock.now() >= at) played.set(at, narrationAt(schedule, at));
      clock.step();
      frames += 1;
    }
    expect(frames).toBeGreaterThan(100); // the loop really ran
    for (const at of instants) {
      expect(played.has(at), `played to ${at}`).toBe(true);
      expect(narrationAt(schedule, at)).toEqual(played.get(at));
    }
  });

  it("reports where in a recording t is, for setting an audio element's currentTime", () => {
    const schedule = compileNarratedPlayback(timelineFor(), cues, [], { locale: "en" });
    const clip = schedule.segments[2]!.narration[0]!;
    expect(narrationAt(schedule, clip.startMs + 250)).toEqual({ clip, offsetMs: 250 });
    expect(narrationAt(schedule, clip.endMs)).not.toEqual(expect.objectContaining({ clip }));
    expect(segmentAt(schedule, clip.startMs + 1)?.index).toBe(2);
  });

  it("keeps reduced motion's shorter animation and the full narration", () => {
    const full = compileNarratedPlayback(timelineFor(false), cues, [], { locale: "en", gapMs: 0 });
    const reduced = compileNarratedPlayback(timelineFor(true), cues, [], { locale: "en", gapMs: 0 });
    // Narration is content: every recording still plays, start to finish.
    expect(reduced.segments.map((s) => s.narration.map((c) => c.endMs - c.startMs))).toEqual(
      full.segments.map((s) => s.narration.map((c) => c.endMs - c.startMs)),
    );
    expect(reduced.segments.every((s) => s.animationEndMs - s.startMs <= full.segments[s.index]!.animationEndMs - full.segments[s.index]!.startMs)).toBe(true);
  });

  it("reports a cue on a step the slide no longer has, and plays it nowhere", () => {
    const orphan = { ...cues[0]!, id: "nar_01JB8Z9K2QW4RN7F3XZZZZZZZZ", step: 9 };
    const schedule = compileNarratedPlayback(timelineFor(), [...cues, orphan], [], { locale: "en" });
    expect(schedule.orphaned).toEqual([orphan.id]);
    expect(schedule.segments.flatMap((segment) => segment.narration.map((clip) => clip.cueId))).not.toContain(orphan.id);
  });
});

describe("sounds on the timeline", () => {
  it("fires a click sound naming nothing with every click", () => {
    const schedule = compileNarratedPlayback(timelineFor(), cues, sounds, { locale: "en", soundDurationMs });
    expect(schedule.sounds.map((sound) => sound.segment)).toEqual([1, 2, 3]);
    for (const sound of schedule.sounds) expect(sound.atMs).toBe(schedule.segments[sound.segment]!.startMs);
    expect(soundsBetween(schedule, -1, schedule.totalMs)).toHaveLength(3);
    const first = schedule.sounds[0]!;
    expect(soundsAt(schedule, first.atMs + 10)).toEqual([{ sound: first, offsetMs: 10 }]);
  });

  it("fires a click sound naming an element with the click that reveals it", () => {
    const timeline = timelineFor();
    const target = (slide.animations as AnimationTrack[])[1]!.targetId;
    const schedule = compileNarratedPlayback(timeline, [], [{ ...sounds[0]!, trigger: { type: "click", targetId: target } }], { locale: "en" });
    expect(schedule.sounds.map((sound) => sound.segment)).toEqual([2]);
  });
});

describe("the narration lane", () => {
  it("places bars on the timeline's own clock and marks missing takes", () => {
    const timeline = timelineFor();
    const bars = narrationBars(timeline, cues, "en");
    // Each line starts at its step, or once the step before has finished
    // speaking, whichever is later: a narrated deck waits for the voice.
    let spoken = 0;
    bars.forEach((bar, index) => {
      expect(bar.startMs).toBe(Math.max(timeline.segments[index]!.startMs, spoken));
      spoken = bar.startMs + bar.durationMs;
    });
    for (let i = 1; i < bars.length; i += 1) expect(bars[i]!.startMs).toBeGreaterThanOrEqual(bars[i - 1]!.startMs + bars[i - 1]!.durationMs);
    expect(bars.every((bar) => !bar.missing)).toBe(true);
    expect(narrationBars(timeline, cues, "fr").every((bar) => bar.missing && bar.durationMs >= 800)).toBe(true);
  });
});
