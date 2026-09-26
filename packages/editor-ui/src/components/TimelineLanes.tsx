"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

export type TimelineGesture =
  | {
      kind: "move" | "trim";
      clipId: string;
      trackId: string;
      /** Where the clip would land, in absolute slide milliseconds. */
      startMs: number;
      durationMs: number;
      /** Whether subsequent clips on the track should follow a trim. */
      ripple: boolean;
    }
  | {
      /** One keyframe, moved along its own clip. */
      kind: "keyframe";
      clipId: string;
      trackId: string;
      property: string;
      /** Which keyframe: its offset before the drag, which is its identity. */
      fromOffset: number;
      /** Where it lands, in milliseconds from the clip's own start. */
      toMs: number;
    };

/** The source keyframes of one clip, for drawing handles on its bar. */
export interface ClipKeyframes {
  clipId: string;
  durationMs: number;
  tracks: { property: string; keyframes: { offset: number; value: unknown }[] }[];
}

export interface TimelineLanesProps {
  view: TimelineView;
  selectedClipId: string | null;
  playheadMs: number;
  onSelect: (clipId: string) => void;
  /** Called once, on pointer-up, with the settled gesture. */
  onCommit: (gesture: TimelineGesture) => void;
  /**
   * Keyframes to draw on the selected clip's bar, when it has been opened.
   *
   * Only the selected one: a timeline showing every keyframe of every clip is a
   * row of dots nobody can aim at, and the author has already said which clip
   * they are working on by selecting it.
   */
  keyframes?: ClipKeyframes | null;
  onScrub?: (timeMs: number) => void;
}

