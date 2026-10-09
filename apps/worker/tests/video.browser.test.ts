import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { librarySoundWav } from "@deckastra/renderer";

import { runExport } from "../src/index";

const encoder = process.env.DECKASTRA_FFMPEG;

function streamDuration(path: string, selector: "v:0" | "a:0"): number {
  const result = spawnSync(encoder!, [
    "-nostats", "-loglevel", "error", "-i", path, "-map", `0:${selector}`,
    "-f", "null", "-", "-progress", "pipe:1",
  ], { encoding: "utf8", windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  const values = [...result.stdout.matchAll(/out_time_us=(\d+)/g)].map((match) => Number(match[1]));
  return Math.max(...values) / 1_000;
}

describe.skipIf(!encoder)("narrated MP4 acceptance", () => {
  it("exports ten narrated slides that decode with no more than one frame of drift", async () => {
    const document = structuredClone(loadFixture("multilingual"));
    const source = document.slides.find((slide) => slide.narration?.cues.length)!;
    const asset = structuredClone(document.assets!.find((item) => item.type === "audio")!);
    asset.id = "ast_phase6_voice";
    asset.storageKey = "phase6/voice.wav";
    asset.mimeType = "audio/wav";
    asset.durationMs = 300;
    asset.fileName = "voice.wav";
    document.assets = [asset];
    document.playback = { mode: "narrated", gapMs: 0 };
    document.soundtrack = undefined;
    document.slides = Array.from({ length: 10 }, (_, index) => {
      const slide = structuredClone(source);
      slide.id = `sld_phase6_${index}`;
      slide.name = `Narrated ${index + 1}`;
      slide.animations = [];
      slide.soundCues = [];
      slide.transition = undefined;
      const cue = structuredClone(source.narration!.cues[0]!);
      cue.id = `nar_phase6_${index}`;
      cue.step = 0;
      cue.text = "One precisely timed line";
      cue.takes = {
        en: {
          assetId: asset.id,
          durationMs: 300,
          textHash: `phase6-${index}`,
          voice: "acceptance",
          wordTimings: [
            { word: "One", startMs: 0, endMs: 80 },
            { word: "precisely", startMs: 80, endMs: 180 },
            { word: "timed", startMs: 180, endMs: 240 },
            { word: "line", startMs: 240, endMs: 300 },
          ],
        },
      };
      slide.narration = { cues: [cue] };
      return slide;
    });

    const audio = librarySoundWav("ui-cancel")!;
    const outcome = await runExport({
      kind: "mp4",
      document,
      options: { fps: 30 },
      assets: [{ assetId: asset.id, storageKey: asset.storageKey, mimeType: "audio/wav", data: Buffer.from(audio).toString("base64") }],
    });

    expect(Buffer.from(outcome.bytes).subarray(4, 8).toString()).toBe("ftyp");
    expect(outcome.report.slideCount).toBe(10);
    const work = mkdtempSync(join(tmpdir(), "deckastra-mp4-acceptance-"));
    const path = join(work, "acceptance.mp4");
    try {
      writeFileSync(path, outcome.bytes);
      const videoMs = streamDuration(path, "v:0");
      const audioMs = streamDuration(path, "a:0");
      expect(Math.abs(videoMs - audioMs)).toBeLessThanOrEqual(1_000 / 30);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
