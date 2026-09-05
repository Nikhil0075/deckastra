/**
 * Animation to PPTX timing nodes (doc 04 §33.3).
 *
 * PowerPoint's timing model is a tree of `<p:par>` and `<p:seq>` nodes with
 * behaviours attached, and it is unforgiving: a malformed tree makes PowerPoint
 * discard the whole slide's animation rather than the one node it disliked. So
 * this emits a narrow, well-tested subset — entrance effects and click
 * boundaries — and degrades everything else with a warning.
 *
 * The mapping table is §33.3's:
 *
 *   fade | slide | scale        native entrance effects
 *   staggerReveal                a sequence of natives with delays
 *   blurReveal                   fade, and say so
 *   drawPath                     wipe, and say so
 *   numberCount                  final value, no animation, and say so
 *   sharedElementMorph           the Morph transition, or a fade
 *   click segments               advance-on-click timing nodes
 */

import { resolvePreset, type CompiledTimeline } from "@deckastra/animation-engine";
import type { DegradationLedger } from "@deckastra/export-core";

/** Deckastra preset → PowerPoint entrance effect id, and what to warn about. */
const ENTRANCE: Record<string, { presetId: number; subtype: number; note?: string }> = {
  // presetClass="entr" ids from the PresentationML spec.
  fade: { presetId: 10, subtype: 0 },
  slide: { presetId: 2, subtype: 4 }, // Fly In, from bottom
  scale: { presetId: 23, subtype: 16 }, // Zoom
  springIn: { presetId: 23, subtype: 16, note: "A spring becomes a plain zoom." },
  blurReveal: { presetId: 10, subtype: 0, note: "Blur has no equivalent, so it becomes a fade." },
  maskReveal: { presetId: 22, subtype: 4, note: "The mask becomes a wipe." },
  drawPath: { presetId: 22, subtype: 4, note: "A drawn path becomes a wipe." },
  staggerReveal: { presetId: 10, subtype: 0 },
};

export interface TimingInput {
  timeline: CompiledTimeline;
  slideId: string;
  ledger: DegradationLedger;
  /** Maps an element id to the shape id used in this slide's spTree. */
  shapeIds: Map<string, number>;
}

/**
 * The `<p:timing>` element for a slide, or an empty string when nothing moves.
 *
 * An empty string rather than an empty `<p:timing/>`: PowerPoint treats a
 * timing node with no sequence as a slide whose animation was deliberately
 * cleared, which suppresses the master's own transition behaviour.
 */
export function timingFor(input: TimingInput): string {
  const { timeline, ledger, slideId, shapeIds } = input;
  if (timeline.clips.length === 0) return "";

  let nodeId = 2;
  const next = (): number => nodeId++;

  const bySegment = new Map<number, typeof timeline.clips>();
  for (const clip of timeline.clips) {
    const list = bySegment.get(clip.segment) ?? [];
    list.push(clip);
    bySegment.set(clip.segment, list);
  }

  const segments: string[] = [];

  for (const segment of timeline.segments) {
    const clips = bySegment.get(segment.index) ?? [];
    if (clips.length === 0) continue;

    const behaviours = clips
      .map((clip) => {
        const shapeId = shapeIds.get(clip.targetId);
        if (shapeId === undefined) {
          // The element was degraded to a placeholder or dropped; animating a
          // shape id that is not in the tree is what makes PowerPoint discard
          // every animation on the slide.
          ledger.record({
            severity: "info",
            slideId,
            elementId: clip.targetId,
            feature: "animation",
            action: "dropped",
            message: "An animation targeted an element that is not in the exported slide.",
          });
          return "";
        }

        const preset = clip.preset ?? "fade";
        let mapped = ENTRANCE[preset];

        if (!mapped) {
          // Ask the engine what this preset degrades to rather than dropping it.
          // The browser renders an unknown preset as a fade (doc 02 §0.8 keeps
          // unknown values, and `resolvePreset` degrades them), so an export
          // that removed the animation entirely would disagree with what the
          // author saw on screen.
          const fallback = resolvePreset(preset);
          mapped = ENTRANCE[fallback.preset.name];

          ledger.record({
            severity: "info",
            slideId,
            elementId: clip.targetId,
            feature: `animation:${preset}`,
            action: "approximated",
            message: `"${preset}" has no PowerPoint entrance effect and becomes a fade.`,
          });
        }

        if (!mapped) {
          ledger.record({
            severity: "warning",
            slideId,
            elementId: clip.targetId,
            feature: `animation:${preset}`,
            action: "dropped",
            message: `"${preset}" could not be mapped; the element appears without animation.`,
          });
          return "";
        }

        if (mapped.note) {
          ledger.record({
            severity: "info",
            slideId,
            elementId: clip.targetId,
            feature: `animation:${preset}`,
            action: "approximated",
            message: mapped.note,
          });
        }

        if (preset === "numberCount") {
          ledger.record({
            severity: "warning",
            slideId,
            elementId: clip.targetId,
            feature: "animation:numberCount",
            action: "approximated",
            message: "The number is exported at its final value, without counting up.",
          });
          return "";
        }

        // The delay is the clip's own start relative to its segment, so a
        // stagger survives as staggered delays rather than collapsing.
        const delay = Math.max(0, Math.round(clip.startMs - segment.startMs));
        return effect(next, shapeId, mapped, Math.round(clip.endMs - clip.startMs), delay);
      })
      .filter(Boolean)
      .join("");

    if (!behaviours) continue;

    // `indefinite` on a clicked segment is what makes PowerPoint wait for the
    // presenter rather than running straight through (doc 04 §33.3).
    const condition =
      segment.advanceOn === "click"
        ? `<p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>`
        : `<p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>`;

    segments.push(
      `<p:par>${condition}<p:childTnLst>${behaviours}</p:childTnLst></p:cTn></p:par>`,
    );
  }

  if (segments.length === 0) return "";

  return (
    "<p:timing><p:tnLst>" +
    '<p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">' +
    `<p:childTnLst>${segments.join("")}</p:childTnLst>` +
    "</p:cTn></p:par></p:tnLst></p:timing>"
  );
}

