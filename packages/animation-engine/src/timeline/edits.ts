/**
 * A timeline gesture as patch operations (doc 04 §25.2).
 *
 * The other half of "the timeline is a view of document state": dragging a clip
 * is not a UI-local mutation with a save button behind it — it is a patch
 * against `slide.animations`, and therefore a transaction with an inverse in the
 * same history as every other edit.
 */

import type { PatchOperation } from "@deckastra/presentation-schema";

import type { CompiledClip } from "../compile";
import { round } from "../easing";

// -------------------------------------------------------------------- edits

export type ClipEdit =
  | { kind: "move"; startMs: number }
  | { kind: "trim"; durationMs: number }
  | { kind: "easing"; easing: string }
  | { kind: "preset"; preset: string; presetParams?: Record<string, unknown> }
  | { kind: "params"; presetParams: Record<string, unknown> }
  | { kind: "trigger"; trigger: { type: string; delayMs?: number } }
  | { kind: "delete" };

/** Minimum clip length. Below this a clip is a step, and a step is a `none` clip. */
export const MIN_CLIP_MS = 50;

/**
 * A timeline gesture as patch operations.
 *
 * Id-addressed, always. An index path into `slide.animations` breaks the moment
 * another track is inserted before it, which is exactly what adding an animation
 * does — and the author would be dragging clip 3 and moving clip 4.
 *
 * `startMs` is written as an offset from the *trigger*, not as an absolute time,
 * because that is what the document stores (doc 02 §24.4). Dragging a clip on a
 * timeline whose neighbour then changes duration must not silently reposition it.
 */
export function clipPatchOperations(
  slideId: string,
  clip: CompiledClip,
  edit: ClipEdit,
  triggerStartMs: number,
): PatchOperation[] {
  const base = `/slides/id:${slideId}/animations/id:${clip.trackId}`;
  const clipPath = `${base}/clips/id:${clip.id}`;

  switch (edit.kind) {
    case "move":
      return [
        {
          op: "replace",
          path: `${clipPath}/startMs`,
          value: Math.max(0, round(edit.startMs - triggerStartMs)),
        },
      ];

    case "trim":
      return [
        {
          op: "replace",
          path: `${clipPath}/durationMs`,
          value: Math.max(MIN_CLIP_MS, round(edit.durationMs)),
        },
      ];

    case "easing":
      return [{ op: "replace", path: `${clipPath}/easing`, value: edit.easing }];

    case "preset":
      return [
        { op: "replace", path: `${clipPath}/preset`, value: edit.preset },
        // Parameters belong to the preset that declared them; carrying a
        // `blurReveal` blur onto a `drawPath` leaves a value nothing reads and
        // the panel offering a control that does nothing.
        {
          op: "replace",
          path: `${clipPath}/presetParams`,
          value: edit.presetParams ?? {},
        },
      ];

    case "params":
      return [
        { op: "replace", path: `${clipPath}/presetParams`, value: edit.presetParams },
      ];

    case "trigger":
      return [{ op: "replace", path: `${base}/trigger`, value: edit.trigger }];

    case "delete":
      return [{ op: "remove", path: clipPath }];

    default:
      return [];
  }
}
