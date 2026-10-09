/**
 * Deterministic narrated MP4 export (agent-first plan, Phase 6).
 *
 * Frames are sampled from the same resolved scene and compiled timeline as
 * Present mode. Audio is placed from the compiled narration schedule. ffmpeg
 * only encodes/muxes those timestamped inputs; it never records wall-clock
 * playback, so a slow frame cannot make the voice drift.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  compileNarratedPlayback,
  compileTimeline,
  segmentAt,
  spokenWordAt,
  type NarratedSchedule,
  type NarrationCueInput,
  type SoundCueInput,
  type SoundtrackGainPoint,
} from "@deckastra/animation-engine";
import { DegradationLedger, sceneUsedEstimatedMetrics, slidesToExport, type ExportImage, type ExportOptions, type ExportReport } from "@deckastra/export-core";
import type { AnimationTrack, PresentationDocument } from "@deckastra/presentation-schema";
import { librarySoundDurationMs, librarySoundWav, type DocumentScene, type SlideScene } from "@deckastra/renderer";

import type { RenderPage } from "./render-page";
import { slideHtml, settle } from "./render";
import type { AssetLibrary } from "./assets";

export interface VideoExportOptions extends ExportOptions {
  fps?: 24 | 30 | 60;
}

export interface VideoSlidePlan {
  slideId: string;
  startMs: number;
  durationMs: number;
  timelineDurationMs: number;
  schedule: NarratedSchedule;
  scene: SlideScene;
  cueText: Record<string, string>;
}

export interface VideoAudioEvent {
  source: { assetId: string } | { library: string };
  startMs: number;
  durationMs: number;
  volume: number;
  loop?: boolean;
  gain?: SoundtrackGainPoint[];
}

export interface VideoPlan {
  fps: 24 | 30 | 60;
  frameDurationMs: number;
  frameCount: number;
  durationMs: number;
  slides: VideoSlidePlan[];
  audio: VideoAudioEvent[];
}

const SILENT_STEP_MS = 3_000;
const DEFAULT_SLIDE_MS = 5_000;

function soundtrackApplies(scene: DocumentScene, slideId: string): boolean {
  const music = scene.soundtrack;
  if (!music) return false;
  const at = scene.slides.findIndex((slide) => slide.slideId === slideId);
  const from = music.fromSlideId ? scene.slides.findIndex((slide) => slide.slideId === music.fromSlideId) : 0;
  const through = music.throughSlideId ? scene.slides.findIndex((slide) => slide.slideId === music.throughSlideId) : scene.slides.length - 1;
  return at >= Math.max(0, from) && at <= (through < 0 ? scene.slides.length - 1 : through);
}

/** Compile slide/frame/audio placement without touching a clock or encoder. */
export function compileVideoPlan(
  document: PresentationDocument,
  scene: DocumentScene,
  options: VideoExportOptions = {},
): VideoPlan {
  const fps = options.fps ?? 30;
  if (![24, 30, 60].includes(fps)) throw new Error("MP4 frame rate must be 24, 30 or 60 fps.");
  const wanted = new Set(slidesToExport(document, options));
  const sourceSlides = new Map(document.slides.map((slide) => [slide.id, slide]));
  const selected = scene.slides.filter((slide) => wanted.has(slide.slideId));
  const narrated = scene.playback?.mode === "narrated";
  const fallback = document.metadata.estimatedDurationSeconds
    ? Math.max(1_000, document.metadata.estimatedDurationSeconds * 1_000 / Math.max(1, selected.length))
    : DEFAULT_SLIDE_MS;
  const slides: VideoSlidePlan[] = [];
  const audio: VideoAudioEvent[] = [];
  let cursor = 0;

  for (const slide of selected) {
    const source = sourceSlides.get(slide.slideId);
    const timeline = compileTimeline(slide, (slide.animations ?? []) as AnimationTrack[], { userMotionPreference: "full" });
    const schedule = compileNarratedPlayback(
      timeline,
      (source?.narration?.cues ?? []) as NarrationCueInput[],
      (source?.soundCues ?? []) as SoundCueInput[],
      {
        locale: scene.locale,
        gapMs: scene.playback?.gapMs,
        silentStepMs: narrated ? SILENT_STEP_MS : 0,
        soundDurationMs: (item) => "library" in item
          ? librarySoundDurationMs(item.library)
          : (scene.audio[item.assetId]?.durationMs ?? 0),
        ...(scene.soundtrack && soundtrackApplies(scene, slide.slideId)
          ? {
              soundtrack: scene.soundtrack,
              soundtrackDurationMs: "library" in scene.soundtrack.source
                ? librarySoundDurationMs(scene.soundtrack.source.library)
                : (scene.audio[scene.soundtrack.source.assetId]?.durationMs ?? 0),
            }
          : {}),
      },
    );
    const durationMs = narrated
      ? Math.max(schedule.totalMs, timeline.durationMs, 1)
      : Math.max(timeline.durationMs + 1_000, fallback);
    slides.push({
      slideId: slide.slideId,
      startMs: cursor,
      durationMs,
      timelineDurationMs: timeline.durationMs,
      schedule,
      scene: slide,
      cueText: Object.fromEntries((source?.narration?.cues ?? []).map((cue) => [cue.id, cue.text ?? ""])),
    });

    for (const segment of schedule.segments) for (const clip of segment.narration) {
      audio.push({
        source: { assetId: clip.assetId },
        startMs: cursor + clip.startMs,
        durationMs: clip.endMs - clip.startMs,
        volume: 10 ** ((clip.gainDb ?? 0) / 20),
      });
    }
    for (const sound of schedule.sounds) audio.push({
      source: sound.source,
      startMs: cursor + sound.atMs,
      durationMs: sound.durationMs,
      volume: sound.volume,
    });
    if (schedule.soundtrack) audio.push({
      source: schedule.soundtrack.source,
      startMs: cursor,
      durationMs,
      volume: 1,
      loop: schedule.soundtrack.loop,
      gain: schedule.soundtrack.gain,
    });
    cursor += durationMs;
  }

  const frameDurationMs = 1_000 / fps;
  const frameCount = Math.max(1, Math.ceil(cursor / frameDurationMs));
  // Both streams are trimmed to this quantized boundary. Their difference is
  // therefore zero; even a container reporting one final packet differently is
  // bounded by one frame, the Phase 6 acceptance threshold.
  const durationMs = frameCount * frameDurationMs;
  return { fps, frameDurationMs, frameCount, durationMs, slides, audio };
}

