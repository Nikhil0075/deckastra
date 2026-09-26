"use client";

import { useId } from "react";
import type { SlideScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";

import { SlideMotion } from "./SlideMotion";

/**
 * A slide thumbnail at its **final frame** — how the audience sees it once
 * every entrance and click reveal has played.
 *
 * A thumbnail of the resting document is honest and useless for a slide whose
 * content is authored to fade in: its elements rest at `opacity: 0`, and the
 * card or strip shows a black rectangle (the animation fixture's first slide
 * did exactly that). The final frame is what a presenter recognises a slide by,
 * and what an export draws (`final` is the render service's default frame).
 *
 * It uses the motion engine's own `enterAtEnd` — the state present mode shows
 * when a slide is entered backwards — through `SlideMotion` with autoplay off,
 * scoped to this thumbnail so it never touches the canvas or another card.
 * `SlideMotion` is mounted after the slide in the same commit, so the elements
 * it looks up exist when its effect runs (the mount-order bug fixed in present
 * mode in Phase 3).
 */
export function FinalFrameSlide({
  scene,
  width,
  resolveAssetUrl,
}: {
  scene: SlideScene;
  width: number;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  // useId output contains ":" — safe inside a quoted attribute selector.
  const root = useId();
  const hasMotion = (scene.animations?.length ?? 0) > 0;
  return (
    <span data-final-frame={root} style={{ display: "block", lineHeight: 0 }}>
      <ScaledSlide scene={scene} width={width} mode="present" resolveAssetUrl={resolveAssetUrl} />
      {hasMotion ? (
        <SlideMotion
          scene={scene}
          rootSelector={`[data-final-frame="${root}"]`}
          reducedMotion={false}
          autoPlay={false}
        />
      ) : null}
    </span>
  );
}
