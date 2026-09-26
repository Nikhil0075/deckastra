"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SceneNode, SlideScene } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";
import {
  isTransitionComplete,
  transitionCss,
  type CompiledTransition,
} from "@deckastra/animation-engine";

import { SlideMotion } from "./SlideMotion";

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
  /** Both stages need it: a morph shows the outgoing slide's pictures too. */
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /**
   * Hold the transition at this time instead of playing it from the clock —
   * the editor's transition preview (MA-25), which has to show the midpoint and
   * the end exactly as the audience will see them. The same sampling code runs
   * either way; only where `t` comes from differs.
   */
  timeMs?: number;
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
  resolveAssetUrl,
  timeMs,
}: SlideTransitionProps) {
  const controlled = timeMs !== undefined;
  const uid = useId();
  const flightRef = useRef<HTMLDivElement>(null);

  // What a morph flies: a copy of each paired element (and everything inside
  // it, for a group) drawn above both slides, while the originals are hidden.
  const flights = useMemo(() => morphFlights(compiled, from, to), [compiled, from, to]);
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
  const paint = (transition: CompiledTransition, t: number) => {
    const styles = transitionCss(transition, t);
    for (const [targetId, declaration] of Object.entries(styles)) {
      const element =
        targetId === "slide:out"
          ? outgoingRef.current
          : targetId === "slide:in"
            ? incomingRef.current
            : // A morph's copies live in the flight layer, never inside a stage:
              // the arriving stage is fading in from nothing, and anything inside
              // it would fade with it — which is how the first morph drew a
              // ghost sliding in over a copy that never moved.
              flightRef.current?.querySelector<HTMLElement>(`[data-morph-target="${escapeAttribute(targetId)}"]`);
      if (!element) continue;
      for (const [property, value] of Object.entries(declaration)) {
        element.style.setProperty(property, value);
      }
    }
  };

  // Controlled: sample at the time given, every time it changes. Before paint,
  // so a scrubbed frame never flashes the previous one.
  const complete = controlled ? compiled.durationMs <= 0 || isTransitionComplete(compiled, timeMs!) : !running;
  const active = !complete && Boolean(from);
  useLayoutEffect(() => {
    if (!controlled) return;
    paint(plan.current, Math.max(0, timeMs!));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, timeMs, compiled, flights]);

  // Played: the first frame is painted before the browser shows anything, or
  // the copies would appear for one frame at their destinations.
  useLayoutEffect(() => {
    if (controlled || compiled.durationMs <= 0) return;
    paint(plan.current, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, flights]);

  // The originals of every flying copy are hidden while the copies fly, and
  // shown again the moment the transition ends. An attribute rather than an
  // inline style, so the motion adapter's own inline styles on the same
  // element are never touched: removing the attribute restores exactly what
  // was there.
  useLayoutEffect(() => {
    if (!active || flights.hidden.length === 0) return;
    const marked: Element[] = [];
    const sides: [HTMLDivElement | null, string[]][] = [
      [outgoingRef.current, flights.hiddenOut],
      [incomingRef.current, flights.hiddenIn],
    ];
    for (const [stageElement, ids] of sides) {
      for (const id of ids) {
        const element = stageElement?.querySelector(`[data-element-id="${escapeAttribute(id)}"]`);
        if (!element) continue;
        element.setAttribute("data-morph-hidden", "");
        marked.push(element);
      }
    }
    return () => {
      for (const element of marked) element.removeAttribute("data-morph-hidden");
    };
  }, [active, flights]);

  useEffect(() => {
    if (controlled) return;
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
      paint(transition, t);

      if (isTransitionComplete(transition, t)) {
        setRunning(false);
        done.current?.();
        return;
      }
      frame = requestAnimationFrame(apply);
    };

    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled.durationMs, compiled.type, controlled]);

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

  const fromMotion = (from?.animations?.length ?? 0) > 0;

  return (
    <div style={{ width, height, position: "relative", overflow: "hidden" }}>
      {flights.hidden.length > 0 ? <style>{"[data-morph-hidden]{visibility:hidden !important}"}</style> : null}
      {active && from ? (
        <div data-transition-out={uid} style={{ position: "absolute", inset: 0 }}>
          {stage(<SlideView scene={from} mode="present" resolveAssetUrl={resolveAssetUrl} />, outgoingRef, false)}
        </div>
      ) : null}
      {stage(
        <SlideView scene={to} mode="present" resolveAssetUrl={resolveAssetUrl} />,
        incomingRef,
        true,
      )}
      {active && flights.copies.length > 0 ? (
        <div
          ref={flightRef}
          data-morph-flight=""
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: to.width,
              height: to.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            {(["out", "in"] as const).map((side) => (
              <div key={side} data-morph-side={`${uid}:${side}`} style={{ position: "absolute", inset: 0 }}>
                {flights.copies
                  .filter((copy) => copy.side === side)
                  .map((copy) => (
                    <div
                      key={copy.target}
                      data-morph-target={copy.target}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: copy.scene.width,
                        height: copy.scene.height,
                        // The engine's longhands compose about the slide origin,
                        // exactly as the renderer places the element itself.
                        transformOrigin: "0 0",
                        willChange: "translate, scale, opacity",
                      }}
                    >
                      <SlideView scene={copy.scene} mode="present" resolveAssetUrl={resolveAssetUrl} />
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {/* The slide being left is shown as the audience last saw it — every
          entrance played — not as its resting document, where an element
          authored to fade in rests invisible and would vanish the instant the
          transition began. The same for the copies of it that fly. */}
      {active && from && fromMotion ? (
        <>
          <SlideMotion
            key={`out-${from.slideId}`}
            scene={from}
            rootSelector={`[data-transition-out="${uid}"]`}
            reducedMotion={false}
            autoPlay={false}
          />
          {flights.copies.some((copy) => copy.side === "out") ? (
            <SlideMotion
              key={`fly-${from.slideId}`}
              scene={from}
              rootSelector={`[data-morph-side="${uid}:out"]`}
              reducedMotion={false}
              autoPlay={false}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface MorphCopy {
  target: string;
  side: "in" | "out";
  scene: SlideScene;
}

/**
 * The copies a morph flies, and the originals they stand in for.
 *
 * Each copy is its own small scene — the paired node and its descendants, with
 * no background — drawn by the ordinary `SlideView`, so a copy is pixel for
 * pixel the element the audience was looking at. Every element is emitted with
 * its whole world transform from the slide origin, so the copy's wrapper can
 * move and scale a group and everything in it as one rigid object. Leaving
 * copies are drawn beneath arriving ones, each side in its slide's paint order.
 */
function morphFlights(compiled: CompiledTransition, from: SlideScene | undefined, to: SlideScene) {
  const copies: MorphCopy[] = [];
  const hiddenIn: string[] = [];
  const hiddenOut: string[] = [];
  if (!from) return { copies, hiddenIn, hiddenOut, hidden: [] as string[] };

  const targets = new Set(
    compiled.tracks.filter((track) => track.targetId.startsWith("pair:")).map((track) => track.targetId),
  );
  for (const target of targets) {
    const side = target.startsWith("pair:in:") ? "in" : "out";
    const id = target.slice(side === "in" ? "pair:in:".length : "pair:out:".length);
    const scene = side === "in" ? to : from;
    const node = findNode(scene.nodes, id);
    if (!node) continue;
    const subtree = new Set<string>();
    collect(node, subtree);
    copies.push({
      target,
      side,
      scene: {
        ...scene,
        nodes: [node],
        background: undefined,
        paintOrder: scene.paintOrder.filter((nodeId) => subtree.has(nodeId)),
      },
    });
    (side === "in" ? hiddenIn : hiddenOut).push(...subtree);
  }

  const inOrder = new Map(to.paintOrder.map((id, index) => [id, index]));
  const outOrder = new Map(from.paintOrder.map((id, index) => [id, index]));
  const rank = (copy: MorphCopy) => (copy.side === "in" ? inOrder : outOrder).get(copy.scene.nodes[0]!.id) ?? 0;
  copies.sort((a, b) => rank(a) - rank(b));

  return { copies, hiddenIn, hiddenOut, hidden: [...hiddenIn, ...hiddenOut] };
}

function findNode(nodes: readonly SceneNode[], id: string): SceneNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children ? findNode(node.children, id) : undefined;
    if (found) return found;
  }
  return undefined;
}

function collect(node: SceneNode, into: Set<string>): void {
  into.add(node.id);
  for (const child of node.children ?? []) collect(child, into);
}

/** `CSS.escape` where the environment has it; element ids are ULIDs, so quoting is enough elsewhere. */
function escapeAttribute(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
