"use client";

import { useEffect, useState } from "react";
import type { DocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";

/**
 * Presenter view (doc 01 §10, doc 04 §30).
 *
 * The current slide, the next one, the notes, elapsed time and the wall clock —
 * the four things a presenter actually looks at. It runs either as a panel in
 * the same window (P) or in a second window driven over a BroadcastChannel, so
 * a laptop screen and a projector can show different things, which is the
 * only arrangement that is any use in a real room.
 *
 * The elapsed timer counts from when present mode opened and is *not* persisted:
 * it belongs to this run of this talk, not to the document (doc 02 §4.1).
 */

export interface PresenterViewProps {
  scene: DocumentScene;
  index: number;
  onGo: (delta: number) => void;
  onJump: (index: number) => void;
  startedAt: number;
  onExit?: () => void;
  /** Rendered as the audience window's controls when this is the second window. */
  detached?: boolean;
  /** The current and next previews are slides too, and they have pictures. */
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}

function useTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Local time, formatted without Intl so it cannot vary with the runtime's ICU. */
function clockOf(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PresenterView({
  scene,
  index,
  onGo,
  onJump,
  startedAt,
  onExit,
  detached,
  resolveAssetUrl,
}: PresenterViewProps) {
  const now = useTick(1000);
  const slide = scene.slides[index];
  const next = scene.slides[index + 1];

  if (!slide) return null;

  return (
    <div
      style={{
        position: detached ? "fixed" : "absolute",
        inset: 0,
        background: "#07080b",
        color: "rgba(255,255,255,0.9)",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        gap: 16,
        padding: 20,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap" }}>
        <div style={{ fontSize: 34, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
          {elapsed(now - startedAt)}
        </div>
        <div style={{ fontSize: 15, opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
          {clockOf(now)}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 14, opacity: 0.65 }}>
          Slide {index + 1} of {scene.slides.length}
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
          gap: 20,
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
          <Label>Now</Label>
          <div style={{ border: "1px solid #23262e", borderRadius: 10, overflow: "hidden" }}>
            <ScaledSlide scene={slide} width={760} mode="present" resolveAssetUrl={resolveAssetUrl} />
          </div>
          {slide.keyMessage ? (
            <div style={{ fontSize: 15, opacity: 0.75, lineHeight: 1.45 }}>{slide.keyMessage}</div>
          ) : null}
        </div>

        <div
          style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflow: "hidden" }}
        >
          <Label>Next</Label>
          {next ? (
            <button
              onClick={() => onGo(1)}
              style={{
                padding: 0,
                border: "1px solid #23262e",
                borderRadius: 10,
                overflow: "hidden",
                background: "#000",
                lineHeight: 0,
                cursor: "pointer",
              }}
            >
              <ScaledSlide scene={next} width={330} mode="present" resolveAssetUrl={resolveAssetUrl} />
            </button>
          ) : (
            <div style={{ fontSize: 14, opacity: 0.5, padding: "12px 0" }}>End of deck</div>
          )}

          <Label>Notes</Label>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              fontSize: 16,
              lineHeight: 1.55,
              opacity: slide.speakerNotes ? 0.9 : 0.4,
              whiteSpace: "pre-wrap",
            }}
          >
            {slide.speakerNotes ?? "No notes for this slide."}
          </div>
        </div>
      </div>

      <footer style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => onGo(-1)} disabled={index === 0} style={buttonStyle}>
          ← Previous
        </button>
        <button
          onClick={() => onGo(1)}
          disabled={index === scene.slides.length - 1}
          style={buttonStyle}
        >
          Next →
        </button>

        <div style={{ display: "flex", gap: 6, overflowX: "auto", marginLeft: 12, flex: 1 }}>
          {scene.slides.map((s, i) => (
            <button
              key={s.slideId}
              onClick={() => onJump(i)}
              title={s.name ?? `Slide ${i + 1}`}
              style={{
                flex: "0 0 auto",
                width: 26,
                height: 26,
                borderRadius: 6,
                fontSize: 11,
                border: `1px solid ${i === index ? "#4cc2ff" : "#23262e"}`,
                background: i === index ? "rgba(76,194,255,0.15)" : "transparent",
                color: "inherit",
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>

        {onExit ? (
          <button onClick={onExit} style={buttonStyle}>
            Exit
          </button>
        ) : null}
      </footer>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: 1.6, opacity: 0.45, textTransform: "uppercase" }}>
      {children}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.16)",
  color: "inherit",
  borderRadius: 8,
  padding: "8px 14px",
  fontSize: 14,
};
