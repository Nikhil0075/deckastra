"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentScene } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";

/**
 * Present mode.
 *
 * Phase 1 covers the parts an audience actually notices: keyboard navigation,
 * fullscreen, a fade between slides, and speaker notes. The presenter view,
 * timer and animation timeline are Phases 6-7.
 *
 * The slide is scaled by a single transform on the root (doc 04 §4.2). Fitting
 * each element to the viewport individually is what produces blurry glyphs and
 * geometry that drifts as the window resizes.
 */

export interface PresentModeProps {
  scene: DocumentScene;
  onExit: () => void;
  initialSlide?: number;
}

const IDLE_MS = 2500;

export function PresentMode({ scene, onExit, initialSlide = 0 }: PresentModeProps) {
  const [index, setIndex] = useState(initialSlide);
  const [idle, setIdle] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hidden slides are skipped in present mode but not in the editor (doc 02 §7.2).
  const slides = useMemo(() => scene.slides, [scene]);
  const slide = slides[index];

  const go = useCallback(
    (delta: number) => {
      setIndex((current) => Math.min(slides.length - 1, Math.max(0, current + delta)));
    },
    [slides.length],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
        case " ":
        case "PageDown":
          event.preventDefault();
          go(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          go(-1);
          break;
        case "Home":
          event.preventDefault();
          setIndex(0);
          break;
        case "End":
          event.preventDefault();
          setIndex(slides.length - 1);
          break;
        case "Escape":
          // Leave fullscreen first if we are in it; the browser also fires its own
          // exit, so onExit is driven by the fullscreenchange handler below.
          if (document.fullscreenElement) void document.exitFullscreen();
          else onExit();
          break;
        case "n":
        case "N":
          setShowNotes((v) => !v);
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
  }, [go, onExit, slides.length]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onExit();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [onExit]);

  // Resize-driven scale. Measured from the container rather than window.innerWidth
  // so the notes panel does not push the slide off-centre.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await containerRef.current?.requestFullscreen?.();
  };

  if (!slide) return null;

  const scale =
    size.width > 0
      ? Math.min(size.width / scene.viewport.width, size.height / scene.viewport.height)
      : 0;

  const transition = slide.transition;
  const durationMs = transition?.type === "cut" ? 0 : (transition?.durationMs ?? 300);

  return (
    <div
      ref={containerRef}
      className={idle ? "present-idle" : undefined}
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
      onClick={(event) => {
        // Click-to-advance, with the left third going back — the convention every
        // remote and every presenter already expects.
        const x = event.clientX / window.innerWidth;
        go(x < 0.33 ? -1 : 1);
      }}
    >
      {scale > 0 ? (
        <div
          key={slide.slideId}
          style={{
            width: scene.viewport.width * scale,
            height: scene.viewport.height * scale,
            position: "relative",
            overflow: "hidden",
            // The slide's own transition describes how the deck moves INTO it, so
            // re-keying on slideId replays it on every arrival (doc 02 §26.1).
            animation: durationMs > 0 ? `deckastra-in ${durationMs}ms ease-out` : undefined,
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
            <SlideView scene={slide} mode="present" />
          </div>
        </div>
      ) : null}

      <style>{`
        @keyframes deckastra-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        /* A presenter who has asked their OS for less motion should not be given
           a fade on every slide (doc 04 §27). */
        @media (prefers-reduced-motion: reduce) {
          @keyframes deckastra-in { from { opacity: 1; } to { opacity: 1; } }
        }
      `}</style>

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
        <button onClick={() => setShowNotes((v) => !v)} style={chipStyle}>
          Notes (N)
        </button>
        <button onClick={onExit} style={chipStyle}>
          Exit (Esc)
        </button>
      </div>

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
