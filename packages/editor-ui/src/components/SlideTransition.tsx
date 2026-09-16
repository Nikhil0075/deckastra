"use client";

import { useEffect, useRef, useState } from "react";
import type { SlideScene } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";
import {
  isTransitionComplete,
  transitionCss,
  type CompiledTransition,
} from "@deckastra/animation-engine";

/**
 * Both slides, while one is arriving (doc 02 §26, doc 04 §27).
 *
 * The previous arrangement could not draw a morph and was never going to: it
 * rendered one slide and put a CSS `animation` on it. A morph needs the outgoing
 * slide *on screen* — an element travels from where it was to where it now is,
 * and where it was is on a slide the old code had already unmounted.
 *
 * So this mounts two stages for the length of the transition and exactly one
 * after it. The cost is one extra slide rendered for a few hundred milliseconds;
 * the alternative is a transition type the schema has carried since v1 that the
 * product cannot draw.
 *
 * Three rules it keeps:
 *
 * - **The engine decides, this draws.** Compiling, pairing and sampling all live
 *   in `@deckastra/animation-engine`; nothing here computes a position, and the
 *   compiled transition arrives as a prop rather than being built here. The
 *   caller needs it too — to show what was degraded — and two compiles of one
 *   transition is two answers that can disagree.
 * - **Sampled per frame, never advanced per frame.** Each frame asks for `t`
 *   from the wall clock and samples. Nothing accumulates, so an interrupted or
 *   backgrounded transition cannot drift, and `seek(t)` means the same thing here
 *   as everywhere else.
 * - **A cut mounts one stage and no loop.** Reduced motion, the first slide and
 *   a zero duration all land there, and none of them should pay for a rAF.
 */

export interface SlideTransitionProps {
  /** Already compiled by the caller, which also reads its warnings. */
  compiled: CompiledTransition;
  /** The slide arriving. */
  to: SlideScene;
  /** The slide being left, or undefined for the first arrival. */
  from?: SlideScene;
  width: number;
  height: number;
  /** Scale from slide space to the stage, applied on the inner surface. */
  scale: number;
  /** Marks the live stage for the motion adapter's element lookup. */
  stageAttribute?: string;
  /** Told when the transition finishes, so the caller can drop the outgoing slide. */
  onDone?: () => void;
}

export function SlideTransition({
  compiled,
  to,
  from,
  width,
  height,
  scale,
  stageAttribute = "data-present-stage",
  onDone,
}: SlideTransitionProps) {
  const [running, setRunning] = useState(compiled.durationMs > 0);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  // Read by the loop, which outlives any one render.
  const plan = useRef(compiled);
  plan.current = compiled;

  // Deliberately *not* keyed on the compiled object's identity. Finishing sets
  // state, which re-renders, which hands a caller that builds its transition
  // inline a fresh object — and an identity-keyed effect would restart the
  // transition it had just completed, for ever. Duration and type are what
  // actually mean "a different transition", and they are stable across a
  // re-render that changed nothing.
  useEffect(() => {
    const transition = plan.current;
    if (transition.durationMs <= 0) {
      done.current?.();
      return;
    }

    let frame = 0;
    const startedAt = performance.now();

    const apply = (now: number) => {
      // From the clock, not from a counter. A frame that arrives late — a
      // backgrounded tab, a slow paint — must land where the wall clock says,
      // not one step further along than the last one.
      const t = now - startedAt;
      const styles = transitionCss(transition, t);

      for (const [targetId, declaration] of Object.entries(styles)) {
        const element =
          targetId === "slide:out"
            ? outgoingRef.current
            : targetId === "slide:in"
              ? incomingRef.current
              : // A paired element lives inside the incoming stage. Scoped to it
                // so the outgoing slide's copy of the same id is left alone —
                // both are mounted right now, and they share element ids.
                incomingRef.current?.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(targetId)}"]`);
        if (!element) continue;
        for (const [property, value] of Object.entries(declaration)) {
          element.style.setProperty(property, value);
        }
      }

      if (isTransitionComplete(transition, t)) {
        setRunning(false);
        done.current?.();
        return;
      }
      frame = requestAnimationFrame(apply);
    };

    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [compiled.durationMs, compiled.type]);

  const stage = (content: React.ReactNode, ref: React.RefObject<HTMLDivElement | null>, live: boolean) => (
    <div
      ref={ref}
      {...(live ? { [stageAttribute]: "" } : {})}
      style={{
        position: "absolute",
        inset: 0,
        // Only the arriving slide takes clicks: the outgoing one is a picture of
        // where the deck was, and clicking it should advance like anything else.
        pointerEvents: live ? undefined : "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {content}
      </div>
    </div>
  );

  return (
    <div style={{ width, height, position: "relative", overflow: "hidden" }}>
      {running && from ? stage(<SlideView scene={from} mode="present" />, outgoingRef, false) : null}
      {stage(<SlideView scene={to} mode="present" />, incomingRef, true)}
    </div>
  );
}