export function TimelineLanes({
  view,
  selectedClipId,
  playheadMs,
  onSelect,
  onCommit,
  onScrub,
  keyframes = null,
}: TimelineLanesProps) {
  const [preview, setPreview] = useState<TimelineGesture | null>(null);
  /**
   * The same gesture, in a ref.
   *
   * State is for drawing; this is for committing. `setPreview` does not apply
   * until React re-renders, so a pointer-up that lands in the same frame as the
   * last move reads a handler still closed over the *previous* value — `null` on
   * a quick drag — and commits nothing. That is not a rare race: a short, fast
   * drag is the common way to nudge a keyframe, and it was silently doing
   * nothing while every unit test passed, because a test flushes a frame before
   * letting go and React has re-rendered by then.
   */
  const latest = useRef<TimelineGesture | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  // What the gesture started from. Held in a ref because the pointer handlers
  // outlive any one render and must not read a stale closure.
  const origin = useRef<{
    kind: "move" | "trim" | "keyframe";
    clipId: string;
    trackId: string;
    startMs: number;
    durationMs: number;
    clientX: number;
    pixelsPerMs: number;
    /** Set for a keyframe drag only. */
    property?: string;
    fromOffset?: number;
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

    if (from.kind === "keyframe") {
      const startedAtMs = (from.fromOffset ?? 0) * from.durationMs;
      latest.current = {
        kind: "keyframe",
        clipId: from.clipId,
        trackId: from.trackId,
        property: from.property!,
        fromOffset: from.fromOffset!,
        // Clamped to the clip: a keyframe outside its own clip is not an
        // earlier keyframe, it is an offset the schema refuses.
        toMs: Math.min(from.durationMs, Math.max(0, startedAtMs + deltaMs)),
      };
      setPreview(latest.current);
      return;
    }

    if (from.kind === "move") {
      latest.current = {
        kind: "move",
        clipId: from.clipId,
        trackId: from.trackId,
        // Not rounded here. A drag reads its own preview back on the next frame,
        // and rounding each one walks the clip off the pointer.
        startMs: Math.max(0, from.startMs + deltaMs),
        durationMs: from.durationMs,
        ripple: false,
      };
      setPreview(latest.current);
      return;
    }

    latest.current = {
      kind: "trim",
      clipId: from.clipId,
      trackId: from.trackId,
      startMs: from.startMs,
      durationMs: Math.max(MIN_CLIP_MS, from.durationMs + deltaMs),
      ripple: rippling.current,
    };
    setPreview(latest.current);
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
      const settled = latest.current;
      latest.current = null;
      origin.current = null;
      setPreview(null);

      // Rounded exactly once, here. Anything that moved less than a millisecond
      // is a click that wobbled, not a drag, and committing it would put a
      // pointless entry in the history.
      if (!commit || !settled) return;
      onCommit(
        settled.kind === "keyframe"
          ? { ...settled, toMs: Math.round(settled.toMs) }
          : {
              ...settled,
              startMs: Math.round(settled.startMs),
              durationMs: Math.round(settled.durationMs),
            },
      );
    },
    // No dependency on the preview *state*: reading it here is what made a quick
    // drag commit nothing.
    [onCommit],
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

  /**
   * Start dragging one keyframe.
   *
   * The handles live in a layer over the bars rather than inside them, so this
   * cannot start a clip drag by accident and needs no propagation games. The
   * width comes from the *lane*, same as a clip drag, so a millisecond is the
   * same distance whichever of the two is being moved — anything else makes the
   * finer gesture the coarser one.
   */
  const beginKeyframe = (
    event: React.PointerEvent,
    bar: TimelineView["lanes"][number]["bars"][number],
    property: string,
    offset: number,
    durationMs: number,
  ) => {
    const lane = (event.currentTarget as HTMLElement).closest("[data-lane-track]");
    const width = lane?.getBoundingClientRect().width ?? 0;
    if (width <= 0 || view.durationMs <= 0) return;

    origin.current = {
      kind: "keyframe",
      clipId: bar.clipId,
      trackId: bar.trackId,
      startMs: bar.startMs,
      durationMs,
      clientX: event.clientX,
      pixelsPerMs: width / view.durationMs,
      property,
      fromOffset: offset,
    };
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Same reasoning as a clip drag: capture is an enhancement.
    }
    onSelect(bar.clipId);
  };

  const scale = view.durationMs > 0 ? 100 / view.durationMs : 0;

  return (
    <div className="dk-lanes" ref={surface}>
      {view.lanes.map((lane) => (
        <div key={lane.targetId} className="dk-lanes__row">
          <span className="dk-lanes__label" title={lane.label}>
            {lane.label}
          </span>
          <div className="dk-lanes__track" data-lane-track="">
            {lane.bars.map((bar) => {
              // Only a clip gesture moves the bar. A keyframe drag happens
              // *inside* it, and letting it reposition the bar would slide the
              // whole clip under the handle the author is aiming at.
              const dragged =
                preview && preview.clipId === bar.clipId && preview.kind !== "keyframe"
                  ? preview
                  : null;
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
                  className={[
                    "dk-lanes__bar",
                    bar.clipId === selectedClipId && "dk-lanes__bar--selected",
                    // Doc 04 §25.3: an overlap is striped, never blended.
                    bar.conflicted && "dk-lanes__bar--conflict",
                    dragged && "dk-lanes__bar--dragging",
                    dragged?.kind === "trim" && "dk-lanes__bar--trimming",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    left: `${startMs * scale}%`,
                    width: `${Math.max(1.5, durationMs * scale)}%`,
                  }}
                >
                  {bar.label}
                  <span aria-hidden className="dk-lanes__trim" />

                </div>
              );
            })}
            {/*
              A layer over the bars, not inside them.
              -------------------------------------
              The bar clips its own content (`overflow: hidden`) so a long label
              does not spill into the next clip — which also clipped the handles
              at offset 0 and 1, the two an author reaches for most, and made
              them unhittable rather than merely half-drawn. As siblings they are
              also outside the bar's own gesture, so a keyframe drag needs no
              propagation games to avoid starting a clip drag.
            */}
            {keyframes
              ? lane.bars
                  .filter((bar) => bar.clipId === keyframes.clipId)
                  .map((bar) => (
                    <div
                      key={`kf-${bar.clipId}`}
                      className="dk-lanes__keyframes"
                      style={{
                        left: `${bar.startMs * scale}%`,
                        width: `${Math.max(1.5, (bar.endMs - bar.startMs) * scale)}%`,
                      }}
                    >
                      {keyframes.tracks.flatMap((track) =>
                        track.keyframes.map((frame) => {
                          const held =
                            preview?.kind === "keyframe" &&
                            preview.property === track.property &&
                            preview.fromOffset === frame.offset;
                          const at = held
                            ? preview.toMs / Math.max(1, keyframes.durationMs)
                            : frame.offset;

                          return (
                            <span
                              key={`${track.property}:${frame.offset}`}
                              role="slider"
                              tabIndex={0}
                              aria-label={`${track.property} keyframe at ${Math.round(frame.offset * keyframes.durationMs)} milliseconds`}
                              aria-valuenow={Math.round(at * keyframes.durationMs)}
                              aria-valuemin={0}
                              aria-valuemax={Math.round(keyframes.durationMs)}
                              title={`${track.property} · ${Math.round(at * keyframes.durationMs)}ms · drag to move`}
                              onPointerDown={(event) =>
                                beginKeyframe(event, bar, track.property, frame.offset, keyframes.durationMs)
                              }
                              onPointerMove={onPointerMove}
                              onPointerUp={() => finish(true)}
                              onPointerCancel={() => finish(false)}
                              onLostPointerCapture={() => finish(false)}
                              className="dk-lanes__handle"
                              style={{ left: `calc(${at * 100}% - 3px)` }}
                            />
                          );
                        }),
                      )}
                    </div>
                  ))
              : null}
          </div>
        </div>
      ))}

      {preview ? (
        <p aria-live="polite" className="dk-lanes__readout">
          {preview.kind === "keyframe"
            ? `${preview.property} keyframe at ${Math.round(preview.toMs)}ms`
            : preview.kind === "move"
              ? `Start ${Math.round(preview.startMs)}ms`
              : `Length ${Math.round(preview.durationMs)}ms`}
          {preview.kind !== "keyframe" && preview.ripple ? " · later clips follow" : ""}
        </p>
      ) : null}

      {/* The playhead, drawn over the lanes rather than in them. */}
      <div
        aria-hidden
        onPointerDown={(event) => {
          const box = surface.current?.getBoundingClientRect();
          if (box && onScrub) onScrub(((event.clientX - box.left) / box.width) * view.durationMs);
        }}
        className="dk-lanes__playhead"
        // A length times a number, never a length times a length: the old
        // `P% * 0.01 * (100% - 96px)` was invalid CSS, so the browser dropped
        // `left` and the playhead sat at the lanes' left edge whatever the time.
        // 96px is the label column (88px + the 8px gap), as in the ruler.
        style={{ left: `calc(96px + (100% - 96px) * ${Math.min(1, Math.max(0, (playheadMs * scale) / 100))})` }}
      />
    </div>
  );
}

