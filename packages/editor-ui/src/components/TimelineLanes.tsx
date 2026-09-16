"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { MIN_CLIP_MS, type TimelineView } from "@deckastra/animation-engine";

/**
 * The lanes, and the gestures on them (doc 04 §25.2).
 *
 * Split out of `MotionPanel` because this is the only part of the panel that is
 * a *drag surface*, and a drag surface has rules the rest of a panel does not.
 * The three it keeps are the canvas's, for the canvas's reasons:
 *
 * - **Pointermove is coalesced into one rAF callback.** Doc 04 §31.2, and the
 *   budget is judged as dropped frames against the display's own cadence rather
 *   than a millisecond figure that is unreachable at 60Hz and far too loose at
 *   144Hz.
 * - **Rounding happens once, on pointer-up.** Rounding each move accumulates
 *   error across a drag, and on a timeline that shows up as a clip that will not
 *   sit on a round number however carefully it is placed.
 * - **A cancelled gesture commits nothing.** Losing capture — a system dialog, a
 *   dragged-out pointer — discards the preview and leaves the document as it
 *   was, rather than writing wherever the pointer happened to be last.
 *
 * The preview itself is local state and the only local state here. Everything
 * committed goes through patch operations, because the timeline is a view of
 * document state and a second way to change a clip would need undo wiring all
 * over again.
 */

/** How close to a bar's edge counts as grabbing the edge rather than the body. */
const EDGE_PX = 8;

export interface TimelineGesture {
  kind: "move" | "trim";
  clipId: string;
  trackId: string;
  /** Where the clip would land, in absolute slide milliseconds. */
  startMs: number;
  durationMs: number;
  /** Whether subsequent clips on the track should follow a trim. */
  ripple: boolean;
}

export interface TimelineLanesProps {
  view: TimelineView;
  selectedClipId: string | null;
  playheadMs: number;
  onSelect: (clipId: string) => void;
  /** Called once, on pointer-up, with the settled gesture. */
  onCommit: (gesture: TimelineGesture) => void;
  onScrub?: (timeMs: number) => void;
}

