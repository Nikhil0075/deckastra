"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentScene } from "@deckastra/renderer";
import { compileTransition, transitionSlideFromScene } from "@deckastra/animation-engine";
import type { OpenPresenterWindow, PresenterWindow } from "@deckastra/workspace-contracts";

import { fitToDisplay } from "../lib/display-fit";
import { PresentChannel } from "../lib/presentSync";
import { browserPresenterWindow } from "../lib/presenter-window";
import { SlideMotion, type SlideMotionHandle } from "./SlideMotion";
import { SlideTransition } from "./SlideTransition";
import { PresenterView } from "./PresenterView";

/**
 * Present mode.
 *
 * The audience view is deliberately empty of chrome: one slide, scaled by a
 * single transform on the root (doc 04 §4.2). Fitting each element to the
 * viewport individually is what produces blurry glyphs and geometry that drifts
 * as the window resizes.
 *
 * Everything a presenter needs is in the presenter view instead — in this window
 * with `P`, or in a second window over a BroadcastChannel. The second window is
 * the arrangement that matters: a laptop screen and a projector showing
 * different things is the only setup that is any use in a real room.
 */

export interface PresentModeProps {
  scene: DocumentScene;
  onExit: () => void;
  initialSlide?: number;
  /** Renders only the presenter half, for the popped-out window. */
  presenterOnly?: boolean;
  /**
   * How an image becomes something `<img>` can load (`useAssetUrls`).
   *
   * Threaded rather than resolved here, because present mode has a scene and not
   * a document — and the deck it is presenting is the shell's to know about. A
   * deck whose pictures appear while editing and vanish on the projector would be
   * worse than one that never showed them.
   */
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** Shared channel name so the two windows find each other. */
  channelName?: string;
  /**
   * How the presenter view gets its own window.
   *
   * Defaults to `window.open`, which is right in a browser tab and wrong in a
   * packaged app: the desktop shell opens a real second window it can place on a
   * second display. Injected rather than branched on so this component never has
   * to know which shell it is mounted in.
   */
  openPresenter?: OpenPresenterWindow;
}

const IDLE_MS = 2500;

