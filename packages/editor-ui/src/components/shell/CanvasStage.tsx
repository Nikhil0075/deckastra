import { useEffect, useRef, useState, type ReactNode } from "react";
import { checkFrameBudget } from "@deckastra/renderer";

import { fitScale, formatZoom, resolveScale, stepZoom, type Zoom } from "../../lib/editor-layout";
import type { EditorApi } from "../../lib/useEditor";
import { Button, IconButton } from "../../ui";
import { cx } from "../../ui/cx";
import { EditorCanvas } from "../EditorCanvas";

type FrameStats = Parameters<typeof checkFrameBudget>[0];

export interface CanvasStageProps {
  editor: EditorApi;
  zoom: Zoom;
  onZoom: (zoom: Zoom) => void;
  overlay?: ReactNode;
}

/**
 * The canvas and its toolbar (Figma: `− 46% + FIT` and the frame readout).
 *
 * The stage is measured with a `ResizeObserver`. It used to be measured in a ref
 * callback during render, which set state from inside render and re-measured
 * only when React happened to re-run the callback — so a window resized without
 * any other change kept the old width.
 */
export function CanvasStage({ editor, zoom, onZoom, overlay }: CanvasStageProps) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);
  // Last drag's frame times. Shown rather than logged: doc 04 §31.5 is explicit
  // that an untracked budget regresses quietly, and this is the smallest thing
  // that makes the drag budget observable.
  const [frames, setFrames] = useState<{ stats: FrameStats; verdict: ReturnType<typeof checkFrameBudget> }>();

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => setAvailable({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const viewport = editor.document.viewport;
  const fit = available ? fitScale(available, viewport) : 0.4;
  const scale = resolveScale(zoom, fit);
  const width = Math.round(viewport.width * scale);

  return (
    <div className="dk-stage-wrap">
      <div className="dk-canvasbar" role="toolbar" aria-label="Canvas">
        <span className="dk-canvasbar__zoom">
          <IconButton icon="minus" label="Zoom out" size="sm" onClick={() => onZoom(stepZoom(scale, -1))} />
          <output className="dk-canvasbar__value" aria-label="Zoom">
            {formatZoom(scale)}
          </output>
          <IconButton icon="plus" label="Zoom in" size="sm" onClick={() => onZoom(stepZoom(scale, 1))} />
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={zoom === "fit"}
            className={cx(zoom === "fit" && "dk-canvasbar__fit--on")}
            onClick={() => onZoom("fit")}
          >
            Fit
          </Button>
        </span>
        {frames ? (
          <span
            className={cx("dk-canvasbar__frames", !frames.verdict.withinBudget && "dk-canvasbar__frames--over")}
            title={`Last drag: ${frames.verdict.summary}. The budget (doc 04 §31.1) is met when the work fits inside frames the compositor was going to paint anyway.`}
          >
            <span>{frames.stats.p95}ms</span>
            <span>{(frames.verdict.dropped * 100).toFixed(1)}% dropped</span>
          </span>
        ) : null}
      </div>

      <div ref={stage} className={cx("dk-stage", zoom !== "fit" && "dk-stage--scroll")}>
        <div className="dk-stage__slide">
          <EditorCanvas
            editor={editor}
            width={width}
            overlay={overlay}
            onFrameStats={(stats) => setFrames({ stats, verdict: checkFrameBudget(stats) })}
          />
        </div>
      </div>
    </div>
  );
}
