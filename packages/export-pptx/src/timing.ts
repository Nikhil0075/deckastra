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

const EXIT: Record<string, { presetId: number; subtype: number; note?: string }> = {
  fadeOut: { presetId: 10, subtype: 0 },
  slideOut: { presetId: 2, subtype: 4 },
  scaleOut: { presetId: 23, subtype: 16 },
  springOut: { presetId: 23, subtype: 16, note: "A spring exit becomes a plain zoom exit." },
  blurOut: { presetId: 10, subtype: 0, note: "Blur has no PowerPoint exit equivalent, so it becomes a fade out." },
  maskOut: { presetId: 22, subtype: 4, note: "The mask exit becomes a wipe out." },
  wipeOut: { presetId: 22, subtype: 4 },
  drawPathOut: { presetId: 22, subtype: 4, note: "The drawn-path exit becomes a wipe out." },
  staggerOut: { presetId: 10, subtype: 0, note: "The staggered exit becomes one fade out." },
};

export interface TimingInput {
  timeline: CompiledTimeline;
  slideId: string;
  ledger: DegradationLedger;
  /** Maps an element id to the shape id used in this slide's spTree. */
  shapeIds: Map<string, number>;
  /**
   * Sounds to play (integration plan 01 §3.10): narration takes and sound cues,
   * each an audio object already in the spTree, played by the click step it
   * belongs to, `delayMs` after the step begins.
   */
  audio?: AudioPlay[];
}

export interface AudioPlay {
  shapeId: number;
  segment: number;
  delayMs: number;
  durationMs: number;
  /** 0..1. */
  volume: number;
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
  const audio = input.audio ?? [];
  if (timeline.clips.length === 0 && audio.length === 0) return "";

  let nodeId = 2;
  const next = (): number => nodeId++;
  const emittedTextClips = new Set<string>();
  const textBuildShapeIds = new Set<number>();

  const bySegment = new Map<number, typeof timeline.clips>();
  for (const clip of timeline.clips) {
    const list = bySegment.get(clip.segment) ?? [];
    list.push(clip);
    bySegment.set(clip.segment, list);
  }

  const segments: string[] = [];