export function videoFrameAt(plan: VideoPlan, frame: number): {
  slide: VideoSlidePlan;
  localMs: number;
  timelineMs: number;
  caption?: { text: string; wordIndex?: number; word?: string };
} {
  const timeMs = Math.min(plan.durationMs, Math.max(0, frame) * plan.frameDurationMs);
  const slide = plan.slides.findLast((one) => timeMs >= one.startMs) ?? plan.slides[0];
  if (!slide) throw new Error("There are no slides to export.");
  const localMs = Math.min(slide.durationMs, Math.max(0, timeMs - slide.startMs));
  const segment = segmentAt(slide.schedule, localMs);
  const timelineMs = segment
    ? Math.min(segment.timelineEndMs, segment.timelineStartMs + Math.max(0, localMs - segment.startMs))
    : Math.min(slide.timelineDurationMs, localMs);
  const spoken = spokenWordAt(slide.schedule, localMs);
  const position = slide.schedule.segments.flatMap((segment) => segment.narration)
    .find((clip) => localMs >= clip.startMs && localMs < clip.endMs);
  const text = position ? slide.cueText[position.cueId] : undefined;
  return {
    slide,
    localMs,
    timelineMs,
    ...(text ? { caption: { text, ...(spoken ? { wordIndex: spoken.index, word: spoken.word } : {}) } } : {}),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function captionMarkup(caption: { text: string; wordIndex?: number } | undefined): string {
  if (!caption) return "";
  const words = caption.text.match(/\S+/gu) ?? [];
  const content = words.map((word, index) => index === caption.wordIndex
    ? `<mark>${escapeHtml(word)}</mark>`
    : escapeHtml(word)).join(" ");
  return `<style>.deckastra-video-caption{position:fixed;z-index:9999;left:10%;right:10%;bottom:5%;text-align:center;color:white;font:600 42px/1.25 Inter,system-ui,sans-serif;text-shadow:0 2px 8px #000,0 0 24px #000}.deckastra-video-caption span{display:inline-block;padding:14px 24px;border-radius:16px;background:#000b}.deckastra-video-caption mark{color:#071018;background:#70d7ff;border-radius:6px;padding:0 .12em}</style><div class="deckastra-video-caption"><span>${content}</span></div>`;
}

async function seekEmbeddedVideos(page: RenderPage, localMs: number): Promise<void> {
  await page.evaluate(async ({ atMs }) => {
    const clips = [...globalThis.document.querySelectorAll("video")];
    await Promise.all(clips.map(async (clip) => {
      if (clip.readyState < 1) await new Promise<void>((resolve) => {
        const done = () => resolve();
        clip.addEventListener("loadedmetadata", done, { once: true });
        clip.addEventListener("error", done, { once: true });
      });
      if (clip.readyState < 2) await new Promise<void>((resolve) => {
        const done = () => resolve();
        clip.addEventListener("loadeddata", done, { once: true });
        clip.addEventListener("error", done, { once: true });
      });
      if (!Number.isFinite(clip.duration) || clip.duration <= 0) return;
      const start = Number(clip.dataset.videoStartMs || 0) / 1_000;
      const declaredEnd = Number(clip.dataset.videoEndMs || 0) / 1_000;
      const end = declaredEnd > start ? Math.min(declaredEnd, clip.duration) : clip.duration;
      const span = Math.max(0.001, end - start);
      const elapsed = Math.max(0, atMs / 1_000);
      const target = clip.loop ? start + (elapsed % span) : Math.min(end - 0.001, start + elapsed);
      clip.pause();
      if (Math.abs(clip.currentTime - target) < 0.002) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        clip.addEventListener("seeked", done, { once: true });
        clip.addEventListener("error", done, { once: true });
        clip.currentTime = target;
      });
    }));
  }, { atMs: localMs });
}

