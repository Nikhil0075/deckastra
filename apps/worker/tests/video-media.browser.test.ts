import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { runExport } from "../src/index";
import { detectFfmpeg } from "../src/video";

const encoder = process.env.DECKASTRA_FFMPEG;

describe.skipIf(!encoder)("generated video export handling", () => {
  it("uses a poster in PDF and real clip frames in narrated MP4", async () => {
    const work = mkdtempSync(join(tmpdir(), "deckastra-video-media-"));
    try {
      const clipPath = join(work, "clip.mp4");
      const posterPath = join(work, "poster.png");
      // The clip is made with whichever H.264 encoder this ffmpeg has, as the
      // exporter does: an LGPL desktop build has h264_mf and no libx264.
      const makeClip = spawnSync(encoder!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24:d=4", "-an", ...detectFfmpeg(encoder!).encoder.args, clipPath], { windowsHide: true });
      const makePoster = spawnSync(encoder!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", posterPath], { windowsHide: true });
      expect(makeClip.status, makeClip.stderr?.toString()).toBe(0);
      expect(makePoster.status, makePoster.stderr?.toString()).toBe(0);
      const clip = readFileSync(clipPath);
      const poster = readFileSync(posterPath);

      const document = structuredClone(loadFixture("animation"));
      const videoId = "ast_phase8_video";
      const posterId = "ast_phase8_poster";
      document.metadata.estimatedDurationSeconds = 1;
      document.assets = [
        { id: videoId, type: "video", storageKey: "phase8/clip.mp4", mimeType: "video/mp4", byteSize: clip.length, width: 320, height: 180, durationMs: 4000 },
        { id: posterId, type: "image", storageKey: "phase8/poster.png", mimeType: "image/png", byteSize: poster.length, width: 320, height: 180, altText: "Generated clip poster" },
      ];
      document.slides = [document.slides[0]!];
      document.slides[0]!.elements = [{ id: "el_phase8_video", type: "video", assetId: videoId, posterAssetId: posterId,
        autoplay: true, loop: true, muted: true, fit: "cover", transform: { x: 0, y: 0, width: document.viewport.width, height: document.viewport.height } } as never];
      document.slides[0]!.animations = [];
      document.slides[0]!.transition = undefined;

      const pdf = await runExport({ kind: "pdf", document, options: {}, assets: [
        { assetId: videoId, mimeType: "video/mp4", problem: "moving video is represented by its poster frame in a still export" },
        { assetId: posterId, mimeType: "image/png", data: poster.toString("base64") },
      ] });
      expect(Buffer.from(pdf.bytes).subarray(0, 4).toString()).toBe("%PDF");
      expect(pdf.report.warnings).toContainEqual(expect.objectContaining({ feature: `video:${videoId}`, action: "approximated" }));

      const mp4 = await runExport({ kind: "mp4", document, options: { fps: 24 }, assets: [
        { assetId: videoId, mimeType: "video/mp4", data: clip.toString("base64") },
        { assetId: posterId, mimeType: "image/png", data: poster.toString("base64") },
      ] });
      expect(Buffer.from(mp4.bytes).subarray(4, 8).toString()).toBe("ftyp");
      const exported = join(work, "deck.mp4");
      writeFileSync(exported, mp4.bytes);
      const pixel = spawnSync(encoder!, ["-loglevel", "error", "-i", exported, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true });
      expect(pixel.status, pixel.stderr?.toString()).toBe(0);
      expect(pixel.stdout[0]).toBeGreaterThan(100);
      expect(pixel.stdout[2]).toBeLessThan(90);
      expect(mp4.report.warnings.some((warning) => warning.feature === `video:${videoId}` && warning.action === "dropped")).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
