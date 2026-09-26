"use client";

import { useChromeTheme } from "../lib/chrome-theme";
import { useEffect, useRef, useState } from "react";
import type { DocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";

import { fitToDisplay } from "../lib/display-fit";
import { clockOf, formatTimer, remaining, stepLabel } from "../lib/presenter";
import { Button, NumberField } from "../ui";
import { RichNotes } from "./RichNotes";
import { cx } from "../ui/cx";

/**
 * Presenter view (doc 01 §10, doc 04 §30; Figma: "present mode with notes").
 *
 * What a presenter actually looks at: the time, the slide on the projector and
 * which reveal it is on, the next slide, the notes, and how much of the slot is
 * left. It runs either as a panel in the same window (P) or in a second window
 * driven over a BroadcastChannel, so a laptop screen and a projector can show
 * different things — the only arrangement that is any use in a real room.
 *
 * Next and Previous here are *advances*, not slide jumps: they reveal the next
 * bullet on the projector before they change slide, exactly as → does. The
 * numbered squares are the jump.
 *
 * Elapsed time and the target are session state, never the document's (doc 02
 * §4.1): they belong to this run of this talk.
 */

export interface PresenterViewProps {
  scene: DocumentScene;
  index: number;
  /** Reveals done on this slide, and how many it has. */
  step: number;
  steps: number;
  /** Whether the projector is blacked out. */
  blacked: boolean;
  onAdvance: (delta: 1 | -1) => void;
  onJump: (index: number) => void;
  onBlack: () => void;
  startedAt: number;
  onExit?: () => void;
  /** The second-window form: fills the window rather than a panel. */
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

/** The size of an element, followed as it resizes. */
function useBoxSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

export function PresenterView({
  scene,
  index,
  step,
  steps,
  blacked,
  onAdvance,
  onJump,
  onBlack,
  startedAt,
  onExit,
  detached,
  resolveAssetUrl,
}: PresenterViewProps) {
  const now = useTick(1000);
  // The presenter view is often its own window, with its own copy of the store;
  // reading it here is what applies the person's chrome theme there too.
  useChromeTheme();
  const slide = scene.slides[index];
  const next = scene.slides[index + 1];
  const [currentBox, currentSize] = useBoxSize<HTMLDivElement>();
  const [nextBox, nextSize] = useBoxSize<HTMLDivElement>();
  // Minutes. Null until a presenter sets one: a countdown against a guessed
  // length is a number that means nothing and looks like it means something.
  const [targetMinutes, setTargetMinutes] = useState<number | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);

  if (!slide) return null;

  const elapsedMs = now - startedAt;
  const left = targetMinutes === null ? null : remaining(targetMinutes * 60_000, elapsedMs);
  const current = fitToDisplay(scene.viewport, currentSize);
  const upcoming = fitToDisplay(scene.viewport, nextSize);
  const label = stepLabel({ step, steps });
  const atStart = index === 0 && step === 0;
  const atEnd = index === scene.slides.length - 1 && step >= steps;

  return (
    <div className={cx("dk-root dk-presenter", detached && "dk-presenter--detached")} data-testid="presenter-view">
      <header className="dk-presenter__bar">
        <span className="dk-presenter__role">Presenter</span>
        <span className="dk-presenter__title">{scene.title}</span>
        <span className="dk-presenter__timer" role="timer" aria-label="Elapsed time">
          {formatTimer(elapsedMs)}
        </span>
        <span className="dk-presenter__clock" aria-label="Time of day">
          {clockOf(now)}
        </span>
        <span className="dk-presenter__position">
          Slide {index + 1} of {scene.slides.length}
        </span>
      </header>

      <main className="dk-presenter__body">
        <section className="dk-presenter__current" aria-label="Current slide">
          <span className="dk-label">Current</span>
          <div ref={currentBox} className="dk-presenter__frame">
            {current.scale > 0 ? (
              <span className="dk-presenter__slide">
                <ScaledSlide
                  scene={slide}
                  width={scene.viewport.width * current.scale}
                  mode="present"
                  resolveAssetUrl={resolveAssetUrl}
                />
              </span>
            ) : null}
            {/* Outside the size gate: whether the room is looking at a black
                screen matters more than the preview, and must show even before
                the preview has been measured. */}
            {blacked ? <span className="dk-presenter__blacked">Screen is black</span> : null}
          </div>

          <div className="dk-presenter__stepbar">
            {label ? (
              <span className="dk-presenter__step" data-testid="presenter-step">
                <span className="dk-presenter__step-text">{label}</span>
                <span className="dk-presenter__squares" aria-hidden="true">
                  {Array.from({ length: steps + 1 }, (_, i) => (
                    <span key={i} className={cx("dk-presenter__square", i <= step && "dk-presenter__square--done")} />
                  ))}
                </span>
              </span>
            ) : (
              <span className="dk-presenter__step dk-presenter__step--none">No click reveals on this slide</span>
            )}
            <span className="dk-presenter__nav">
              <Button onClick={() => onAdvance(-1)} disabled={atStart} data-testid="presenter-prev">
                Prev
              </Button>
              <Button variant="primary" onClick={() => onAdvance(1)} disabled={atEnd} data-testid="presenter-next">
                Next
              </Button>
            </span>
          </div>

          <nav className="dk-presenter__jump" aria-label="Go to slide">
            {scene.slides.map((one, i) => (
              <button
                key={one.slideId}
                type="button"
                className={cx("dk-presenter__jumpto", i === index && "dk-presenter__jumpto--current")}
                aria-current={i === index ? "true" : undefined}
                aria-label={`Go to slide ${i + 1}`}
                title={one.name ?? `Slide ${i + 1}`}
                onClick={() => onJump(i)}
              >
                {i + 1}
              </button>
            ))}
          </nav>
        </section>

        <aside className="dk-presenter__side">
          <section className="dk-presenter__next" aria-label="Next slide">
            <span className="dk-label">Next</span>
            <div ref={nextBox} className="dk-presenter__frame dk-presenter__frame--next">
              {next && upcoming.scale > 0 ? (
                <ScaledSlide
                  scene={next}
                  width={scene.viewport.width * upcoming.scale}
                  mode="present"
                  resolveAssetUrl={resolveAssetUrl}
                />
              ) : next ? null : (
                <span className="dk-presenter__end">End of deck</span>
              )}
            </div>
          </section>

          <section className="dk-presenter__notes" aria-label="Speaker notes">
            <span className="dk-label">Speaker notes</span>
            <div className={cx("dk-presenter__notes-text", !slide.speakerNotes && "dk-presenter__notes-text--empty")}>
              {slide.speakerNotesRich ? (
                <RichNotes notes={slide.speakerNotesRich} />
              ) : (
                (slide.speakerNotes ?? "No notes for this slide.")
              )}
            </div>
          </section>

          <section className="dk-presenter__remaining" aria-label="Time remaining">
            <span className="dk-label">Remaining</span>
            {editingTarget || targetMinutes === null ? (
              <span className="dk-presenter__target">
                <NumberField
                  label="Target"
                  ariaLabel="Target length in minutes"
                  unit="min"
                  value={targetMinutes ?? 20}
                  min={1}
                  max={600}
                  integer
                  onCommit={(value) => {
                    setTargetMinutes(value);
                    setEditingTarget(false);
                  }}
                />
                {targetMinutes === null ? (
                  <Button size="sm" onClick={() => setTargetMinutes(20)}>
                    Set 20 min
                  </Button>
                ) : null}
              </span>
            ) : (
              <button
                type="button"
                className={cx("dk-presenter__left", left?.over && "dk-presenter__left--over")}
                title="Change the target length"
                onClick={() => setEditingTarget(true)}
              >
                {left?.text}
                {left?.over ? <span className="dk-presenter__over"> over</span> : null}
              </button>
            )}
          </section>

          <footer className="dk-presenter__actions">
            {onExit ? (
              <Button onClick={onExit} data-testid="presenter-end">
                End
              </Button>
            ) : null}
            <Button
              variant={blacked ? "primary" : "secondary"}
              aria-pressed={blacked}
              onClick={onBlack}
              data-testid="presenter-black"
            >
              {blacked ? "Show slide" : "Black screen"}
            </Button>
          </footer>
        </aside>
      </main>
    </div>
  );
}