function audioExtension(contentType: string): string {
  if (/ogg/.test(contentType)) return ".ogg";
  if (/mpeg|mp3/.test(contentType)) return ".mp3";
  if (/mp4|m4a/.test(contentType)) return ".m4a";
  if (/webm/.test(contentType)) return ".webm";
  return ".wav";
}

function gainExpression(points: readonly SoundtrackGainPoint[]): string {
  if (points.length === 0) return "1";
  let expression = String(points.at(-1)!.volume);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const left = points[index]!;
    const right = points[index + 1]!;
    const start = left.atMs / 1_000;
    const span = Math.max(0.000001, (right.atMs - left.atMs) / 1_000);
    const ramp = `${left.volume}+(${right.volume}-${left.volume})*(t-${start})/${span}`;
    expression = `if(lt(t,${right.atMs / 1_000}),${ramp},${expression})`;
  }
  return expression;
}

export interface FfmpegInput { path: string; event: VideoAudioEvent }

/** Build the encoder command separately so cadence and mixing are unit-testable. */
export function ffmpegArguments(
  plan: VideoPlan,
  framePattern: string,
  output: string,
  inputs: readonly FfmpegInput[],
  filterScript: string,
): string[] {
  const args = ["-y", "-loglevel", "error", "-framerate", String(plan.fps), "-start_number", "0", "-i", framePattern];
  for (const input of inputs) {
    if (input.event.loop) args.push("-stream_loop", "-1");
    args.push("-i", input.path);
  }
  if (inputs.length === 0) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  if (inputs.length) args.push("-filter_complex_script", filterScript);
  args.push("-map", "0:v:0", "-map", inputs.length ? "[aout]" : "1:a:0");
  args.push(
    "-frames:v", String(plan.frameCount),
    "-t", (plan.durationMs / 1_000).toFixed(6),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", output,
  );
  return args;
}

function encoderPath(env: NodeJS.ProcessEnv): string {
  return env.DECKASTRA_FFMPEG?.trim() || "ffmpeg";
}

function runEncoder(path: string, args: string[]): void {
  const result = spawnSync(path, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("MP4 export needs ffmpeg. Set DECKASTRA_FFMPEG to an LGPL-compatible ffmpeg executable.");
    }
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`The MP4 encoder failed: ${(result.stderr || result.stdout || "unknown error").trim().slice(0, 800)}`);
}

