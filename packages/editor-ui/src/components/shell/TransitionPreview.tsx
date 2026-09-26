"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compileTransition, transitionSlideFromScene } from "@deckastra/animation-engine";
import type { buildDocumentScene } from "@deckastra/renderer";

import { SlideTransition } from "../SlideTransition";
import { Button, Segmented } from "../../ui";

/**
 * The move into this slide, previewed (manual-authoring review MA-25).
 *
 * The canvas's own Preview plays this slide's entrance clips, which says
 * nothing about a transition: a morph is two slides, and judging one from the
 * incoming slide's clips alone is judging half of it. This mounts both slides
 * through `SlideTransition` — the component present mode uses — compiled with
 * `compileTransition`, the same call present mode makes, so the frame at any
 * time here is the frame the room sees at that time.
 *
 * Time is the author's: a scrubber, Start / Middle / End, and Play. Reduced
 * motion is a switch rather than the machine's setting, because an author
 * needs to see what half their audience will get without changing their OS.
 */
export function TransitionPreview({
  scene,
  slideIndex,
  resolveAssetUrl,
}: {
  scene: ReturnType<typeof buildDocumentScene>;
  slideIndex: number;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const to = scene.slides[slideIndex];
  const from = slideIndex > 0 ? scene.slides[slideIndex - 1] : undefined;
  const [motion, setMotion] = useState<"full" | "reduced">("full");
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = useRef(0);

  const compiled = useMemo(
    () =>
      to
        ? compileTransition(to.transition, from ? transitionSlideFromScene(from) : undefined, transitionSlideFromScene(to), { motion })
        : null,
    [to, from, motion],
  );
  const duration = compiled?.durationMs ?? 0;

  // A different transition starts from its beginning.
  useEffect(() => {
    setTimeMs(0);
    setPlaying(false);
  }, [duration, compiled?.type, slideIndex]);

  useEffect(() => {
    if (!playing) return;
    const startedAt = performance.now() - timeMs;
    const step = (now: number) => {
      const t = Math.min(duration, now - startedAt);
      setTimeMs(t);
      if (t >= duration) {
        setPlaying(false);
        return;
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
    // Started once per press; `timeMs` is where it starts from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);

  if (!to || !compiled) return null;

  const width = 256;
  const scale = width / scene.viewport.width;
  const height = scene.viewport.height * scale;

  return (
    <div className="dk-transition-preview" data-testid="transition-preview">
      <div className="dk-transition-preview__stage" style={{ width, height }}>
        <SlideTransition
          // Remounted per slide and per motion level: the controlled stage
          // starts from the compiled plan it was given.
          key={`${to.slideId}:${motion}`}
          compiled={compiled}
          to={to}
          from={from}
          width={width}
          height={height}
          scale={scale}
          stageAttribute="data-transition-preview-stage"
          resolveAssetUrl={resolveAssetUrl}
          timeMs={timeMs}
        />
      </div>
      {duration > 0 ? (
        <>
          <input
            type="range"
            className="dk-transition-preview__scrub"
            aria-label="Transition time"
            min={0}
            max={duration}
            step={1}
            value={Math.round(timeMs)}
            onChange={(event) => {
              setPlaying(false);
              setTimeMs(Number(event.target.value));
            }}
            data-testid="transition-scrub"
          />
          <div className="dk-transition-preview__controls">
            <Button
              size="sm"
              icon={playing ? "pause" : "play"}
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                  return;
                }
                if (timeMs >= duration) setTimeMs(0);
                setPlaying(true);
              }}
              data-testid="transition-play"
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setTimeMs(0); }}>
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setTimeMs(duration / 2); }} data-testid="transition-middle">
              Middle
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setTimeMs(duration); }}>
              End
            </Button>
          </div>
          <span className="dk-field__hint" aria-live="polite">
            {Math.round(timeMs)} of {duration} ms
          </span>
        </>
      ) : (
        <p className="dk-muted">
          {slideIndex === 0
            ? "The talk starts on this slide, so there is nothing before it to move from."
            : motion === "reduced"
              ? "With reduced motion this transition is a cut: the slide is simply there."
              : "A cut: the slide is simply there."}
        </p>
      )}
      <Segmented
        label="Preview as"
        size="sm"
        value={motion}
        onChange={(value) => setMotion(value)}
        items={[
          { value: "full", label: "Full motion" },
          { value: "reduced", label: "Reduced motion" },
        ]}
      />
    </div>
  );
}
