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

export interface VideoEncoder {
  name: "libx264" | "h264_mf";
  args: readonly string[];
}

/**
 * H.264 encoders in order of preference. Every one writes H.264 in MP4, which
 * is what PowerPoint embeds and every player opens.
 *
 * `libx264` is GPL, so it is used only where ffmpeg is not redistributed: the
 * cloud export image installs Debian's ffmpeg. A desktop installer hands
 * ffmpeg to users and therefore ships an LGPL build, which has no libx264 and
 * encodes through Windows' own Media Foundation H.264 encoder instead; its
 * patent licence comes with the operating system. OpenH264 is deliberately not
 * a fallback: Cisco covers royalties only for its own binary downloaded
 * separately to the user's device, never for a copy compiled into ffmpeg.
 */
export const VIDEO_ENCODERS: readonly VideoEncoder[] = [
  { name: "libx264", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"] },
  { name: "h264_mf", args: ["-c:v", "h264_mf", "-rate_control", "quality", "-quality", "80", "-pix_fmt", "yuv420p"] },
];

/** Encoder names from `ffmpeg -hide_banner -encoders`, e.g. " V....D libx264 ...". */
export function parseEncoders(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (match && match[1] !== "=") names.add(match[1]!);
  }
  return names;
}

/** The first preferred H.264 encoder this ffmpeg has, refusing a build that cannot write H.264/AAC. */
export function chooseVideoEncoder(available: ReadonlySet<string>): VideoEncoder {
  const encoder = VIDEO_ENCODERS.find((candidate) => available.has(candidate.name));
  if (!encoder) {
    throw new Error(
      "MP4 export needs an ffmpeg with an H.264 encoder (libx264 or Windows Media Foundation's h264_mf); this one has neither.",
    );
  }
  if (!available.has("aac")) throw new Error("MP4 export needs an ffmpeg with the built-in AAC encoder; this one has none.");
  return encoder;
}

/** Build the encoder command separately so cadence and mixing are unit-testable. */
export function ffmpegArguments(
  plan: VideoPlan,
  framePattern: string,
  output: string,
  inputs: readonly FfmpegInput[],
  filterScript: string,
  encoder: VideoEncoder = VIDEO_ENCODERS[0]!,
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
    ...encoder.args,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", output,
  );
  return args;
}

function encoderPath(env: NodeJS.ProcessEnv): string {
  return env.DECKASTRA_FFMPEG?.trim() || "ffmpeg";
}

const MISSING_FFMPEG = "MP4 export needs ffmpeg. Set DECKASTRA_FFMPEG to an LGPL-compatible ffmpeg executable.";
const probed = new Map<string, VideoEncoder>();

/** Ask this ffmpeg once which encoders it has; remembered per executable path. */
export function detectVideoEncoder(path: string): VideoEncoder {
  const known = probed.get(path);
  if (known) return known;
  const result = spawnSync(path, ["-hide_banner", "-encoders"], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(MISSING_FFMPEG);
    throw result.error;
  }
  if (result.status !== 0) throw new Error(`ffmpeg could not list its encoders: ${(result.stderr || "unknown error").trim().slice(0, 400)}`);
  const encoder = chooseVideoEncoder(parseEncoders(result.stdout));
  probed.set(path, encoder);
  return encoder;
}

/** What to tell a person when the encoder itself fails. */
export function encoderFailureMessage(encoder: VideoEncoder, output: string): string {
  const detail = output.trim().slice(0, 800) || "unknown error";
  if (encoder.name === "h264_mf") {
    // Windows "N" editions ship without Media Foundation; ffmpeg still lists
    // h264_mf, and the failure only appears when it tries to start it.
    return `The MP4 encoder failed: ${detail} This export uses Windows' built-in H.264 encoder. ` +
      "On Windows N editions, install the Media Feature Pack from Windows Settings, then export again.";
  }
  return `The MP4 encoder failed: ${detail}`;
}

function runEncoder(path: string, args: string[], encoder: VideoEncoder): void {
  const result = spawnSync(path, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(MISSING_FFMPEG);
    throw result.error;
  }
  if (result.status !== 0) throw new Error(encoderFailureMessage(encoder, result.stderr || result.stdout || ""));
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
  // Before any frame is drawn: an ffmpeg that cannot write H.264/AAC should
  // fail in a second, not after rendering a whole deck.
  const executable = encoderPath(env);
  const encoder = detectVideoEncoder(executable);
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
    const args = ffmpegArguments(plan, join(work, "frame-%08d.png"), output, inputs, filterScript, encoder);
    runEncoder(executable, args, encoder);

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
