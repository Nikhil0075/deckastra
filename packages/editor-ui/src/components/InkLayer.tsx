"use client";

import { useEffect, useRef, useState } from "react";

import {
  HIGHLIGHTER_OPACITY,
  INK_COLOR_NAMES,
  INK_COLORS,
  INK_WIDTH,
  addPoint,
  newInkId,
  strokePath,
  strokesAt,
  toSlidePoint,
  type InkPoint,
  type InkStroke,
  type InkTool,
} from "../lib/ink";
import type { LaserPoint } from "../lib/presentSync";
import { Icon, type IconName } from "../ui/icons";
import { cx } from "../ui/cx";

/** How long a laser stays visible after it last moved. */
const LASER_FADE_MS = 1500;

export interface InkLayerProps {
  slideId: string;
  viewport: { width: number; height: number };
  strokes: InkStroke[];
  /** The tool in hand, or null to let pointer events through to the slide. */
  tool: InkTool | null;
  color: string;
  onStroke: (stroke: InkStroke) => void;
  onErase: (strokeId: string) => void;
  /** This window's laser moved, or left the slide. */
  onLaser: (point: LaserPoint | null) => void;
  /** The other window's laser, drawn here too. */
  remoteLaser?: LaserPoint | null;
  testId?: string;
}

/**
 * Ink drawn over the slide (UI audit 2026-10-10, unit 6).
 *
 * The layer is exactly the slide's box: it sits inside the element the slide is
 * drawn in, so a pointer is mapped against the slide and never the window, and
 * the letterbox around a slide on a projector of another shape is outside it by
 * construction. The SVG clips what it draws, and a point outside the box is
 * clamped onto its edge.
 *
 * With no tool in hand it takes no pointer events, so a click still advances the
 * slide. With one, a press is ink and never navigation: it stops the click from
 * reaching the stage behind.
 */
export function InkLayer({ slideId, viewport, strokes, tool, color, onStroke, onErase, onLaser, remoteLaser, testId }: InkLayerProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<InkPoint[] | null>(null);
  const draftRef = useRef<InkPoint[] | null>(null);
  const erased = useRef(new Set<string>());
  const frame = useRef<number | null>(null);
  const [localLaser, setLocalLaser] = useState<InkPoint | null>(null);
  const [laserShown, setLaserShown] = useState(false);
  const laserTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const drawing = tool === "pen" || tool === "highlighter";
  const laserPoint = localLaser ?? (remoteLaser && remoteLaser.slideId === slideId ? ([remoteLaser.x, remoteLaser.y] as InkPoint) : null);

  // A laser fades once it stops moving, here and in the other window.
  useEffect(() => {
    if (!laserPoint) {
      setLaserShown(false);
      return;
    }
    setLaserShown(true);
    if (laserTimer.current) clearTimeout(laserTimer.current);
    laserTimer.current = setTimeout(() => setLaserShown(false), LASER_FADE_MS);
    return () => {
      if (laserTimer.current) clearTimeout(laserTimer.current);
    };
  }, [laserPoint?.[0], laserPoint?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  // Putting the laser down hides it in the other window too.
  useEffect(() => {
    if (tool !== "laser" && localLaser) {
      setLocalLaser(null);
      onLaser(null);
    }
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const pointAt = (event: React.PointerEvent): InkPoint | null => {
    const box = svgRef.current?.getBoundingClientRect();
    return box ? toSlidePoint(event.clientX, event.clientY, box) : null;
  };

  const eraseAt = (point: InkPoint) => {
    for (const id of strokesAt(strokes, point, viewport)) {
      if (erased.current.has(id)) continue;
      erased.current.add(id);
      onErase(id);
    }
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!tool) return;
    event.stopPropagation();
    event.preventDefault();
    const point = pointAt(event);
    if (!point) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not every environment has capture; the gesture still works without it.
    }
    if (drawing) {
      draftRef.current = addPoint([], point);
      setDraft(draftRef.current);
    } else if (tool === "eraser") {
      erased.current = new Set();
      eraseAt(point);
    }
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!tool) return;
    const point = pointAt(event);
    if (!point) return;
    if (tool === "laser") {
      const clamped: InkPoint = [Math.min(1, Math.max(0, point[0])), Math.min(1, Math.max(0, point[1]))];
      setLocalLaser(clamped);
      onLaser({ slideId, x: clamped[0], y: clamped[1] });
      return;
    }
    if (tool === "eraser" && event.buttons & 1) {
      eraseAt(point);
      return;
    }
    if (drawing && draftRef.current) {
      draftRef.current = addPoint(draftRef.current, point);
      // One redraw per frame, however many points the pointer reports.
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          setDraft(draftRef.current);
        });
      }
    }
  };

  const finish = (commit: boolean) => {
    const points = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!commit || !points?.length || (tool !== "pen" && tool !== "highlighter")) return;
    onStroke({ id: newInkId(), slideId, tool, color, width: INK_WIDTH[tool], points });
  };

  const onPointerLeave = () => {
    if (tool === "laser") {
      setLocalLaser(null);
      onLaser(null);
    }
  };

  const draftStroke: InkStroke | null =
    draft && (tool === "pen" || tool === "highlighter")
      ? { id: "draft", slideId, tool, color, width: INK_WIDTH[tool], points: draft }
      : null;

  return (
    <svg
      ref={svgRef}
      className={cx("dk-ink", tool && "dk-ink--active", tool && `dk-ink--${tool}`)}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      preserveAspectRatio="none"
      data-testid={testId}
      data-ink-count={strokes.length}
      data-ink-tool={tool ?? ""}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onPointerLeave={onPointerLeave}
      // A press is ink, never navigation: the stage behind advances on click.
      onClick={(event) => {
        if (tool) event.stopPropagation();
      }}
    >
      {strokes.map((stroke) => (
        <StrokePath key={stroke.id} stroke={stroke} viewport={viewport} />
      ))}
      {draftStroke ? <StrokePath stroke={draftStroke} viewport={viewport} /> : null}
      {laserPoint && laserShown ? (
        <g className="dk-ink__laser" data-ink-laser="">
          <circle cx={laserPoint[0] * viewport.width} cy={laserPoint[1] * viewport.height} r={26} className="dk-ink__laser-glow" />
          <circle cx={laserPoint[0] * viewport.width} cy={laserPoint[1] * viewport.height} r={9} className="dk-ink__laser-dot" />
        </g>
      ) : null}
    </svg>
  );
}