export function PresentMode({
  scene,
  onExit,
  resolveAssetUrl,
  initialSlide = 0,
  presenterOnly = false,
  channelName,
  openPresenter = browserPresenterWindow,
}: PresentModeProps) {
  const [index, setIndex] = useState(initialSlide);
  const [idle, setIdle] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [presenter, setPresenter] = useState(presenterOnly);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  // Doc 04 §26.3's `B`. One of the two keys every presenter reaches for, and the
  // one that has to work when something goes wrong on the laptop.
  const [blacked, setBlacked] = useState(false);
  // Whether the slide was entered forwards. Backwards means its final state,
  // never a replayed entrance (§26.3).
  const [enteredBackwards, setEnteredBackwards] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channel = useRef<PresentChannel | null>(null);
  // Read by the channel's handlers, which outlive any one render.
  const indexRef = useRef(initialSlide);
  const slideCountRef = useRef(scene.slides.length);
  const popout = useRef<PresenterWindow | null>(null);
  const motion = useRef<SlideMotionHandle>(null);
  const startedAt = useRef(Date.now());

  const slides = scene.slides;
  const slide = slides[index];

  // The slide being left, kept only while its successor is arriving. A morph
  // animates an element from where it was to where it now is, and where it was
  // is on this slide — so it has to still be mounted, which the old CSS-keyframe
  // arrangement never allowed for.
  const [leaving, setLeaving] = useState<number | null>(null);
  const previousIndex = useRef(initialSlide);

  indexRef.current = index;
  slideCountRef.current = scene.slides.length;

  const setIndexSynced = useCallback((next: number | ((current: number) => number)) => {
    setIndex((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      channel.current?.post(resolved);
      return resolved;
    });
  }, []);

  const go = useCallback(
    (delta: number) => {
      setEnteredBackwards(delta < 0);
      setIndexSynced((current) => Math.min(slides.length - 1, Math.max(0, current + delta)));
    },
    [setIndexSynced, slides.length],
  );

  /**
   * `→` and `←`: a segment if there is one, otherwise a slide (doc 04 §26.3).
   *
   * The order is the whole of click-to-reveal. A presenter pressing `→` means
   * "show me the next thing", and whether that thing is the next bullet or the
   * next slide is not something they should have to think about.
   */
  const advance = useCallback(
    (delta: number) => {
      const stepped = delta > 0 ? motion.current?.next() : motion.current?.previous();
      if (stepped) return;
      go(delta);
    },
    [go],
  );

  // ------------------------------------------------------------ preferences

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // ---------------------------------------------------------------- syncing

  useEffect(() => {
    if (!channelName) return;

    // Reads position and length through refs so the channel is opened once for
    // the whole talk: reopening it on every slide change would drop messages.
    const bus = new PresentChannel(channelName, {
      // Applied, never re-broadcast — two windows echoing each other never settle.
      onIndex: setIndex,
      currentIndex: () => indexRef.current,
      slideCount: () => slideCountRef.current,
    });

    bus.open();
    channel.current = bus;

    return () => {
      bus.close();
      channel.current = null;
    };
  }, [channelName]);

  const openPresenterWindow = useCallback(() => {
    if (!channelName) return;
    popout.current = openPresenter({ channelName });
    // Hand the new window the current position immediately; its own "hello"
    // covers the case where this message arrives before it is listening.
    channel.current?.post(index);
  }, [channelName, index, openPresenter]);

  // --------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowRight":
        case " ":
        case "PageDown":
          event.preventDefault();
          advance(1);
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          advance(-1);
          break;
        // Down and up skip segments entirely (§26.3): the escape hatch for a
        // presenter who needs to get off this slide now.
        case "ArrowDown":
          event.preventDefault();
          go(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          go(-1);
          break;
        case "b":
        case "B":
          event.preventDefault();
          setBlacked((value) => !value);
          break;
        case "Home":
          event.preventDefault();
          setIndexSynced(0);
          break;
        case "End":
          event.preventDefault();
          setIndexSynced(slides.length - 1);
          break;
        case "Escape":
          if (document.fullscreenElement) void document.exitFullscreen();
          else onExit();
          break;
        case "n":
        case "N":
          setShowNotes((v) => !v);
          break;
        case "p":
        case "P":
          setPresenter((v) => !v);
          break;
        case "f":
        case "F":
          void toggleFullscreen();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, go, onExit, setIndexSynced, slides.length]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onExit();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [onExit]);

  // Resize-driven scale, measured from the container rather than the window so a
  // panel does not push the slide off-centre.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [presenter]);

  useEffect(() => {
    const wake = () => {
      setIdle(false);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // Kiosk mode: a slide may advance itself (doc 02 §26). Cleared on every slide
  // change so a manual advance does not leave a stale timer running.
  useEffect(() => {
    const autoAdvanceMs = (slide?.transition as { autoAdvanceMs?: number } | undefined)
      ?.autoAdvanceMs;
    if (!autoAdvanceMs || index >= slides.length - 1) return;

    const id = setTimeout(() => go(1), autoAdvanceMs);
    return () => clearTimeout(id);
  }, [go, index, slide, slides.length]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await containerRef.current?.requestFullscreen?.();
  };

  if (!slide) {
    // Reachable only if the deck is empty. Rendering nothing at all would leave
    // a presenter staring at a black screen with no way to tell what went wrong.
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#000",
          display: "grid",
          placeItems: "center",
          color: "rgba(255,255,255,0.6)",
          font: "500 16px ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <p>This deck has no slides to present.</p>
          <button onClick={onExit} style={chipStyle}>
            Exit (Esc)
          </button>
        </div>
      </div>
    );
  }

  if (presenterOnly) {
    return (
      <>
        <PresenterView
          scene={scene}
          index={index}
          resolveAssetUrl={resolveAssetUrl}
          onGo={go}
          onJump={setIndexSynced}
          startedAt={startedAt.current}
          detached
        />
      </>
    );
  }

  // One factor for both axes: the deck is letterboxed into whatever the room's
  // hardware is, never stretched to fill it.
  const { scale } = fitToDisplay(scene.viewport, size);

  // Track which slide we came from, so the arriving one can transition out of it.
  // Recorded during render rather than in an effect: the effect would run after
  // the first painted frame of the new slide, which is one frame of the
  // transition already missed.
  if (previousIndex.current !== index) {
    setLeaving(previousIndex.current);
    previousIndex.current = index;
  }

  // Compiled here rather than inside the stage: this component shows what was
  // degraded, and two compiles of one transition is two answers that can
  // disagree. Backwards is the slide's final state and no transition (§26.3).
  const outgoing = leaving !== null && !enteredBackwards ? slides[leaving] : undefined;
  const transition = useMemo(
    () =>
      compileTransition(
        slide.transition,
        outgoing ? transitionSlideFromScene(outgoing) : undefined,
        transitionSlideFromScene(slide),
        { motion: reducedMotion ? "reduced" : "full" },
      ),
    [slide, outgoing, reducedMotion],
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "#000" }}
      // Which slide is on screen, readable from outside the React tree. The
      // acceptance harness drives present mode through real key events and had
      // no way to check where it had arrived: two ArrowRights were assumed to
      // reach slide 4 and actually spent themselves on slide 2's click reveals,
      // so a morph gate ran against a slide with no morph on it. A harness that
      // cannot say which slide it is looking at is a harness making a claim
      // about a slide it never saw.
      data-present-slide-id={slide.slideId}
      data-present-slide-index={index}
      data-present-slide-count={slides.length}
      // How the deck moved *into* this slide, which is the thing a transition
      // gate is actually about. Without it a harness can only guess which
      // boundary it is standing on.
      data-present-slide-transition={slide.transition?.type ?? "none"}
    >
      <div
        ref={containerRef}
        className={idle ? "present-idle" : undefined}
        style={{
          position: "absolute",
          inset: 0,
          // The presenter panel takes the bottom half in-window; the audience
          // half stays a plain scaled slide so what is projected never changes.
          bottom: presenter ? "50%" : 0,
          background: "#000",
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
        }}
        onClick={(event) => {
          // Click-to-advance, left third goes back — the convention every remote
          // and every presenter already expects.
          const x = event.clientX / window.innerWidth;
          advance(x < 0.33 ? -1 : 1);
        }}
      >
        {scale > 0 ? (
          <SlideTransition
            // A slide's transition describes how the deck moves INTO it, so
            // re-keying on slideId replays it on every arrival (doc 02 §26.1).
            key={slide.slideId}
            compiled={transition}
            to={slide}
            from={outgoing}
            width={scene.viewport.width * scale}
            height={scene.viewport.height * scale}
            scale={scale}
            onDone={() => setLeaving(null)}
            resolveAssetUrl={resolveAssetUrl}
          />
        ) : null}

        {/* Re-keyed on the slide so each arrival compiles and plays its own
            timeline; the key is what makes leaving a slide tear its motion down. */}
        <SlideMotion
          // Distinct from the stage div's key: they are siblings, and React
          // treats two siblings with the same key as one element.
          key={`motion-${slide.slideId}`}
          scene={slide}
          rootSelector="[data-present-stage]"
          reducedMotion={reducedMotion}
          autoPlay={!enteredBackwards}
          handle={motion}
        />

        {blacked ? (
          <div
            aria-label="Screen blacked out"
            style={{ position: "absolute", inset: 0, background: "#000", zIndex: 20 }}
          />
        ) : null}

        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            gap: 12,
            alignItems: "center",
            opacity: idle ? 0 : 1,
            transition: "opacity 200ms",
            pointerEvents: idle ? "none" : "auto",
            fontSize: 13,
            color: "rgba(255,255,255,0.65)",
            flexWrap: "wrap",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => go(-1)} disabled={index === 0} style={chipStyle}>
            ←
          </button>
          <span style={{ minWidth: 64, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {index + 1} / {slides.length}
          </span>
          <button onClick={() => go(1)} disabled={index === slides.length - 1} style={chipStyle}>
            →
          </button>
          <button onClick={() => void toggleFullscreen()} style={chipStyle}>
            Fullscreen (F)
          </button>
          <button onClick={() => setPresenter((v) => !v)} style={chipStyle}>
            Presenter (P)
          </button>
          {channelName ? (
            <button onClick={openPresenterWindow} style={chipStyle}>
              Second screen
            </button>
          ) : null}
          <button onClick={() => setShowNotes((v) => !v)} style={chipStyle}>
            Notes (N)
          </button>
          <button onClick={onExit} style={chipStyle}>
            Exit (Esc)
          </button>
        </div>

        {transition.degraded && !idle ? (
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              fontSize: 12,
              color: "rgba(255,255,255,0.5)",
              background: "rgba(0,0,0,0.5)",
              padding: "4px 10px",
              borderRadius: 6,
            }}
          >
            {transition.degraded}
          </div>
        ) : null}

        {showNotes && slide.speakerNotes ? (
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "absolute",
              left: 24,
              right: 24,
              bottom: 64,
              maxHeight: "28vh",
              overflowY: "auto",
              padding: "16px 20px",
              background: "rgba(10,12,16,0.92)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 12,
              fontSize: 16,
              lineHeight: 1.5,
              color: "rgba(255,255,255,0.88)",
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.5, opacity: 0.5, marginBottom: 8 }}>
              SPEAKER NOTES
            </div>
            {slide.speakerNotes}
          </div>
        ) : null}
      </div>

      {presenter ? (
        <div style={{ position: "absolute", inset: "50% 0 0 0", borderTop: "1px solid #23262e" }}>
          <PresenterView
            scene={scene}
            index={index}
            resolveAssetUrl={resolveAssetUrl}
            onGo={go}
            onJump={setIndexSynced}
            startedAt={startedAt.current}
            onExit={onExit}
          />
        </div>
      ) : null}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.16)",
  color: "inherit",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 13,
};