export async function renderVideo(
  document: PresentationDocument,
  scene: DocumentScene,
  page: RenderPage,
  library: AssetLibrary,
  options: VideoExportOptions,
  fontCss = "",
  onProgress: (done: number, total: number) => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ bytes: Uint8Array; report: ExportReport; plan: VideoPlan }> {
  const plan = compileVideoPlan(document, scene, options);
  const work = mkdtempSync(join(tmpdir(), "deckastra-video-"));
  const output = join(work, "deck.mp4");
  try {
    for (let frame = 0; frame < plan.frameCount; frame += 1) {
      const at = videoFrameAt(plan, frame);
      await page.setContent(slideHtml(at.slide.scene, at.timelineMs, [], library.resolve, fontCss) + captionMarkup(at.caption), { waitUntil: "load" });
      await settle(page);
      await seekEmbeddedVideos(page, at.localMs);
      const bytes = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: scene.viewport.width, height: scene.viewport.height },
        animations: "disabled",
      });
      writeFileSync(join(work, `frame-${String(frame).padStart(8, "0")}.png`), bytes);
      if (frame === 0 || frame === plan.frameCount - 1 || frame % Math.max(1, Math.floor(plan.fps / 2)) === 0) onProgress(frame + 1, plan.frameCount);
    }

    const supplied = library.audio();
    const inputs: FfmpegInput[] = [];
    const filters: string[] = [];
    for (const [index, event] of plan.audio.entries()) {
      let bytes: Uint8Array | undefined;
      let extension = ".wav";
      if ("library" in event.source) bytes = librarySoundWav(event.source.library);
      else {
        const asset: ExportImage | undefined = supplied.get(event.source.assetId);
        bytes = asset?.bytes;
        if (asset) extension = audioExtension(asset.contentType);
      }
      if (!bytes) continue;
      const path = join(work, `audio-${index}${extension}`);
      writeFileSync(path, bytes);
      inputs.push({ path, event });
      const inputIndex = inputs.length;
      const duration = Math.max(0.001, event.durationMs / 1_000);
      const delay = Math.max(0, Math.round(event.startMs));
      const volume = event.gain ? gainExpression(event.gain) : String(Math.max(0, event.volume));
      filters.push(`[${inputIndex}:a]atrim=0:${duration.toFixed(6)},asetpts=PTS-STARTPTS,volume='${volume}':eval=frame,adelay=${delay}:all=1[a${inputIndex}]`);
    }
    if (inputs.length) {
      filters.push(`${inputs.map((_, index) => `[a${index + 1}]`).join("")}amix=inputs=${inputs.length}:normalize=0:duration=longest,alimiter=limit=0.95,atrim=0:${(plan.durationMs / 1_000).toFixed(6)}[aout]`);
    }
    const filterScript = join(work, "audio.filter");
    writeFileSync(filterScript, filters.join(";\n"), "utf8");
    const args = ffmpegArguments(plan, join(work, "frame-%08d.png"), output, inputs, filterScript);
    runEncoder(encoderPath(env), args);

    const ledger = new DegradationLedger();
    for (const warning of library.problems(plan.slides.map((slide) => slide.scene))) ledger.record(warning);
    for (const slide of document.slides) {
      if (!plan.slides.some((planned) => planned.slideId === slide.id) || !slide.transition) continue;
      ledger.record({
        severity: "info", slideId: slide.id, feature: "transition", action: "approximated",
        message: "The MP4 uses an exact cut at this slide boundary; its authored transition is not yet composited between frames.",
      });
    }
    const missing = plan.audio.filter((event) => "assetId" in event.source && !supplied.has(event.source.assetId));
    for (const event of missing) ledger.record({
      severity: "warning", slideId: "", feature: `audio:${"assetId" in event.source ? event.source.assetId : "unknown"}`,
      action: "dropped", message: "An audio file was unavailable, so it is silent in this video.",
    });
    const report = ledger.report(plan.slides.length, Math.round(plan.durationMs));
    if (plan.slides.some((slide) => sceneUsedEstimatedMetrics(slide.scene))) report.metricsEstimated = true;
    return { bytes: new Uint8Array(readFileSync(output)), report, plan };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
