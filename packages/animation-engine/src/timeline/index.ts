/**
 * The timeline: a view of document state, and gestures as patches (doc 04 §25).
 *
 * Four modules, split the way the transition engine is, along what each can be
 * wrong about. `view` can be wrong about what to draw; `edits` about what one
 * gesture means; `split` about redistributing keyframes across a cut; `ripple`
 * about which clips "after" includes; `keyframes` about normalised offsets.
 * None of them mutates anything — every one returns operations, because a
 * timeline edit is a transaction with an inverse in the same history as a text
 * edit, and a second mutation path would need undo wiring all over again.
 */

export {
  buildTimelineView,
  type TimelineBar,
  type TimelineLane,
  type TimelineView,
} from "./view";

export { MIN_CLIP_MS, clipPatchOperations, type ClipEdit } from "./edits";

export { splitClip, type SplitResult, type SplitTarget } from "./split";

export {
  rippleAfterTrim,
  rippleOperations,
  type RippleClip,
  type RippleResult,
} from "./ripple";

export {
  moveKeyframeOperations,
  openPresetOperations,
  removeKeyframeOperations,
  setKeyframeOperations,
  type OpenableClip,
} from "./keyframes";
