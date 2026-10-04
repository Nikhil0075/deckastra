"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { NarrationBar, ScheduledSound } from "@deckastra/animation-engine";
import { librarySoundSamples, waveformPeaks } from "@deckastra/renderer";

import { Icon } from "../ui";
import { LaneGrid } from "./TimelineLanes";

/**
 * The Audio lanes under the motion lanes (integration plan 01 §3.6).
 *
 * **Narration** is one bar per line, placed by the compiled schedule: a line
 * starts with its click step, so its bar is not draggable in time — the step
 * decides when it plays, and moving the step is moving the click. A line
 * longer than its step's motion runs past it, and is drawn running past it:
 * that overrun is exactly where a narrated deck waits for the voice.
 *
 * **Sounds** are draggable. A drag writes the sound's `startMs` as an offset
 * from its trigger — the rule a clip follows — so a sound that fires "with every
 * click" moves at every click at once, which is what it is. The canvas lanes'
 * three rules hold here too: pointermove coalesced into a frame, rounding once
 * on release, and a cancelled drag committing nothing.
 */
export interface AudioLanesProps {
  durationMs: number;
  narration: NarrationBar[];
  /** Every occurrence of every sound cue, from the compiled schedule. */
  sounds: (ScheduledSound & { label: string; startMs: number })[];
  /** Script for each cue, for the bar's label and title. */
  scripts: Record<string, string>;
  /** The asset each narration cue plays in the language on show. */
  takes?: Record<string, string>;
  /** Waveforms of recordings and uploaded sounds, by asset id, once decoded. */
  recordedPeaks?: ReadonlyMap<string, number[]>;
  /** The motion ruler's ticks, so the audio rows share its grid. */
  ticks?: readonly number[];
  /** Where the playhead is, drawn through the audio rows as through the lanes. */
  playheadMs?: number;
  onMoveSound: (cueId: string, startMs: number) => void;
}