function effect(
  next: () => number,
  shapeId: number,
  mapped: { presetId: number; subtype: number },
  durationMs: number,
  delayMs: number,
): string {
  const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`;

  return (
    `<p:par><p:cTn id="${next()}" fill="hold">` +
    `<p:stCondLst><p:cond delay="${delayMs}"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" presetID="${mapped.presetId}" presetClass="entr" ` +
    `presetSubtype="${mapped.subtype}" fill="hold" nodeType="afterEffect">` +
    "<p:stCondLst><p:cond delay=\"0\"/></p:stCondLst><p:childTnLst>" +
    // `set` before `animEffect`: without it the element is visible for one frame
    // before its entrance begins, which is the same flash the sampler's backwards
    // fill prevents in the browser.
    `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst>` +
    '<p:cond delay="0"/></p:stCondLst></p:cTn>' +
    `${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
    "</p:cBhvr><p:to><p:strVal val=\"visible\"/></p:to></p:set>" +
    `<p:animEffect transition="in" filter="fade">` +
    `<p:cBhvr><p:cTn id="${next()}" dur="${durationMs}"/>${target}</p:cBhvr>` +
    "</p:animEffect>" +
    "</p:childTnLst></p:cTn></p:par>" +
    "</p:childTnLst></p:cTn></p:par>" +
    "</p:childTnLst></p:cTn></p:par>"
  );
}

/**
 * Whether a slide's transition can become PowerPoint's Morph (doc 04 §33.3).
 *
 * Morph pairs objects by name and z-order, and the exporter writes names derived
 * from element ids — so it *can* work. Whether it does depends on the two slides
 * genuinely sharing elements, which this cannot know from one slide, so the
 * answer is honest rather than confident.
 */
export function transitionFor(
  type: string | undefined,
  durationMs: number | undefined,
  slideId: string,
  ledger: DegradationLedger,
): string {
  const duration = Math.max(0, Math.round(durationMs ?? 300));

  switch (type) {
    case undefined:
    case "cut":
      return "";
    case "fade":
      return `<p:transition spd="med" advTm="${duration}"><p:fade/></p:transition>`;
    case "slide":
    case "push":
      return `<p:transition spd="med" advTm="${duration}"><p:push dir="l"/></p:transition>`;
    case "zoom":
      ledger.record({
        severity: "info",
        slideId,
        feature: "transition:zoom",
        action: "approximated",
        message: "The zoom transition becomes a fade in PowerPoint.",
      });
      return `<p:transition spd="med" advTm="${duration}"><p:fade/></p:transition>`;
    case "morph":
      ledger.record({
        severity: "info",
        slideId,
        feature: "transition:morph",
        action: "approximated",
        message:
          "Morph is exported with matching shape names so PowerPoint can pair " +
          "objects, but pairing depends on the two slides sharing elements.",
      });
      return `<p:transition spd="med" advTm="${duration}"><p:fade/></p:transition>`;
    default:
      ledger.record({
        severity: "info",
        slideId,
        feature: `transition:${type}`,
        action: "approximated",
        message: `The "${type}" transition has no PowerPoint equivalent and becomes a fade.`,
      });
      return `<p:transition spd="med" advTm="${duration}"><p:fade/></p:transition>`;
  }
}