  for (const segment of timeline.segments) {
    const clips = bySegment.get(segment.index) ?? [];
    const sounds = audio.filter((play) => play.segment === segment.index);
    if (clips.length === 0 && sounds.length === 0) continue;

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
        const resolved = resolvePreset(preset);
        // The animation compiler resolves theme-local custom presets before the
        // export adapter runs. Preserve that category here; looking the name up
        // only in the built-in catalog would misclassify every custom exit or
        // emphasis as an entrance.
        const category = clip.category ?? resolved.preset.category;

        if (["byWord", "byLetter", "typewriter", "lineByLine", "wordCascade"].includes(preset)) {
          const sourceId = clip.id.split(":", 1)[0]!;
          if (emittedTextClips.has(sourceId)) return "";
          emittedTextClips.add(sourceId);

          const siblings = clips.filter((candidate) => candidate.id.split(":", 1)[0] === sourceId);
          const ordered = [...siblings].sort((a, b) => a.startMs - b.startMs);
          const unitDelayMs = ordered.length > 1 ? ordered[1]!.startMs - ordered[0]!.startMs : 0;
          const durationMs = Math.max(1, Math.round(clip.periodMs || clip.settledEndMs - clip.startMs));
          const delayPercent = unitDelayMs > 0
            ? Math.max(1, Math.min(100_000, Math.round(unitDelayMs / durationMs * 100_000)))
            : 10_000;
          const unit = preset === "lineByLine"
            ? null
            : preset === "byWord" || preset === "wordCascade"
              ? "wd"
              : "lt";
          textBuildShapeIds.add(shapeId);
          ledger.record({
            severity: "info",
            slideId,
            elementId: clip.targetId,
            feature: `animation:${preset}`,
            action: "approximated",
            message: preset === "lineByLine"
              ? "The text uses PowerPoint's native paragraph build."
              : preset === "byWord" || preset === "wordCascade"
                ? "The text uses PowerPoint's native word-by-word build."
                : "The text uses PowerPoint's native character-by-character build.",
          });
          return effect(
            next,
            shapeId,
            ENTRANCE.fade!,
            durationMs,
            Math.max(0, Math.round(ordered[0]!.startMs - segment.startMs)),
            clip.iterations,
            clip.direction === "alternate",
            "entrance",
            { unit, delayPercent },
          );
        }

        if (category === "loop") {
          return loopEffect({
            next,
            shapeId,
            preset,
            durationMs: Math.round(clip.periodMs || 1),
            delayMs: Math.max(0, Math.round(clip.startMs - segment.startMs)),
            iterations: clip.iterations,
            alternate: clip.direction === "alternate",
            ledger,
            slideId,
            elementId: clip.targetId,
          });
        }

        if (category === "path") {
          return loopEffect({
            next,
            shapeId,
            preset,
            durationMs: Math.round(clip.periodMs || clip.settledEndMs - clip.startMs),
            delayMs: Math.max(0, Math.round(clip.startMs - segment.startMs)),
            iterations: clip.iterations,
            alternate: clip.direction === "alternate",
            ledger,
            slideId,
            elementId: clip.targetId,
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

        if (category === "emphasis") {
          return emphasisEffect({
            next,
            shapeId,
            preset,
            durationMs: Math.round(clip.periodMs || clip.settledEndMs - clip.startMs),
            delayMs: Math.max(0, Math.round(clip.startMs - segment.startMs)),
            iterations: clip.iterations,
            alternate: clip.direction === "alternate",
            ledger,
            slideId,
            elementId: clip.targetId,
          });
        }

        const isExit = category === "exit";
        let mapped = isExit ? EXIT[preset] : ENTRANCE[preset];

        if (!mapped) {
          // Ask the engine what this preset degrades to rather than dropping it.
          // The browser renders an unknown preset as a fade (doc 02 §0.8 keeps
          // unknown values, and `resolvePreset` degrades them), so an export
          // that removed the animation entirely would disagree with what the
          // author saw on screen.
          mapped = isExit ? EXIT.fadeOut : ENTRANCE[resolved.preset.name];
          if (!mapped) mapped = isExit ? EXIT.fadeOut : ENTRANCE.fade;

          ledger.record({
            severity: "info",
            slideId,
            elementId: clip.targetId,
            feature: `animation:${preset}`,
            action: "approximated",
            message: isExit
              ? `"${preset}" has no matching PowerPoint exit effect and becomes a fade out.`
              : `"${preset}" has no PowerPoint entrance effect and becomes a fade.`,
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

        // The delay is the clip's own start relative to its segment, so a
        // stagger survives as staggered delays rather than collapsing.
        const delay = Math.max(0, Math.round(clip.startMs - segment.startMs));
        return effect(
          next,
          shapeId,
          mapped,
          Math.round(clip.periodMs || clip.settledEndMs - clip.startMs),
          delay,
          clip.iterations,
          clip.direction === "alternate",
          isExit ? "exit" : "entrance",
        );
      })
      .filter(Boolean)
      .join("") + sounds.map((play) => playCommand(next, play)).join("");

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

  // One media node per audio object, beside the sequence: PowerPoint keeps an
  // object's volume and its "stop when the slide ends" here, and a play
  // command without its media node is a sound it refuses to play.
  const mediaNodes = [...new Map(audio.map((play) => [play.shapeId, play])).values()]
    .map(
      (play) =>
        `<p:audio><p:cMediaNode vol="${Math.round(Math.max(0, Math.min(1, play.volume)) * 100_000)}">` +
        `<p:cTn id="${next()}" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>` +
        `<p:endCondLst><p:cond evt="onStopAudio" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst></p:cTn>` +
        `<p:tgtEl><p:spTgt spid="${play.shapeId}"/></p:tgtEl></p:cMediaNode></p:audio>`,
    )
    .join("");

  const buildList = textBuildShapeIds.size
    ? `<p:bldLst>${[...textBuildShapeIds].map((shapeId) => `<p:bldP spid="${shapeId}" grpId="0"/>`).join("")}</p:bldLst>`
    : "";
  return (
    "<p:timing><p:tnLst>" +
    '<p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">' +
    `<p:childTnLst>${segments.join("")}${mediaNodes}</p:childTnLst>` +
    `</p:cTn></p:par></p:tnLst>${buildList}</p:timing>`
  );
}

/** "Play from the start", `delayMs` into its click step: PowerPoint's media-call effect. */
function playCommand(next: () => number, play: AudioPlay): string {
  return (
    `<p:par><p:cTn id="${next()}" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="withEffect">` +
    `<p:stCondLst><p:cond delay="${Math.max(0, Math.round(play.delayMs))}"/></p:stCondLst>` +
    `<p:childTnLst><p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr>` +
    `<p:cTn id="${next()}" dur="${Math.max(1, Math.round(play.durationMs))}" fill="hold"/>` +
    `<p:tgtEl><p:spTgt spid="${play.shapeId}"/></p:tgtEl></p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par>`
  );
}

function emphasisEffect(input: {
  next: () => number;
  shapeId: number;
  preset: string;
  durationMs: number;
  delayMs: number;
  iterations: number;
  alternate: boolean;
  ledger: DegradationLedger;
  slideId: string;
  elementId: string;
}): string {
  const { next, shapeId, preset, durationMs, delayMs, iterations, alternate, ledger, slideId, elementId } = input;
  const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`;
  const behaviorTime = `<p:cTn id="${next()}" dur="${Math.max(1, durationMs)}" fill="hold"/>`;
  const common = (attributes: string) => `<p:cBhvr>${behaviorTime}${target}<p:attrNameLst>${attributes}</p:attrNameLst></p:cBhvr>`;
  let presetId = 6;
  let behavior = "";
  let note = "";

  switch (preset) {
    case "pulse":
      behavior = `<p:animScale>${common("<p:attrName>ppt_w</p:attrName><p:attrName>ppt_h</p:attrName>")}<p:by x="108000" y="108000"/></p:animScale>`;
      note = "Pulse is approximated with PowerPoint Grow/Shrink.";
      break;
    case "pop":
      behavior = `<p:animScale>${common("<p:attrName>ppt_w</p:attrName><p:attrName>ppt_h</p:attrName>")}<p:by x="114000" y="114000"/></p:animScale>`;
      note = "Pop is approximated with PowerPoint Grow/Shrink.";
      break;
    case "wiggle":
    case "shake":
      presetId = 8;
      behavior = `<p:animRot by="480000">${common("<p:attrName>r</p:attrName>")}</p:animRot>`;
      note = `${preset === "shake" ? "Shake" : "Wiggle"} is approximated with a small PowerPoint spin.`;
      break;
    case "highlightSweep":
    case "underlineDraw":
      behavior = `<p:animScale>${common("<p:attrName>ppt_w</p:attrName><p:attrName>ppt_h</p:attrName>")}<p:by x="108000" y="100000"/></p:animScale>`;
      note = `${preset === "underlineDraw" ? "Underline draw" : "Highlight sweep"} is approximated with a horizontal Grow/Shrink emphasis.`;
      break;
    case "colorShift":
      presetId = 7;
      behavior = `<p:animClr clrSpc="rgb" dir="cw">${common("<p:attrName>style.color</p:attrName>")}<p:to><a:srgbClr val="4472C4"/></p:to></p:animClr>`;
      note = "Colour shift is approximated with PowerPoint's native colour emphasis.";
      break;
    default:
      ledger.record({
        severity: "warning",
        slideId,
        elementId,
        feature: `animation:${preset}`,
        action: "dropped",
        message: `"${preset}" has no faithful PowerPoint emphasis equivalent and is exported at its rest frame.`,
      });
      return "";
  }

  ledger.record({
    severity: "info",
    slideId,
    elementId,
    feature: `animation:${preset}`,
    action: "approximated",
    message: note,
  });

  const repeat = repeatAttribute(iterations);
  const autoRev = alternate ? ' autoRev="1"' : "";
  return (
    `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="${delayMs}"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" presetID="${presetId}" presetClass="emph" presetSubtype="0"${repeat}${autoRev} fill="hold" nodeType="withEffect">` +
    `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${behavior}</p:childTnLst>` +
    "</p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>"
  );
}

function effect(
  next: () => number,
  shapeId: number,
  mapped: { presetId: number; subtype: number },
  durationMs: number,
  delayMs: number,
  iterations: number,
  alternate: boolean,
  kind: "entrance" | "exit",
  textUnit?: { unit: "wd" | "lt" | null; delayPercent: number },
): string {
  const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`;
  const repeat = repeatAttribute(iterations);
  const autoRev = alternate ? ' autoRev="1"' : "";
  const entrance = kind === "entrance";
  const iterate = textUnit?.unit
    ? `<p:iterate type="${textUnit.unit}"><p:tmPct val="${textUnit.delayPercent}"/></p:iterate>`
    : "";
  const visibility = entrance
    ? `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst>` +
      '<p:cond delay="0"/></p:stCondLst></p:cTn>' +
      `${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
      '</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
    : `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst>` +
      `<p:cond delay="${Math.max(0, durationMs - 1)}"/></p:stCondLst></p:cTn>` +
      `${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
      '</p:cBhvr><p:to><p:strVal val="hidden"/></p:to></p:set>';

  return (
    `<p:par><p:cTn id="${next()}" fill="hold">` +
    `<p:stCondLst><p:cond delay="${delayMs}"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" presetID="${mapped.presetId}" presetClass="${entrance ? "entr" : "exit"}" ` +
    `presetSubtype="${mapped.subtype}"${repeat}${autoRev} fill="hold" nodeType="afterEffect">` +
    `<p:stCondLst><p:cond delay="0"/></p:stCondLst>${iterate}<p:childTnLst>` +
    // `set` before `animEffect`: without it the element is visible for one frame
    // before its entrance begins, which is the same flash the sampler's backwards
    // fill prevents in the browser.
    visibility +
    `<p:animEffect transition="${entrance ? "in" : "out"}" filter="fade">` +
    `<p:cBhvr><p:cTn id="${next()}" dur="${durationMs}"/>${target}</p:cBhvr>` +
    "</p:animEffect>" +
    "</p:childTnLst></p:cTn></p:par>" +
    "</p:childTnLst></p:cTn></p:par>" +
    "</p:childTnLst></p:cTn></p:par>"
  );
}

function repeatAttribute(iterations: number): string {
  // PowerPoint serializes RepeatCount in thousandths (3 repeats => "3000").
  return iterations === Infinity
    ? ' repeatCount="indefinite"'
    : iterations > 1
      ? ` repeatCount="${Math.round(iterations * 1000)}"`
      : "";
}

function loopEffect(input: {
  next: () => number;
  shapeId: number;
  preset: string;
  durationMs: number;
  delayMs: number;
  iterations: number;
  alternate: boolean;
  ledger: DegradationLedger;
  slideId: string;
  elementId: string;
}): string {
  const { next, shapeId, preset, durationMs, delayMs, iterations, alternate, ledger, slideId, elementId } = input;
  const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`;
  const behaviorTime = `<p:cTn id="${next()}" dur="${durationMs}" fill="hold"/>`;
  const common = (attributes: string) => `<p:cBhvr>${behaviorTime}${target}<p:attrNameLst>${attributes}</p:attrNameLst></p:cBhvr>`;
  let presetId = 64;
  let presetClass = "path";
  let behavior = "";
  let note: string | undefined;

  switch (preset) {
    case "float":
      behavior = `<p:animMotion origin="layout" path="M 0 0 L 0 -0.015 E" pathEditMode="relative" ptsTypes="">${common("<p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName>")}</p:animMotion>`;
      break;
    case "orbit":
      behavior = `<p:animMotion origin="layout" path="M 0 -0.01 C 0.012 -0.01 0.012 0.01 0 0.01 C -0.012 0.01 -0.012 -0.01 0 -0.01 E" pathEditMode="relative" ptsTypes="">${common("<p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName>")}</p:animMotion>`;
      note = "Orbit is approximated with a small PowerPoint motion path.";
      break;
    case "marquee":
      behavior = `<p:animMotion origin="layout" path="M 0 0 L -0.12 0 E" pathEditMode="relative" ptsTypes="">${common("<p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName>")}</p:animMotion>`;
      note = "Marquee distance is approximated with a relative PowerPoint motion path.";
      break;
    case "moveAlongPath":
      behavior = `<p:animMotion origin="layout" path="M 0 0 L 0.12 0 E" pathEditMode="relative" ptsTypes="">${common("<p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName>")}</p:animMotion>`;
      note = "The path vector is mapped to a native PowerPoint motion path.";
      break;
    case "spin":
      presetId = 8;
      presetClass = "emph";
      behavior = `<p:animRot by="21600000">${common("<p:attrName>r</p:attrName>")}</p:animRot>`;
      break;
    case "breathe":
      presetId = 6;
      presetClass = "emph";
      behavior = `<p:animScale>${common("<p:attrName>ppt_w</p:attrName><p:attrName>ppt_h</p:attrName>")}<p:by x="103500" y="103500"/></p:animScale>`;
      note = "Breathe is approximated with PowerPoint Grow/Shrink; its opacity pulse is omitted.";
      break;
    case "kenBurns":
      presetId = 6;
      presetClass = "emph";
      behavior = `<p:animScale>${common("<p:attrName>ppt_w</p:attrName><p:attrName>ppt_h</p:attrName>")}<p:by x="108000" y="108000"/></p:animScale>`;
      note = "Ken Burns is approximated with a slow PowerPoint zoom; the pan is omitted.";
      break;
    default:
      ledger.record({
        severity: "warning",
        slideId,
        elementId,
        feature: `animation:${preset}`,
        action: "dropped",
        message: `"${preset}" uses a renderer-only effect layer and is exported at its rest frame, not as a blinking fade.`,
      });
      return "";
  }

  if (note) {
    ledger.record({ severity: "info", slideId, elementId, feature: `animation:${preset}`, action: "approximated", message: note });
  }

  const repeat = repeatAttribute(iterations);
  const autoRev = alternate ? ' autoRev="1"' : "";
  return (
    `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="${delayMs}"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${next()}" presetID="${presetId}" presetClass="${presetClass}" presetSubtype="0"${repeat}${autoRev} fill="hold" nodeType="withEffect">` +
    `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${behavior}</p:childTnLst>` +
    "</p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>"
  );
}

/**
 * Whether a slide's transition can become PowerPoint's Morph (doc 04 §33.3).
 *
 * Morph pairs objects by **name**, and this exporter derives names from element
 * ids — which is stable across edits but not, on its own, enough: two paired
 * elements are two different elements with two different ids, so their names
 * differ and Morph pairs nothing. `shapesFor` closes that by naming a paired
 * shape after its partner on the previous slide.
 *
 * What is still written here is a **fade**. Emitting PowerPoint's own Morph
 * means `mc:AlternateContent` around a vendor-namespaced element, and nothing in
 * this repository can check that PowerPoint accepts it — only that a reader
 * parses it. So the file does the thing that certainly works, the names make the
 * manual Morph work, and the report says exactly that rather than implying the
 * transition will morph by itself.
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
    case "cover":
    case "push":
      return `<p:transition spd="med" advTm="${duration}"><p:push dir="l"/></p:transition>`;
    case "wipe":
      return `<p:transition spd="med" advTm="${duration}"><p:wipe dir="l"/></p:transition>`;
    case "split":
      return `<p:transition spd="med" advTm="${duration}"><p:split orient="vert" dir="out"/></p:transition>`;
    case "iris":
      ledger.record({
        severity: "info",
        slideId,
        feature: "transition:iris",
        action: "approximated",
        message: "The iris transition uses PowerPoint's nearest circular reveal.",
      });
      return `<p:transition spd="med" advTm="${duration}"><p:circle/></p:transition>`;
    case "blurDissolve":
      ledger.record({
        severity: "info",
        slideId,
        feature: "transition:blurDissolve",
        action: "approximated",
        message: "Blur dissolve becomes PowerPoint Dissolve; the blur component is omitted.",
      });
      return `<p:transition spd="med" advTm="${duration}"><p:dissolve/></p:transition>`;
    case "flip":
      ledger.record({
        severity: "info",
        slideId,
        feature: "transition:flip",
        action: "approximated",
        message: "The 3D flip becomes a fade in PowerPoint.",
      });
      return `<p:transition spd="med" advTm="${duration}"><p:fade/></p:transition>`;
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
          "PowerPoint shows a fade here: this build does not emit its Morph " +
          "transition. Paired objects are given the same shape name on both " +
          "slides, so applying Morph in PowerPoint pairs them correctly.",
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
