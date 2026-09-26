"use client";

import { useMemo } from "react";
import { flattenScene, type SlideScene } from "@deckastra/renderer";

import { FinalFrameSlide } from "../FinalFrameSlide";

/**
 * Which object travels where, drawn (manual-authoring review MA-27).
 *
 * A pair written as "decoration (shape) → decoration (shape)" is two names a
 * person has to trust. This shows the slide before and this slide side by
 * side, with the source outlined on the first and the destination on the
 * second, for whichever pair is being looked at — hovered, focused, or picked
 * in the "Add pair" choosers — so two similarly named objects are told apart
 * by where they are, not by guessing at ids.
 */
export function PairPreview({
  from,
  to,
  sourceId,
  destinationId,
  viewport,
  resolveAssetUrl,
}: {
  viewport: { width: number; height: number };
  from?: SlideScene;
  to?: SlideScene;
  sourceId?: string;
  destinationId?: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  if (!from || !to) return null;
  return (
    <div className="dk-pair-preview" data-testid="pair-preview">
      <Side scene={from} viewport={viewport} highlight={sourceId} label="Slide before" resolveAssetUrl={resolveAssetUrl} />
      <span aria-hidden="true" className="dk-pair-preview__arrow">
        →
      </span>
      <Side scene={to} viewport={viewport} highlight={destinationId} label="This slide" resolveAssetUrl={resolveAssetUrl} />
    </div>
  );
}

function Side({
  scene,
  viewport,
  highlight,
  label,
  resolveAssetUrl,
}: {
  scene: SlideScene;
  viewport: { width: number; height: number };
  highlight?: string;
  label: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const width = 116;
  const scale = width / viewport.width;
  const height = viewport.height * scale;
  const box = useMemo(
    () => (highlight ? flattenScene(scene).find((node) => node.id === highlight)?.bounds : undefined),
    [scene, highlight],
  );
  return (
    <figure className="dk-pair-preview__side" aria-label={label}>
      <div className="dk-pair-preview__slide" style={{ width, height }}>
        {/* The final frame, so objects that fade in are there to be pointed at. */}
        <FinalFrameSlide scene={scene} width={width} resolveAssetUrl={resolveAssetUrl} />
        {box ? (
          <span
            className="dk-pair-preview__mark"
            data-highlight={highlight}
            style={{ left: box.x * scale, top: box.y * scale, width: Math.max(2, box.width * scale), height: Math.max(2, box.height * scale) }}
          />
        ) : null}
      </div>
      <figcaption className="dk-field__hint">{label}</figcaption>
    </figure>
  );
}