export function AudioLanes({ durationMs, narration, sounds, scripts, takes = {}, recordedPeaks, ticks = [], playheadMs, onMoveSound }: AudioLanesProps) {
  const [dragging, setDragging] = useState<{ cueId: string; deltaMs: number } | null>(null);
  const latest = useRef<{ cueId: string; deltaMs: number } | null>(null);
  const origin = useRef<{ cueId: string; clientX: number; pixelsPerMs: number; startMs: number } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const scale = durationMs > 0 ? 100 / durationMs : 0;

  const finish = useCallback(
    (commit: boolean) => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      const settled = latest.current;
      const from = origin.current;
      latest.current = null;
      origin.current = null;
      setDragging(null);
      if (!commit || !settled || !from || Math.abs(settled.deltaMs) < 1) return;
      onMoveSound(settled.cueId, Math.max(0, Math.round(from.startMs + settled.deltaMs)));
    },
    [onMoveSound],
  );

  const peaks = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const sound of sounds) {
      if (!("library" in sound.source) || out.has(sound.source.library)) continue;
      const samples = librarySoundSamples(sound.source.library);
      if (samples) out.set(sound.source.library, waveformPeaks(samples, 24));
    }
    return out;
  }, [sounds]);

  if (!narration.length && !sounds.length) return null;

  return (
    <div className="dk-lanes dk-lanes--audio" data-testid="audio-lanes">
      <LaneGrid ticks={ticks} durationMs={durationMs} />
      <div className="dk-lanes__group" aria-hidden>
        Audio
      </div>
      {narration.length ? (
        <div className="dk-lanes__row dk-lanes__row--narration">
          <span className="dk-lanes__label" title="Narration">
            <span className="dk-lanes__name">
              <Icon name="mic" size={14} aria-hidden />
              <span className="dk-lanes__kind">Narration</span>
            </span>
          </span>
          <div className="dk-lanes__track" data-lane-track="">
            {narration.map((bar) => {
              const end = bar.startMs + bar.durationMs;
              const overrun = end > durationMs;
              const script = scripts[bar.cueId] ?? "";
              return (
                <div
                  key={bar.cueId}
                  className={[
                    "dk-lanes__bar",
                    "dk-lanes__bar--narration",
                    bar.missing && "dk-lanes__bar--missing",
                    bar.orphaned && "dk-lanes__bar--conflict",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid="narration-bar"
                  title={`${bar.missing ? "No recording yet · " : ""}${(bar.durationMs / 1000).toFixed(1)}s · ${script}${overrun ? " · plays past the motion; a narrated deck waits for it" : ""}`}
                  style={{ left: `${bar.startMs * scale}%`, width: `${Math.max(1.5, Math.min(100 - bar.startMs * scale, bar.durationMs * scale))}%` }}
                >
                  <span className="dk-lanes__bar-head">
                    <span>{bar.step === 0 ? "Arrival" : `Click ${bar.step}`}</span>
                    <span>{bar.missing ? "—" : `${(bar.durationMs / 1000).toFixed(1)}s`}</span>
                  </span>
                  {(() => {
                    const shape = takes[bar.cueId] ? recordedPeaks?.get(takes[bar.cueId]!) : undefined;
                    return shape ? (
                      <span className="dk-lanes__wave dk-lanes__wave--line" aria-hidden="true" data-testid="narration-wave">
                        {shape.map((peak, i) => (
                          <span key={i} style={{ height: `${Math.max(6, peak * 100)}%` }} />
                        ))}
                      </span>
                    ) : null;
                  })()}
                  <span className="dk-lanes__bar-script" dir="auto">
                    {script || "(empty line)"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {sounds.length ? (
        <div className="dk-lanes__row">
          <span className="dk-lanes__label" title="Sounds">
            <span className="dk-lanes__name">
              <Icon name="sound" size={14} aria-hidden />
              <span className="dk-lanes__kind">Sounds</span>
            </span>
          </span>
          <div className="dk-lanes__track" data-lane-track="">
            {sounds.map((sound, index) => {
              const moved = dragging && dragging.cueId === sound.cueId ? dragging.deltaMs : 0;
              const at = Math.max(0, sound.timelineAtMs + moved);
              const shape =
                "library" in sound.source
                  ? peaks.get(sound.source.library)
                  : "assetId" in sound.source
                    ? recordedPeaks?.get(sound.source.assetId)
                    : undefined;
              return (
                <div
                  key={`${sound.cueId}:${index}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${sound.label}, at ${Math.round(at)} milliseconds; drag to move`}
                  title={`${sound.label} · ${Math.round(at)}ms · drag to move`}
                  className={["dk-lanes__bar", "dk-lanes__bar--sound", moved && "dk-lanes__bar--dragging"].filter(Boolean).join(" ")}
                  data-testid="sound-bar"
                  style={{ left: `${at * scale}%`, width: `${Math.max(1.5, Math.max(120, sound.durationMs) * scale)}%` }}
                  onPointerDown={(event) => {
                    const lane = (event.currentTarget as HTMLElement).closest("[data-lane-track]");
                    const width = lane?.getBoundingClientRect().width ?? 0;
                    if (width <= 0 || durationMs <= 0) return;
                    origin.current = { cueId: sound.cueId, clientX: event.clientX, pixelsPerMs: width / durationMs, startMs: sound.startMs };
                    try {
                      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                    } catch {
                      // Capture is an enhancement; without it a drag may not commit.
                    }
                  }}
                  onPointerMove={(event) => {
                    if (!origin.current) return;
                    pending.current = event.clientX;
                    if (frame.current !== null) return;
                    frame.current = requestAnimationFrame(() => {
                      frame.current = null;
                      const from = origin.current;
                      const x = pending.current;
                      if (!from || x === null) return;
                      latest.current = { cueId: from.cueId, deltaMs: Math.max(-from.startMs, (x - from.clientX) / from.pixelsPerMs) };
                      setDragging(latest.current);
                    });
                  }}
                  onPointerUp={() => finish(true)}
                  onPointerCancel={() => finish(false)}
                  onLostPointerCapture={() => finish(false)}
                >
                  {shape ? (
                    <span className="dk-lanes__wave" aria-hidden="true">
                      {shape.map((peak, i) => (
                        <span key={i} style={{ height: `${Math.max(8, peak * 100)}%` }} />
                      ))}
                    </span>
                  ) : null}
                  {sound.label}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {playheadMs !== undefined && durationMs > 0 ? (
        <div
          aria-hidden
          className="dk-lanes__playhead"
          style={{ left: `calc(var(--dk-lane-gutter) + (100% - var(--dk-lane-gutter)) * ${Math.min(1, Math.max(0, playheadMs / durationMs))})` }}
        />
      ) : null}
    </div>
  );
}