function StrokePath({ stroke, viewport }: { stroke: InkStroke; viewport: { width: number; height: number } }) {
  return (
    <path
      d={strokePath(stroke, viewport)}
      fill="none"
      stroke={stroke.color}
      strokeWidth={stroke.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={stroke.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1}
      data-ink-stroke={stroke.id}
    />
  );
}

export interface InkToolbarProps {
  tool: InkTool | null;
  onTool: (tool: InkTool | null) => void;
  color: string;
  onColor: (color: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  hasInk: boolean;
  /** Offered only where the whole talk's ink is held: the projector's window. */
  onSave?: () => void;
  saving?: boolean;
  /** Visual variant: the dark cluster over the slide, or the presenter view's light bar. */
  tone?: "dark" | "light";
}

const TOOLS: Array<{ tool: InkTool; icon: IconName; label: string; key: string }> = [
  { tool: "laser", icon: "laser", label: "Laser", key: "K" },
  { tool: "pen", icon: "pen", label: "Pen", key: "E" },
  { tool: "highlighter", icon: "highlighter", label: "Highlighter", key: "H" },
  { tool: "eraser", icon: "eraser", label: "Eraser", key: "X" },
];

/** The tools, one colour row while a drawing tool is in hand, and undo, redo and clear. */
export function InkToolbar({ tool, onTool, color, onColor, canUndo, canRedo, onUndo, onRedo, onClear, hasInk, onSave, saving, tone = "dark" }: InkToolbarProps) {
  return (
    <div className={cx("dk-inkbar", `dk-inkbar--${tone}`)} role="toolbar" aria-label="Draw on the slide" data-testid="ink-toolbar">
      {TOOLS.map((one) => (
        <button
          key={one.tool}
          type="button"
          className="dk-inkbar__button"
          aria-label={`${one.label} (${one.key})`}
          title={`${one.label} (${one.key})`}
          aria-pressed={tool === one.tool}
          data-testid={`ink-tool-${one.tool}`}
          onClick={() => onTool(tool === one.tool ? null : one.tool)}
        >
          <Icon name={one.icon} size={14} />
        </button>
      ))}
      {tool === "pen" || tool === "highlighter" ? (
        <span className="dk-inkbar__colors" role="radiogroup" aria-label="Ink colour">
          {INK_COLORS.map((one) => (
            <button
              key={one}
              type="button"
              role="radio"
              aria-checked={color === one}
              aria-label={INK_COLOR_NAMES[one]}
              title={INK_COLOR_NAMES[one]}
              className="dk-inkbar__swatch"
              // A picture of the colour, not chrome: the palette gate keeps colour
              // literals out of the stylesheets, so it is set here.
              style={{ background: one }}
              onClick={() => onColor(one)}
            />
          ))}
        </span>
      ) : null}
      <button type="button" className="dk-inkbar__button" aria-label="Undo ink (Ctrl+Z)" title="Undo ink (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} data-testid="ink-undo">
        <Icon name="undo" size={14} />
      </button>
      <button type="button" className="dk-inkbar__button" aria-label="Redo ink (Ctrl+Y)" title="Redo ink (Ctrl+Y)" disabled={!canRedo} onClick={onRedo} data-testid="ink-redo">
        <Icon name="redo" size={14} />
      </button>
      <button type="button" className="dk-inkbar__button" aria-label="Clear this slide's ink (C)" title="Clear this slide's ink (C)" disabled={!hasInk} onClick={onClear} data-testid="ink-clear">
        <Icon name="trash" size={14} />
      </button>
      {onSave ? (
        <button type="button" className="dk-inkbar__save" onClick={onSave} disabled={saving} data-testid="ink-save">
          {saving ? "Saving…" : "Save annotated copy"}
        </button>
      ) : null}
    </div>
  );
}
