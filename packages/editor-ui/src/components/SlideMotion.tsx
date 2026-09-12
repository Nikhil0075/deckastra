"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";

import type { AnimationTrack } from "@deckastra/presentation-schema";
import { DomAnimationAdapter, compileTimeline } from "@deckastra/animation-engine";
import type { SlideScene } from "@deckastra/renderer";

/**
 * Motion for the slide that is on screen, in present mode.
 *
 * Renders nothing. It compiles the current slide's timeline and drives the
 * elements the renderer already put in the DOM — the same adapter and the same
 * compiled timeline the editor preview uses, which is the point: doc 04 §26.1
 * says all three surfaces drive one `CompiledTimeline`, and two implementations
 * of "play the slide" is exactly how an export stops matching the room.
 *
 * The controls it exposes are `next` and `previous`, and both return a boolean.
 * That boolean is the whole navigation contract: false means "this slide has no
 * more segments", which is the caller's cue to change slide. One key, two
 * meanings, resolved here rather than in the keyboard handler.
 */

export interface SlideMotionHandle {
  /** Advance a segment. False when there is none — change slide. */
  next(): boolean;
  /** Back a segment. False when there is none — change slide. */
  previous(): boolean;
  /** Show every element at rest, for entering a slide backwards (§26.3). */
  showFinalState(): void;
  /** True when this slide has motion at all. */
  hasMotion(): boolean;
}

export function SlideMotion({
  scene,
  rootSelector,
  reducedMotion,
  autoPlay = true,
  handle,
}: {
  scene: SlideScene;
  /** Where to look for `data-element-id` boxes. */
  rootSelector: string;
  reducedMotion: boolean;
  /** False when entering the slide backwards. */
  autoPlay?: boolean;
  handle?: Ref<SlideMotionHandle>;
}) {
  const adapter = useRef<DomAnimationAdapter | null>(null);

  const timeline = useMemo(
    () =>
      compileTimeline(scene, (scene.animations ?? []) as AnimationTrack[], {
        // The OS preference, honoured here rather than by a media query on one
        // keyframe. A presenter who asked for less motion gets the fallbacks,
        // and the deck cannot override that (doc 04 §27.1).
        systemPrefersReducedMotion: reducedMotion,
      }),
    [scene, reducedMotion],
  );

  useEffect(() => {
    if (timeline.clips.length === 0) {
      adapter.current = null;
      return;
    }

    const root = window.document.querySelector<HTMLElement>(rootSelector);
    if (!root) return;

    const instance = new DomAnimationAdapter(timeline, (targetId, subTarget) => {
      const selector = subTarget
        ? `[data-element-id="${CSS.escape(targetId)}"] [data-sub-target="${CSS.escape(subTarget)}"]`
        : `[data-element-id="${CSS.escape(targetId)}"]`;
      return root.querySelector<HTMLElement>(selector);
    });

    adapter.current = instance;

    if (autoPlay) {
      instance.play();
    } else {
      // Entering backwards: the final state, never a replayed entrance. Doc 04
      // §26.3 — replaying an entrance backwards is disorienting and replaying it
      // forwards looks like the slide is loading again.
      instance.enterAtEnd();
    }

    return () => {
      instance.stop();
      instance.dispose();
      adapter.current = null;
    };
  }, [timeline, rootSelector, autoPlay]);

  useImperativeHandle(
    handle,
    () => ({
      next: () => adapter.current?.next() ?? false,
      previous: () => adapter.current?.previous() ?? false,
      showFinalState: () => adapter.current?.enterAtEnd(),
      hasMotion: () => timeline.clips.length > 0,
    }),
    [timeline.clips.length],
  );

  return null;
}
