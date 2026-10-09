import { describe, expect, it } from "vitest";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import {
  chooseVideoEncoder,
  compileVideoPlan,
  encoderFailureMessage,
  ffmpegArguments,
  filterScriptOption,
  parseEncoders,
  VIDEO_ENCODERS,
  videoFrameAt,
} from "../src/video";

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

  it("encodes with Media Foundation where an LGPL ffmpeg has no libx264", () => {
    const document = loadFixture("multilingual");
    const plan = compileVideoPlan(document, buildDocumentScene(document), { fps: 24 });
    const encoder = chooseVideoEncoder(new Set(["h264_mf", "aac", "png"]));
    const args = ffmpegArguments(plan, "f-%08d.png", "out.mp4", [], "mix.filter", encoder);
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "h264_mf"]);
    expect(args).not.toContain("libx264");
    expect(args).toContain("aac");
  });
});

describe("choosing an H.264 encoder", () => {
  // Trimmed from real `ffmpeg -hide_banner -encoders` output.
  const listing = [
    "Encoders:",
    " V..... = Video",
    " A..... = Audio",
    " ------",
    " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
    " V....D h264_mf              H264 via MediaFoundation (codec h264)",
    " V....D png                  PNG (Portable Network Graphics) image",
    " A....D aac                  AAC (Advanced Audio Coding)",
  ].join("\r\n");

  it("reads encoder names, not the legend", () => {
    expect([...parseEncoders(listing)].sort()).toEqual(["aac", "h264_mf", "libx264", "png"]);
  });

  it("prefers libx264 where the build has it (the cloud image)", () => {
    expect(chooseVideoEncoder(parseEncoders(listing)).name).toBe("libx264");
  });

  it("falls back to Media Foundation for an LGPL build", () => {
    expect(chooseVideoEncoder(new Set(["h264_mf", "aac"])).name).toBe("h264_mf");
  });

  it("never falls back to an OpenH264 compiled into ffmpeg", () => {
    expect(VIDEO_ENCODERS.map((encoder) => encoder.name)).not.toContain("libopenh264");
    expect(() => chooseVideoEncoder(new Set(["libopenh264", "aac"]))).toThrow(/H\.264 encoder/);
  });

  it("refuses a build without the built-in AAC encoder", () => {
    expect(() => chooseVideoEncoder(new Set(["h264_mf", "libfdk_aac"]))).toThrow(/AAC/);
  });

  it("tells a Windows N user what to install when Media Foundation fails, and only then", () => {
    const [x264, mf] = VIDEO_ENCODERS;
    expect(encoderFailureMessage(mf!, "MFStartup failed: 0xc00d36b3")).toMatch(/Media Feature Pack/);
    // Found with a real ffmpeg 9.0: an argument error is not a missing feature pack.
    expect(encoderFailureMessage(mf!, "Unrecognized option 'filter_complex_script'.")).not.toMatch(/Media Feature Pack/);
    expect(encoderFailureMessage(x264!, "boom")).not.toMatch(/Media Feature Pack/);
  });
});

describe("reading the audio mix from a file", () => {
  it("uses the old option where only it exists (Debian bookworm's 5.1, the cloud image)", () => {
    expect(filterScriptOption("ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers")).toBe("-filter_complex_script");
    expect(filterScriptOption("ffmpeg version 6.1.1 Copyright")).toBe("-filter_complex_script");
  });

  it("uses -/filter_complex from 7.0, where 9.0 no longer knows the old option", () => {
    expect(filterScriptOption("ffmpeg version 7.0 Copyright")).toBe("-/filter_complex");
    expect(filterScriptOption("ffmpeg version n9.0.2-24-gfd5d616c29-20261009 Copyright (c) 2000-2026")).toBe("-/filter_complex");
  });

  it("treats a build with no release number as current", () => {
    expect(filterScriptOption("ffmpeg version N-118123-g1a2b3c4d Copyright")).toBe("-/filter_complex");
  });

  it("puts the chosen option in front of the mix file", () => {
    const document = loadFixture("multilingual");
    const plan = compileVideoPlan(document, buildDocumentScene(document), { fps: 24 });
    const args = ffmpegArguments(plan, "f-%08d.png", "out.mp4", [{ path: "voice.wav", event: plan.audio[0]! }], "mix.filter",
      VIDEO_ENCODERS[1], "-/filter_complex");
    expect(args.slice(args.indexOf("-/filter_complex"), args.indexOf("-/filter_complex") + 2)).toEqual(["-/filter_complex", "mix.filter"]);
    expect(args).not.toContain("-filter_complex_script");
  });
});
