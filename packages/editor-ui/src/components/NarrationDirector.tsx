"use client";

import { useEffect, useMemo, useRef } from "react";
import { compileNarratedPlayback, compileTimeline, type NarrationCueInput, type SoundCueInput } from "@deckastra/animation-engine";
import { DEFAULT_NARRATION_GAP_MS, type AnimationTrack } from "@deckastra/presentation-schema";
import { librarySoundDurationMs, type DocumentScene, type SlideScene } from "@deckastra/renderer";

import { audioContext, speakingAt, stepPlan, StepPlayer } from "../lib/audio-player";

/**
 * Narration in present mode (integration plan 01 §3.4). Renders nothing.
 *
 * Mounted in the **audience** window only, because that window is the
 * authority on the talk: it alone plays the slide's motion, so it alone knows
 * which step is showing, and two windows playing one voice is an echo.
 *
 * It watches the step present mode reports and plays that step's recordings and
 * sounds from the compiled schedule. In a narrated deck it also asks to advance
 * when the step's motion and voice have both finished, plus the gap. Pausing
 * (the screen blacked out, or narration muted) stops the audio and remembers
 * how far into the step it was; resuming asks the schedule for a fresh plan at
 * that offset, so the voice picks up where the schedule says it is.
 *
 * A slide entered backwards plays nothing: a presenter stepping back is
 * checking something the room has already heard (doc 04 §26.3).
 */

/** How long a step with nothing said stays up in a narrated deck. */
export const SILENT_STEP_MS = 3_000;

export interface SpeakingNow {
  slideId: string;
  cueId: string;
  text: string;
  remainingMs: number;
  wordIndex?: number;
  word?: string;
}

export function NarrationDirector({
  scene,
  slide,
  index,
  step,
  enteredBackwards,
  paused,
  muted,
  reducedMotion,
  resolveAssetUrl,
  onAdvance,
  onSpeaking,
}: {
  scene: DocumentScene;
  slide: SlideScene;
  index: number;
  step: number;
  enteredBackwards: boolean;
  paused: boolean;
  muted: boolean;
  reducedMotion: boolean;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Narrated playback only: the step is done. */
  onAdvance?: () => void;
  onSpeaking?: (now: SpeakingNow | null) => void;
}) {
  const narrated = scene.playback?.mode === "narrated";
  const schedule = useMemo(() => {
    const timeline = compileTimeline(slide, (slide.animations ?? []) as AnimationTrack[], { systemPrefersReducedMotion: reducedMotion });
    return compileNarratedPlayback(timeline, (slide.narration?.cues ?? []) as NarrationCueInput[], (slide.soundCues ?? []) as SoundCueInput[], {
      locale: scene.locale,
      gapMs: scene.playback?.gapMs ?? DEFAULT_NARRATION_GAP_MS,
      silentStepMs: narrated ? SILENT_STEP_MS : 0,
      soundDurationMs: (source) => ("library" in source ? librarySoundDurationMs(source.library) : (scene.audio[source.assetId]?.durationMs ?? 0)),
      ...(scene.soundtrack && soundtrackApplies(scene, slide.slideId)
        ? {
            soundtrack: scene.soundtrack,
            soundtrackDurationMs: "library" in scene.soundtrack.source
              ? librarySoundDurationMs(scene.soundtrack.source.library)
              : (scene.audio[scene.soundtrack.source.assetId]?.durationMs ?? 0),
          }
        : {}),
    });
  }, [slide, reducedMotion, scene.locale, scene.playback?.gapMs, scene.audio, scene.soundtrack, scene.slides, narrated]);

  // How far into the current step we are: banked while paused, counted from
  // `startedAt` while playing. Reset whenever the step itself changes.
  const progress = useRef({ key: "", banked: 0, startedAt: 0 });
  const key = `${index}:${step}`;
  if (progress.current.key !== key) progress.current = { key, banked: 0, startedAt: performance.now() };

  const advance = useRef(onAdvance);
  advance.current = onAdvance;
  const speaking = useRef(onSpeaking);
  speaking.current = onSpeaking;

  useEffect(() => {
    if (enteredBackwards) {
      speaking.current?.(null);
      return;
    }
    const state = progress.current;
    if (paused) return;
    state.startedAt = performance.now();
    const plan = stepPlan(schedule, step, state.banked);
    if (!plan) return;
    const player = new StepPlayer(resolveAssetUrl ?? (() => undefined), scene.audio, audioContext, muted);
    player.start(plan, narrated ? () => advance.current?.() : undefined);

    // The presenter view's script line, read from the schedule, not the audio.
    const report = () => {
      const offset = state.banked + (performance.now() - state.startedAt);
      const now = speakingAt(schedule, step, offset);
      const cue = now ? slide.narration?.cues.find((candidate) => candidate.id === now.cueId) : undefined;
      speaking.current?.(now && cue ? {
        slideId: slide.slideId, cueId: now.cueId, text: cue.text, remainingMs: now.remainingMs,
        ...(now.wordIndex !== undefined ? { wordIndex: now.wordIndex, word: now.word } : {}),
      } : null);
    };
    report();
    const timer = setInterval(report, 250);
    return () => {
      clearInterval(timer);
      player.stop();
      state.banked += performance.now() - state.startedAt;
    };
  }, [schedule, step, index, enteredBackwards, paused, muted, narrated, resolveAssetUrl, scene.audio, slide]);

  useEffect(() => () => speaking.current?.(null), []);

  return null;
}

function soundtrackApplies(scene: DocumentScene, slideId: string): boolean {
  const music = scene.soundtrack;
  if (!music) return false;
  const at = scene.slides.findIndex((slide) => slide.slideId === slideId);
  const from = music.fromSlideId ? scene.slides.findIndex((slide) => slide.slideId === music.fromSlideId) : 0;
  const through = music.throughSlideId ? scene.slides.findIndex((slide) => slide.slideId === music.throughSlideId) : scene.slides.length - 1;
  return at >= Math.max(0, from) && at <= (through < 0 ? scene.slides.length - 1 : through);
}
