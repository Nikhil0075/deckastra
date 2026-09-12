"use client";

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import type { PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { newId, walkElements } from "@deckastra/presentation-schema";
import {
  PRESET_NAMES,
  PRESETS,
  buildTimelineView,
  clipPatchOperations,
  compileTimeline,
  type CompiledTimeline,
} from "@deckastra/animation-engine";
import type { SlideScene } from "@deckastra/renderer";

/**
 * The motion panel and timeline (doc 04 §25).
 *
 * The rule this component is built around: **the timeline is a view of document
 * state.** Every control here produces patch operations and hands them to the
 * same `apply` the canvas uses, so a clip drag lands in the same history as a
 * text edit or an AI change and undoes the same way. There is no local timeline
 * state to save, and no way for the timeline and the document to disagree.
 *
 * The budget bar is not decoration either. Doc 04 §24.2's 2.5s entrance ceiling
 * is a number the author has no other way to see: a slide that over-runs looks
 * fine in the editor and only fails in the room, when the presenter is talking
 * over an animation that is still going.
 */

export interface MotionPanelProps {
  document: PresentationDocument;
  scene: SlideScene;
  slideIndex: number;
  selectedIds: string[];
  apply: (operations: unknown[], label: string) => void;
  onScrub?: (timeMs: number) => void;
  onPlay?: () => void;
  playheadMs?: number;
}

export function MotionPanel({
  document: doc,
  scene,
  slideIndex,
  selectedIds,
  apply,
  onScrub,
  onPlay,
  playheadMs = 0,
}: MotionPanelProps) {
  const slide = doc.slides[slideIndex];
  const [selectedClip, setSelectedClip] = useState<string | null>(null);

  const timeline: CompiledTimeline | null = useMemo(() => {
    if (!slide) return null;
    return compileTimeline(scene, slide.animations ?? []);
  }, [scene, slide]);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    if (!slide) return map;
    for (const { element } of walkElements(slide.elements)) {
      map.set(element.id, labelFor(element));
    }
    return map;
  }, [slide]);

  const view = useMemo(
    () => (timeline ? buildTimelineView(timeline, labels) : null),
    [timeline, labels],
  );

  if (!slide || !timeline || !view) return null;

  const clip = timeline.clips.find((one) => one.id === selectedClip);
  const trackIndex = slide.animations?.findIndex(track => track.id === clip?.trackId) ?? -1;
  const sourceClip = slide.animations?.find(track => track.id === clip?.trackId)?.clips.find(item => item.id === clip?.id || clip?.id.startsWith(`${item.id}:`));
  const scale = view.durationMs > 0 ? 100 / view.durationMs : 0;

  function reorderTrack(direction: -1 | 1) {
    if (!slide || !clip || trackIndex < 0) return;
    const destination = trackIndex + direction;
    if (destination < 0 || destination >= (slide.animations?.length ?? 0)) return;
    // Move the whole source track, preserving all clips and future fields.
    // JSON Patch resolves this index after removing the source track.
    apply([{
      op: "move",
      from: `/slides/id:${slide.id}/animations/id:${clip.trackId}`,
      path: `/slides/id:${slide.id}/animations/${destination}`,
    }], direction < 0 ? "Move animation track earlier" : "Move animation track later");
  }

  function addAnimation(preset: string) {
    if (!slide) return;
    // One track per selected element, all on the same trigger, so selecting
    // three things and clicking a preset produces one gesture rather than three
    // unrelated entrances.
    const operations = selectedIds.map((targetId, index) => ({
      op: "add" as const,
      path: `/slides/id:${slide.id}/animations/-`,
      value: {
        id: newId("anm"),
        targetId,
        trigger: index === 0 ? { type: "slideEnter" } : { type: "withPrevious" },
        clips: [
          {
            id: newId("clp"),
            preset,
            startMs: index === 0 ? 0 : index * 90,
            durationMs: 420,
            easing: "emphasized",
          },
        ],
      },
    }));

    apply(operations, `Animate ${selectedIds.length} object(s)`);
  }

  function edit(kind: "preset" | "trim" | "easing" | "delete" | "trigger" | "startMs" | "delayMs" | "duplicate", value: unknown) {
    if (!clip || !slide || !sourceClip) return;

    if (kind === "duplicate") {
      const duplicate = { ...structuredClone(sourceClip), id: newId("clp") };
      apply([{
        op: "add",
        path: `/slides/id:${slide.id}/animations/id:${clip.trackId}/clips/-`,
        value: duplicate,
      }], "Duplicate animation clip");
      setSelectedClip(duplicate.id + clip.id.slice(sourceClip.id.length));
      return;
    }

    if (kind === "trim" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return;

    // Edit stored offsets, not compiled absolute times (which include the
    // trigger and preceding tracks). Optional delay uses add/upsert semantics.
    if (kind === "startMs" || kind === "delayMs") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
      apply([{
        op: "add",
        path: `/slides/id:${slide.id}/animations/id:${clip.trackId}/clips/id:${sourceClip.id}/${kind}`,
        value: Math.round(value),
      }], kind === "startMs" ? "Change animation start" : "Change animation delay");
      return;
    }

    const operations = clipPatchOperations(
      slide.id,
      { ...clip, id: sourceClip.id },
      kind === "preset"
        ? { kind: "preset", preset: value as string }
        : kind === "trim"
          ? { kind: "trim", durationMs: value as number }
          : kind === "easing"
            ? { kind: "easing", easing: value as string }
            : kind === "trigger"
              ? { kind: "trigger", trigger: value as { type: string } }
              : { kind: "delete" },
      // Only a `move` reads this — it turns an absolute drop position back into
      // an offset from the trigger — and this panel has no drag yet. Passing the
      // clip's own start would be wrong for a move and is ignored by every other
      // edit, so zero is the honest value until dragging lands.
      0,
    );

    if (kind === "delete") setSelectedClip(null);
    apply(operations, kind === "delete" ? "Remove animation" : `Change ${kind}`);
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
      <div style={header}>
        <strong style={{ fontSize: 13 }}>Motion</strong>

        <button style={smallButton} onClick={onPlay} disabled={view.durationMs === 0}>
          Preview
        </button>

        <BudgetBar budget={view.budget} />

        <div style={{ flex: 1 }} />

        {selectedIds.length > 0 ? (
          <select
            style={{ ...smallButton, padding: "5px 8px" }}
            value=""
            onChange={(event) => {
              if (event.target.value) addAnimation(event.target.value);
              event.currentTarget.value = "";
            }}
          >
            <option value="">Add animation…</option>
            {PRESET_NAMES.filter((name) => name !== "sharedElementMorph").map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>
            Select something to animate it
          </span>
        )}
      </div>

      {view.lanes.length === 0 ? (
        <p style={{ ...muted, padding: "0 14px 14px" }}>
          Nothing on this slide moves. That is the right default for most slides —
          motion reads as emphasis.
        </p>
      ) : (
        <div style={{ padding: "0 14px 12px" }}>
          <Ruler ticks={view.ticks} durationMs={view.durationMs} segments={view.segments} />

          <div style={{ position: "relative" }}>
            {view.lanes.map((lane) => (
              <div key={lane.targetId} style={laneRow}>
                <span style={laneLabel} title={lane.label}>
                  {lane.label}
                </span>
                <div style={laneTrack}>
                  {lane.bars.map((bar) => (
                    <button
                      key={bar.clipId}
                      onClick={() => setSelectedClip(bar.clipId)}
                      title={`${bar.label} · ${Math.round(bar.startMs)}–${Math.round(bar.endMs)}ms`}
                      style={{
                        ...clipBar,
                        left: `${bar.startMs * scale}%`,
                        width: `${Math.max(1.5, (bar.endMs - bar.startMs) * scale)}%`,
                        background:
                          bar.clipId === selectedClip ? "var(--accent)" : "var(--surface-alt)",
                        color: bar.clipId === selectedClip ? "var(--accent-fg)" : "var(--fg-muted)",
                        // Doc 04 §25.3: an overlap is striped, never blended.
                        // Blending produces a result nobody predicted and no
                        // exporter can reproduce.
                        borderColor: bar.conflicted ? "var(--warning)" : "var(--border)",
                        borderStyle: bar.conflicted ? "dashed" : "solid",
                      }}
                    >
                      {bar.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* The playhead, drawn over the lanes rather than in them. */}
            <div
              aria-hidden
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

          <input
            type="range"
            min={0}
            max={Math.max(1, view.durationMs)}
            value={Math.min(playheadMs, view.durationMs)}
            onChange={(event) => onScrub?.(Number(event.target.value))}
            aria-label="Scrub the slide timeline"
            style={{ width: "100%", marginTop: 10 }}
          />

          {clip ? (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                <span style={muted}>Track {trackIndex + 1} of {slide.animations?.length ?? 0}</span>
                <button style={smallButton} disabled={trackIndex <= 0} onClick={() => reorderTrack(-1)}>
                  Move track earlier
                </button>
                <button style={smallButton} disabled={trackIndex < 0 || trackIndex >= (slide.animations?.length ?? 0) - 1} onClick={() => reorderTrack(1)}>
                  Move track later
                </button>
              </div>
              <ClipInspector clip={clip} durationMs={sourceClip?.durationMs ?? 0} startMs={sourceClip?.startMs ?? 0} delayMs={sourceClip?.delayMs ?? 0} onEdit={edit} />
            </>
          ) : null}

          {view.warnings.length > 0 ? (
            <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none" }}>
              {view.warnings.map((warning) => (
                <li key={warning.code + warning.message} style={{ ...muted, color: "var(--warning)" }}>
                  {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function BudgetBar({ budget }: { budget: CompiledTimeline["budget"] }) {
  const fraction = Math.min(1, budget.entranceMs / Math.max(1, budget.limitMs));

  return (
    <span
      title={
        budget.exceeded
          ? `The entrance runs ${Math.round(budget.entranceMs)}ms, past the ${budget.limitMs}ms budget. The presenter will be talking over it.`
          : `Entrance: ${Math.round(budget.entranceMs)}ms of ${budget.limitMs}ms`
      }
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11 }}
    >
      <span style={{ width: 70, height: 4, background: "var(--surface-alt)", borderRadius: 2 }}>
        <span
          style={{
            display: "block",
            width: `${fraction * 100}%`,
            height: "100%",
            borderRadius: 2,
            background: budget.exceeded ? "var(--warning)" : "var(--accent)",
          }}
        />
      </span>
      <span style={{ color: budget.exceeded ? "var(--warning)" : "var(--fg-subtle)" }}>
        {Math.round(budget.entranceMs)}ms
      </span>
    </span>
  );
}

function Ruler({
  ticks,
  durationMs,
  segments,
}: {
  ticks: number[];
  durationMs: number;
  segments: CompiledTimeline["segments"];
}) {
  const scale = durationMs > 0 ? 100 / durationMs : 0;

  return (
    <div style={{ display: "flex", marginBottom: 6 }}>
      <span style={{ width: 96 }} />
      <div style={{ position: "relative", flex: 1, height: 16 }}>
        {ticks.map((tick) => (
          <span
            key={tick}
            style={{
              position: "absolute",
              left: `${tick * scale}%`,
              fontSize: 10,
              color: "var(--fg-subtle)",
            }}
          >
            {tick / 1000}s
          </span>
        ))}
        {/* Segment boundaries: where playback stops and waits for the presenter.
            Marked because a timeline that does not show them looks like it has an
            unexplained gap. */}
        {segments
          .filter((segment) => segment.advanceOn === "click")
          .map((segment) => (
            <span
              key={segment.index}
              title="Waits for a click"
              style={{
                position: "absolute",
                left: `${segment.startMs * scale}%`,
                top: 0,
                bottom: -4,
                width: 2,
                background: "var(--fg-subtle)",
              }}
            />
          ))}
      </div>
    </div>
  );
}

function ClipInspector({
  clip,
  durationMs,
  startMs,
  delayMs,
  onEdit,
}: {
  clip: CompiledTimeline["clips"][number];
  durationMs: number;
  startMs: number;
  delayMs: number;
  onEdit: (kind: "preset" | "trim" | "easing" | "delete" | "trigger" | "startMs" | "delayMs" | "duplicate", value: unknown) => void;
}) {
  const preset = clip.preset ? PRESETS[clip.preset] : undefined;

  return (
    <div style={inspector}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={clip.preset ?? ""}
          onChange={(event) => onEdit("preset", event.target.value)}
          style={smallButton}
          aria-label="Preset"
        >
          {clip.preset && !PRESETS[clip.preset] ? (
            // A preset this build does not know is kept, not dropped: the schema
            // preserves unknown values and deleting one would delete the
            // author's motion (doc 02 §0.8).
            <option value={clip.preset}>{clip.preset} (unknown)</option>
          ) : null}
          {PRESET_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        {([
          ["startMs", "Start offset (ms)", startMs],
          ["delayMs", "Delay (ms)", delayMs],
        ] as const).map(([field, label, value]) => (
          <label key={field} style={{ ...muted, display: "flex", alignItems: "center", gap: 5 }}>
            <span>{label}</span>
            <input type="number" min={0} step={50} value={value}
              onChange={event => {
                if (event.target.value !== "") onEdit(field, event.target.valueAsNumber);
              }}
              style={{ ...smallButton, width: 76 }} />
          </label>
        ))}

        <label style={{ ...muted, display: "flex", alignItems: "center", gap: 5 }}>
          <span>Duration</span>
          <input
            type="number"
            min={50}
            step={50}
            value={durationMs}
            onChange={(event) => {
              if (event.target.value !== "") onEdit("trim", event.target.valueAsNumber);
            }}
            style={{ ...smallButton, width: 76 }}
          />
        </label>

        <select
          value=""
          onChange={(event) => {
            if (event.target.value) onEdit("easing", event.target.value);
          }}
          style={smallButton}
          aria-label="Easing"
        >
          <option value="">Easing…</option>
          {["linear", "easeIn", "easeOut", "easeInOut", "emphasized"].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          value=""
          onChange={(event) => {
            if (event.target.value) onEdit("trigger", { type: event.target.value });
          }}
          style={smallButton}
          aria-label="Trigger"
        >
          <option value="">Starts…</option>
          <option value="slideEnter">on slide enter</option>
          <option value="afterPrevious">after the previous</option>
          <option value="withPrevious">with the previous</option>
          <option value="click">on click</option>
        </select>

        <button style={smallButton} onClick={() => onEdit("duplicate", null)}>
          Duplicate clip
        </button>

        <button style={smallButton} onClick={() => onEdit("delete", null)}>
          Remove
        </button>
      </div>

      {preset ? (
        <p style={{ ...muted, margin: "8px 0 0" }}>
          {preset.description} Under reduced motion it becomes{" "}
          {preset.reducedMotion === "instant" ? "its finished state" : preset.reducedMotion}.
        </p>
      ) : null}
    </div>
  );
}

function labelFor(element: PresentationElement): string {
  if (element.name) return element.name;
  if (element.semanticRole) return element.semanticRole;
  return element.id.slice(3, 11);
}

// ------------------------------------------------------------------ styles

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
};

const laneRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 26,
};

const laneLabel: CSSProperties = {
  width: 96,
  fontSize: 11,
  color: "var(--fg-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const laneTrack: CSSProperties = {
  position: "relative",
  flex: 1,
  height: 18,
  background: "var(--surface-alt)",
  borderRadius: 4,
};

const clipBar: CSSProperties = {
  position: "absolute",
  top: 0,
  height: 18,
  borderRadius: 4,
  borderWidth: 1,
  fontSize: 10,
  padding: "0 6px",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textAlign: "left",
};

const inspector: CSSProperties = {
  marginTop: 12,
  padding: 10,
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};

const smallButton: CSSProperties = {
  background: "var(--surface-alt)",
  border: "1px solid var(--border)",
  color: "var(--fg-muted)",
  borderRadius: 7,
  padding: "5px 10px",
  fontSize: 12,
};

const muted: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-subtle)",
  margin: 0,
};