export function TimelineLanes({
  view,
  selectedClipId,
  playheadMs,
  onSelect,
  onCommit,
  onScrub,
}: TimelineLanesProps) {
  const [preview, setPreview] = useState<TimelineGesture | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  // What the gesture started from. Held in a ref because the pointer handlers
  // outlive any one render and must not read a stale closure.
  const origin = useRef<{
    kind: "move" | "trim";
    clipId: string;
    trackId: string;
    startMs: number;
    durationMs: number;
    clientX: number;
    pixelsPerMs: number;
  } | null>(null);

  const pendingMove = useRef<number | null>(null);
  const moveFrame = useRef<number | null>(null);
  // Read when the preview is built rather than written into it as it arrives:
  // the first pointermove happens before any preview exists, so setting a flag
  // on one would land on nothing. A ref also means Shift pressed — or released —
  // partway through a drag is respected, which is how people actually use it.
  const rippling = useRef(false);

  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  const applyMove = useCallback((clientX: number) => {
    const from = origin.current;
    if (!from) return;

    const deltaMs = (clientX - from.clientX) / from.pixelsPerMs;
    if (from.kind === "move") {
      setPreview({
        kind: "move",
        clipId: from.clipId,
        trackId: from.trackId,
        // Not rounded here. A drag reads its own preview back on the next frame,
        // and rounding each one walks the clip off the pointer.
        startMs: Math.max(0, from.startMs + deltaMs),
        durationMs: from.durationMs,
        ripple: false,
      });
      return;
    }

    setPreview((current) => ({
      kind: "trim",
      clipId: from.clipId,
      trackId: from.trackId,
      startMs: from.startMs,
      durationMs: Math.max(MIN_CLIP_MS, from.durationMs + deltaMs),
      ripple: rippling.current,
    }));
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!origin.current) return;
      // Only the number that matters is kept: the React event must not be read
      // in a later frame.
      pendingMove.current = event.clientX;
      rippling.current = event.shiftKey;

      if (moveFrame.current !== null) return;
      moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = null;
        const latest = pendingMove.current;
        pendingMove.current = null;
        if (latest !== null) applyMove(latest);
      });
    },
    [applyMove],
  );

  const finish = useCallback(
    (commit: boolean) => {
      if (moveFrame.current !== null) {
        cancelAnimationFrame(moveFrame.current);
        moveFrame.current = null;
      }
      pendingMove.current = null;
      const settled = preview;
      origin.current = null;
      setPreview(null);

      // Rounded exactly once, here. Anything that moved less than a millisecond
      // is a click that wobbled, not a drag, and committing it would put a
      // pointless entry in the history.
      if (!commit || !settled) return;
      const rounded: TimelineGesture = {
        ...settled,
        startMs: Math.round(settled.startMs),
        durationMs: Math.round(settled.durationMs),
      };
      onCommit(rounded);
    },
    [onCommit, preview],
  );

  const beginGesture = (
    event: React.PointerEvent,
    bar: TimelineView["lanes"][number]["bars"][number],
  ) => {
    const track = (event.currentTarget as HTMLElement).parentElement;
    const width = track?.getBoundingClientRect().width ?? 0;
    if (width <= 0 || view.durationMs <= 0) return;

    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const kind = event.clientX >= box.right - EDGE_PX ? "trim" : "move";

    origin.current = {
      kind,
      clipId: bar.clipId,
      trackId: bar.trackId,
      startMs: bar.startMs,
      durationMs: bar.endMs - bar.startMs,
      clientX: event.clientX,
      pixelsPerMs: width / view.durationMs,
    };
    rippling.current = event.shiftKey;

    // Capture *after* the gesture exists, and guarded. It keeps events coming
    // when the pointer leaves the bar, which is most of a drag — but it is an
    // enhancement, and an environment that does not implement it (jsdom, some
    // embedded views) should still let someone drag a clip rather than throwing
    // before the gesture has begun.
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Without capture the pointerup may land elsewhere; `onLostPointerCapture`
      // and `onPointerCancel` both discard, so the worst case is a drag that
      // does not commit rather than one that commits something wrong.
    }

    onSelect(bar.clipId);
  };

  const scale = view.durationMs > 0 ? 100 / view.durationMs : 0;

  return (
    <div style={{ position: "relative" }} ref={surface}>
      {view.lanes.map((lane) => (
        <div key={lane.targetId} style={laneRow}>
          <span style={laneLabel} title={lane.label}>
            {lane.label}
          </span>
          <div style={laneTrack}>
            {lane.bars.map((bar) => {
              const dragged = preview?.clipId === bar.clipId ? preview : null;
              const startMs = dragged ? dragged.startMs : bar.startMs;
              const durationMs = dragged ? dragged.durationMs : bar.endMs - bar.startMs;

              return (
                <div
                  key={bar.clipId}
                  role="button"
                  tabIndex={0}
                  aria-label={`${bar.label}, ${Math.round(startMs)} to ${Math.round(startMs + durationMs)} milliseconds`}
                  title={`${bar.label} · ${Math.round(startMs)}–${Math.round(startMs + durationMs)}ms · drag to move, drag the right edge to trim, hold Shift to ripple`}
                  onPointerDown={(event) => beginGesture(event, bar)}
                  // Selection is not left to the drag: a control claiming
                  // `role="button"` has to answer a plain click, whoever or
                  // whatever produced it.
                  onClick={() => onSelect(bar.clipId)}
                  onPointerMove={onPointerMove}
                  onPointerUp={() => finish(true)}
                  // A cancelled gesture writes nothing. Both of these fire where
                  // the pointer is taken away rather than lifted, and treating
                  // them as a commit is how a clip lands somewhere nobody chose.
                  onPointerCancel={() => finish(false)}
                  onLostPointerCapture={() => finish(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(bar.clipId);
                    }
                  }}
                  style={{
                    ...clipBar,
                    left: `${startMs * scale}%`,
                    width: `${Math.max(1.5, durationMs * scale)}%`,
                    background: bar.clipId === selectedClipId ? "var(--accent)" : "var(--surface-alt)",
                    color: bar.clipId === selectedClipId ? "var(--accent-fg)" : "var(--fg-muted)",
                    // Doc 04 §25.3: an overlap is striped, never blended.
                    borderColor: bar.conflicted ? "var(--warning)" : "var(--border)",
                    borderStyle: bar.conflicted ? "dashed" : "solid",
                    cursor: dragged?.kind === "trim" ? "ew-resize" : "grab",
                    opacity: dragged ? 0.85 : 1,
                  }}
                >
                  {bar.label}
                  <span aria-hidden style={trimHandle} />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {preview ? (
        <p aria-live="polite" style={readout}>
          {preview.kind === "move"
            ? `Start ${Math.round(preview.startMs)}ms`
            : `Length ${Math.round(preview.durationMs)}ms`}
          {preview.ripple ? " · later clips follow" : ""}
        </p>
      ) : null}

      {/* The playhead, drawn over the lanes rather than in them. */}
      <div
        aria-hidden
        onPointerDown={(event) => {
          const box = surface.current?.getBoundingClientRect();
          if (box && onScrub) onScrub(((event.clientX - box.left) / box.width) * view.durationMs);
        }}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `calc(96px + ${playheadMs * scale}% * 0.01 * (100% - 96px))`,
          width: 1,
          background: "var(--accent)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

const laneRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, height: 26 };

const laneLabel: CSSProperties = {
  width: 88,
  flex: "0 0 88px",
  fontSize: 11,
  color: "var(--fg-subtle)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const laneTrack: CSSProperties = {
  position: "relative",
  flex: 1,
  height: 20,
  background: "var(--surface)",
  borderRadius: 4,
};

const clipBar: CSSProperties = {
  position: "absolute",
  top: 2,
  height: 16,
  borderWidth: 1,
  borderRadius: 3,
  fontSize: 10,
  lineHeight: "14px",
  padding: "0 4px",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textAlign: "left",
  touchAction: "none",
  userSelect: "none",
};

const trimHandle: CSSProperties = {
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: EDGE_PX,
  cursor: "ew-resize",
};

const readout: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: "var(--fg-subtle)",
  fontVariantNumeric: "tabular-nums",
};
