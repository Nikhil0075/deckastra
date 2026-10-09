import { describe, expect, it } from "vitest";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { compileVideoPlan, ffmpegArguments, videoFrameAt } from "../src/video";

describe("deterministic MP4 planning", () => {
  it("quantizes a narrated deck to exact frame boundaries and places its voice", () => {
    const document = loadFixture("multilingual");
    const scene = buildDocumentScene(document);
    const plan = compileVideoPlan(document, scene, { fps: 30 });

    expect(plan.slides.length).toBe(document.slides.length);
    expect(plan.audio.some((event) => "assetId" in event.source)).toBe(true);
    expect(plan.audio.some((event) => "library" in event.source)).toBe(true);
    expect(plan.durationMs).toBeCloseTo(plan.frameCount * (1_000 / 30), 8);
    expect(plan.durationMs - plan.slides.reduce((sum, slide) => sum + slide.durationMs, 0)).toBeLessThanOrEqual(plan.frameDurationMs);
  });

  it("maps a word-linked narrated frame back onto the slide timeline", () => {
    const document = structuredClone(loadFixture("multilingual"));
    const first = document.slides.find((slide) => slide.narration?.cues.length)!;
    const cue = first.narration!.cues[0]!;
    cue.takes!.en!.wordTimings = [
      { word: "Three", startMs: 0, endMs: 300 },
      { word: "ideas", startMs: 300, endMs: 700 },
    ];
    cue.advanceOnWord = 1;
    const plan = compileVideoPlan(document, buildDocumentScene(document), { fps: 30 });
    const planned = plan.slides.find((slide) => slide.slideId === first.id)!;
    const frame = videoFrameAt(plan, Math.ceil((planned.startMs + 500) / plan.frameDurationMs));
    expect(frame.slide.slideId).toBe(first.id);
    expect(frame.timelineMs).toBeGreaterThanOrEqual(0);
    expect(frame.timelineMs).toBeLessThanOrEqual(frame.slide.timelineDurationMs);
    expect(frame.caption?.text).toBe(cue.text);
    expect(frame.caption?.word).toBe("ideas");
  });

  it("builds H.264/AAC arguments with explicit frame and duration bounds", () => {
    const document = loadFixture("multilingual");
    const plan = compileVideoPlan(document, buildDocumentScene(document), { fps: 24 });
    const args = ffmpegArguments(
      plan,
      "frames/frame-%08d.png",
      "out.mp4",
      [{ path: "voice.wav", event: plan.audio[0]! }],
      "mix.filter",
    );
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual(["-frames:v", String(plan.frameCount)]);
    expect(args).toContain("[aout]");
    expect(args.at(-1)).toBe("out.mp4");
  });
});
