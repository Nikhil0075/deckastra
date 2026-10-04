"use client";

import { useEffect, useMemo, useRef } from "react";

import type { AnimationTrack, PresentationDocument } from "@deckastra/presentation-schema";
import {
  DomAnimationAdapter,
  compileTimeline,
  resolveMotionLevel,
} from "@deckastra/animation-engine";
import type { SlideScene } from "@deckastra/renderer";

/**
 * Drives the editor canvas's real elements from the compiled timeline.
 *
 * It renders nothing. Motion is applied to the elements the renderer already
 * emitted — the same `data-element-id` boxes selection resolves against — which
 * is what makes the editor preview and present mode the same preview rather than
 * two implementations that drift.
 *
 * A separate component only because effects need somewhere to live. Putting this
 * in the shell would tie the scrub loop to every unrelated re-render there.
 */

export function MotionPreview({
  document: doc,
  scene,
  slideIndex,
  timeMs,
  playToken,
  engaged,
  onTime,
  tracksOverride,
}: {
  document: PresentationDocument;
  scene: SlideScene;
  slideIndex: number;
  timeMs: number;
  /** Incremented to request a play. A counter, not a boolean: pressing Preview
   *  twice in a row should replay, and a boolean that is already true does not. */
  playToken: number;
  /**
   * False until the author scrubs or previews.
   *
   * An editor that opened at t=0 would show every animated element at the start
   * of its own entrance — which for a fade-in means invisible. The author's
   * headline would simply be missing, and unselectable. Resting state is the
   * right default; the motion is what you ask for.
   */
  engaged: boolean;
  onTime: (timeMs: number) => void;
  tracksOverride?: AnimationTrack[];
}) {
  const adapter = useRef<DomAnimationAdapter | null>(null);
  const slide = doc.slides[slideIndex];

  const timeline = useMemo(() => {
    // The viewer's own setting decides, not the deck's (doc 04 §27.1). An editor
    // that always previewed full motion would let an author ship a slide they
    // have never seen the way half their audience will.
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    return compileTimeline(scene, tracksOverride ?? slide?.animations ?? [], {
      systemPrefersReducedMotion: Boolean(prefersReduced),
    });
  }, [scene, slide, tracksOverride]);

  // Whether the level actually resolved to something reduced is worth knowing at
  // the call site; recomputed rather than threaded because it is one comparison.
  const level = resolveMotionLevel(undefined, {
    systemPrefersReducedMotion:
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
  });

  useEffect(() => {
    if (timeline.clips.length === 0) {
      adapter.current?.dispose();
      adapter.current = null;
      return;
    }

    // Scoped to the editor canvas, with no fallback. A `?? document.body` here
    // turns "scope it" into "scope it to everything" the moment the canvas is
    // unmounted — which is exactly what happens when present mode opens, and the
    // editor's preview then reaches into the presenter's stage and resets it.
    const root = window.document.querySelector<HTMLElement>("[data-editor-canvas]");
    if (!root) return;

    const instance = new DomAnimationAdapter(timeline, (targetId, subTarget) => {
      const selector = subTarget
        ? `[data-element-id="${CSS.escape(targetId)}"] [data-sub-target="${CSS.escape(subTarget)}"]`
        : `[data-element-id="${CSS.escape(targetId)}"]`;
      return root.querySelector<HTMLElement>(selector);
    });

    instance.on("complete", (event) => onTime(event.state.timeMs));
    instance.on("segment", (event) => onTime(event.state.timeMs));
    adapter.current = instance;

    // Resting state until asked otherwise, so opening a slide shows the slide
    // rather than the first frame of its entrance.
    instance.enterAtEnd();

    return () => {
      // Stop clears every inline style it wrote. Leaving them behind would
      // freeze the canvas at whatever the last sampled frame was, and the author
      // would be editing a slide that is half-way through its own entrance.
      instance.stop();
      instance.dispose();
      adapter.current = null;
    };
  }, [timeline, onTime]);

  useEffect(() => {
    if (!engaged) {
      adapter.current?.enterAtEnd();
      return;
    }
    adapter.current?.seek(timeMs);
  }, [engaged, timeMs]);

  useEffect(() => {
    if (playToken === 0) return;
    const instance = adapter.current;
    if (!instance) return;

    instance.seek(0);
    instance.play();

    const tick = window.setInterval(() => onTime(instance.state.timeMs), 1000 / 30);
    return () => window.clearInterval(tick);
  }, [playToken, onTime]);

  useEffect(() => {
    if (level === "full" || timeline.clips.length === 0) return;
    // Not a silent difference. An author previewing on a machine set to reduced
    // motion is seeing the fallbacks, and needs to know that is why.
    console.info(
      "[deckastra] Motion preview is running at reduced motion because this machine asks for it.",
    );
  }, [level, timeline.clips.length]);

  return null;
}
