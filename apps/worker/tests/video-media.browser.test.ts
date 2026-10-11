import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { runExport } from "../src/index";

const ffmpeg = process.env.DECKASTRA_FFMPEG;

/**
 * A video clip in a deck reaches a still export as its poster frame, and the
 * report says so. MP4 export, which played the clip itself, was removed on
 * 2026-10-11; PDF and PowerPoint are the exports, and a .mydeck keeps the clip.
 */
describe.skipIf(!ffmpeg)("a video clip in a still export", () => {
  it("draws the clip's poster in a PDF and reports the approximation", async () => {
    const work = mkdtempSync(join(tmpdir(), "deckastra-video-media-"));
    try {
      const posterPath = join(work, "poster.png");
      const makePoster = spawnSync(ffmpeg!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", posterPath], { windowsHide: true });
      expect(makePoster.status, makePoster.stderr?.toString()).toBe(0);
      const poster = readFileSync(posterPath);

      const document = structuredClone(loadFixture("animation"));
      const videoId = "ast_phase8_video";
      const posterId = "ast_phase8_poster";
      document.metadata.estimatedDurationSeconds = 1;
      document.assets = [
        { id: videoId, type: "video", storageKey: "phase8/clip.mp4", mimeType: "video/mp4", byteSize: 4096, width: 320, height: 180, durationMs: 4000 },
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
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
