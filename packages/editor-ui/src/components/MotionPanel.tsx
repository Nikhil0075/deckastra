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
  findConflicts,
  moveKeyframeOperations,
  motionThemeOf,
  openPresetOperations,
  removeKeyframeOperations,
  rippleAfterTrim,
  setKeyframeOperations,
  splitClip,
  type CompiledTimeline,
} from "@deckastra/animation-engine";
import type { SlideScene } from "@deckastra/renderer";

import { TimelineLanes, type TimelineGesture } from "./TimelineLanes";

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
  // What the last gesture could not do, shown once rather than thrown away. A
  // split that was refused for being too close to an edge is the author's
  // question to answer, not something to swallow.
  const [notice, setNotice] = useState<string | null>(null);

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

  /**
   * Overlaps, with something to press.
   *
   * The compiled warnings already say an overlap exists. These say which pair,
   * which property, by how much, and offer the two edits that resolve it — the
   * `MECHANICALLY_FIXABLE` shape the validator's catalog uses, applied to motion.
   */
  const conflicts = useMemo(() => {
    if (!timeline || !slide) return [];
    const sources = (slide.animations ?? []).flatMap((track) =>
      track.clips.map((one) => ({
        id: one.id,
        trackId: track.id,
        startMs: one.startMs,
        durationMs: one.durationMs,
        delayMs: one.delayMs,
      })),
    );
    const found = findConflicts(slide.id, timeline, sources);

    // Grouped by the pair, not by the property. One pair colliding on two
    // properties is two true findings and one decision, and offering the same
    // two buttons twice makes an author read four things to learn one.
    const byPair = new Map<string, { properties: string[]; conflict: (typeof found)[number] }>();
    for (const conflict of found) {
      const key = `${conflict.earlierClipId}:${conflict.laterClipId}`;
      const existing = byPair.get(key);
      if (existing) existing.properties.push(conflict.property);
      else byPair.set(key, { properties: [conflict.property], conflict });
    }
    return [...byPair.values()];
  }, [timeline, slide]);

  if (!slide || !timeline || !view) return null;

  const clip = timeline.clips.find((one) => one.id === selectedClip);
  const trackIndex = slide.animations?.findIndex(track => track.id === clip?.trackId) ?? -1;
  const sourceClip = slide.animations?.find(track => track.id === clip?.trackId)?.clips.find(item => item.id === clip?.id || clip?.id.startsWith(`${item.id}:`));
  const scale = view.durationMs > 0 ? 100 / view.durationMs : 0;

  /**
   * When this clip's trigger resolved, in absolute slide time.
   *
   * The document stores `startMs` as an offset from the trigger and the compiler
   * reports it absolute (doc 02 §24.4), so the difference between them *is* the
   * trigger. Deriving it beats threading it through: a drag produces an absolute
   * drop position, and writing that straight into the document would move a clip
   * on an `afterPrevious` track by however long everything before it runs.
   */
  const triggerStartMs =
    clip && sourceClip ? clip.startMs - sourceClip.startMs - (sourceClip.delayMs ?? 0) : 0;

  /**
   * A settled drag, as operations.
   *
   * The gesture arrives once, already rounded, from `TimelineLanes` — this turns
   * it into the same `clipPatchOperations` a number field produces, so a drag
   * and a typed value are literally the same edit and undo cannot tell them
   * apart. A rippling trim is two patches in one transaction: the clip's own
   * duration, then everything after it, so undo takes both back together.
   */
  function commitGesture(gesture: TimelineGesture) {
    if (!slide || !clip || !sourceClip) return;
    const track = slide.animations?.find((one) => one.id === gesture.trackId);
    if (!track) return;

    if (gesture.kind === "keyframe") {
      const result = moveKeyframeOperations(
        slide.id,
        { ...sourceClip, trackId: clip.trackId },
        gesture.property,
        gesture.fromOffset,
        gesture.toMs,
      );
      setNotice(result.warning ?? null);
      if (result.operations.length > 0) apply(result.operations, "Move keyframe");
      return;
    }

    if (gesture.kind === "move") {
      apply(
        clipPatchOperations(slide.id, clip, { kind: "move", startMs: gesture.startMs }, triggerStartMs),
        "Move clip",
      );
      return;
    }

    const operations = clipPatchOperations(
      slide.id,
      clip,
      { kind: "trim", durationMs: gesture.durationMs },
      triggerStartMs,
    );

    if (gesture.ripple) {
      const followers = rippleAfterTrim(
        slide.id,
        gesture.trackId,
        track.clips.map((one) => ({ id: one.id, startMs: one.startMs, durationMs: one.durationMs })),
        sourceClip.id,
        gesture.durationMs,
      );
      operations.push(...followers.operations);
    }

    apply(operations, gesture.ripple ? "Trim clip and move later ones" : "Trim clip");
  }

  /**
   * Cut the selected clip at the playhead.
   *
   * At the playhead rather than at the pointer because that is where the author
   * has already decided the moment is — they scrubbed to it to see what happens
   * there. A cut at a second, unrelated position would be a different question.
   */
  function splitAtPlayhead() {
    if (!slide || !clip || !sourceClip) return;
    const within = playheadMs - clip.startMs;
    const result = splitClip(
      slide.id,
      { ...sourceClip, trackId: clip.trackId },
      within,
      newId("clp"),
    );
    if (result.operations.length === 0) {
      setNotice(result.warning ?? "This clip cannot be split there.");
      return;
    }
    setNotice(result.warning ?? null);
    apply(result.operations, "Split clip");
    setSelectedClip(result.newClipId);
  }

  /** Expand the preset into keyframes an author can move. An ordinary patch. */
  function openKeyframes() {
    if (!slide || !clip || !sourceClip) return;
    const node = scene.nodes.find((one) => one.id === clip.targetId);
    const result = openPresetOperations(
      slide.id,
      { ...sourceClip, trackId: clip.trackId },
      // The compiler's own reading of the theme. Expanding a preset with
      // different defaults than it used would produce keyframes that do not
      // match what the author was just watching.
      { bounds: node?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }, motion: motionThemeOf(scene) },
    );
    setNotice(result.warning ?? null);
    if (result.operations.length > 0) apply(result.operations, "Open preset into keyframes");
  }

  function keyframeEdit(property: string, action: "add" | "remove", offset?: number) {
    if (!slide || !clip || !sourceClip) return;
    const result =
      action === "add"
        ? setKeyframeOperations(
            slide.id,
            { ...sourceClip, trackId: clip.trackId },
            property,
            playheadMs - clip.startMs,
            valueAtPlayhead(sourceClip, property, playheadMs - clip.startMs),
          )
        : removeKeyframeOperations(
            slide.id,
            { ...sourceClip, trackId: clip.trackId },
            property,
            offset ?? 0,
          );
    setNotice(result.warning ?? null);
    if (result.operations.length > 0) {
      apply(result.operations, action === "add" ? "Add keyframe" : "Remove keyframe");
    }
  }

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
      // Only a `move` reads this, turning an absolute drop position back into an
      // offset from the trigger. None of the edits below is a move, but passing
      // the real value costs nothing and stops the next one added here from
      // inheriting a zero that used to be honest and no longer is.
      triggerStartMs,
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

          <TimelineLanes
            view={view}
            keyframes={
              sourceClip?.propertyTracks?.length && clip
                ? {
                    clipId: clip.id,
                    durationMs: sourceClip.durationMs,
                    tracks: sourceClip.propertyTracks,
                  }
                : null
            }
            selectedClipId={selectedClip}
            playheadMs={playheadMs}
            onSelect={setSelectedClip}
            onCommit={commitGesture}
            onScrub={onScrub}
          />

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

              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <button style={smallButton} onClick={splitAtPlayhead}>
                  Split at playhead
                </button>
                {sourceClip?.propertyTracks?.length ? (
                  <span style={muted}>
                    {sourceClip.propertyTracks.length} property track(s) open
                    {sourceClip.preset ? ` · from ${sourceClip.preset}` : ""}
                  </span>
                ) : (
                  <button style={smallButton} onClick={openKeyframes} disabled={!sourceClip?.preset}>
                    Open keyframes
                  </button>
                )}
              </div>

              {sourceClip?.propertyTracks?.length ? (
                <KeyframeList
                  tracks={sourceClip.propertyTracks}
                  durationMs={sourceClip.durationMs}
                  onAdd={(property) => keyframeEdit(property, "add")}
                  onRemove={(property, offset) => keyframeEdit(property, "remove", offset)}
                />
              ) : null}

              {notice ? (
                <p style={{ ...muted, color: "var(--warning)", marginTop: 8 }} role="status">
                  {notice}
                </p>
              ) : null}
              <ClipInspector clip={clip} durationMs={sourceClip?.durationMs ?? 0} startMs={sourceClip?.startMs ?? 0} delayMs={sourceClip?.delayMs ?? 0} onEdit={edit} />
            </>
          ) : null}

          {conflicts.length > 0 ? (
            <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none" }}>
              {conflicts.map(({ conflict, properties }) => (
                <li
                  key={`${conflict.earlierClipId}:${conflict.laterClipId}`}
                  style={{
                    border: "1px solid var(--warning)",
                    borderRadius: 4,
                    padding: "6px 8px",
                    marginBottom: 6,
                  }}
                >
                  <span style={{ ...muted, color: "var(--warning)" }}>
                    {properties.length > 1
                      ? `Two clips animate ${properties.join(" and ")} on this object for ` +
                        `${Math.round(conflict.overlapMs)}ms together. The later one wins where they overlap.`
                      : conflict.message}
                  </span>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    {conflict.fixes.map((fix) => (
                      <button
                        key={fix.label}
                        style={smallButton}
                        title={fix.caveat}
                        onClick={() => apply(fix.operations, fix.label)}
                      >
                        {fix.label}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {view.warnings.length > 0 ? (
            <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none" }}>
              {view.warnings
                // W136 is the overlap, and the block above says the same thing
                // with the pair named and a fix attached. Two copies of one
                // finding teaches an author to skim both.
                .filter((warning) => warning.code !== "W136")
                .map((warning) => (
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

/**
 * The keyframes of an opened clip, as a list.
 *
 * A list rather than handles on the bar, for now, and the reason is honest
 * rather than aspirational: dragging a keyframe wants the same rAF-coalesced,
 * commit-on-pointer-up machinery the bars have, and bolting a second, simpler
 * drag onto the same surface would be two behaviours an author has to tell
 * apart by pixel. Times are shown in milliseconds because that is what an author
 * thinks in; the document stores fractions of the clip, which is what lets
 * trimming rescale them all at once.
 */
function KeyframeList({
  tracks,
  durationMs,
  onAdd,
  onRemove,
}: {
  tracks: { property: string; keyframes: { offset: number; value: unknown }[] }[];
  durationMs: number;
  onAdd: (property: string) => void;
  onRemove: (property: string, offset: number) => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      {tracks.map((track) => (
        <div key={track.property} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--fg-subtle)", width: 72 }}>{track.property}</span>
          {[...track.keyframes]
            .sort((a, b) => a.offset - b.offset)
            .map((frame) => (
              <button
                key={frame.offset}
                style={keyframeChip}
                title={`${Math.round(frame.offset * durationMs)}ms · ${String(frame.value)} · click to remove`}
                onClick={() => onRemove(track.property, frame.offset)}
              >
                {Math.round(frame.offset * durationMs)}ms
              </button>
            ))}
          <button style={smallButton} onClick={() => onAdd(track.property)}>
            + at playhead
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * What a property is worth at a moment, for a keyframe added there.
 *
 * Reading the track rather than defaulting to zero: an author clicking "add a
 * keyframe" at 200ms means "pin what is happening here", and a keyframe that
 * silently set the value to 0 would change the animation at the instant they
 * were trying to preserve.
 */
function valueAtPlayhead(
  sourceClip: { durationMs: number; propertyTracks?: { property: string; keyframes: { offset: number; value: unknown }[] }[] },
  property: string,
  withinMs: number,
): unknown {
  const track = sourceClip.propertyTracks?.find((one) => one.property === property);
  if (!track || track.keyframes.length === 0) return 0;

  const offset = sourceClip.durationMs > 0 ? Math.min(1, Math.max(0, withinMs / sourceClip.durationMs)) : 0;
  const sorted = [...track.keyframes].sort((a, b) => a.offset - b.offset);
  const before = [...sorted].reverse().find((frame) => frame.offset <= offset) ?? sorted[0]!;
  const after = sorted.find((frame) => frame.offset >= offset) ?? sorted[sorted.length - 1]!;

  if (typeof before.value !== "number" || typeof after.value !== "number") return before.value;
  const span = after.offset - before.offset;
  const progress = span <= 0 ? 0 : (offset - before.offset) / span;
  return before.value + (after.value - before.value) * progress;
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

const keyframeChip: CSSProperties = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--surface-alt)",
  color: "var(--fg-muted)",
  cursor: "pointer",
  fontVariantNumeric: "tabular-nums",
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
