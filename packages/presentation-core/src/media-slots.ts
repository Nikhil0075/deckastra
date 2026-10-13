import type { MediaSlot, PresentationElement, Slide } from "@deckastra/presentation-schema";

/**
 * A picture slot as a brief (template media slots, 2026-10-13): what kind of
 * picture it needs, at what shape, and the words to ask for it with. One
 * definition, read by the editor's picture generation and by agents over MCP,
 * so a person and an agent are told the same thing about the same frame.
 *
 * The prompt states the composition the slot depends on, because a picture
 * made without it fails in known ways: a subject with its hands or feet cut
 * off by the frame, a product whose edge touches the border, a busy patch
 * exactly where the headline sits. The checklist is for the person approving
 * the result, since no generator can be trusted to have followed a prompt.
 */

export type MediaSlotKind = "scene" | "cut-out" | "product render" | "texture" | "close-up";

export interface MediaSlotBrief {
  kind: MediaSlotKind;
  /** The shape to ask a generator for, nearest to the frame's own. */
  aspectRatio: "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  prompt: string;
  /** What to check in the result before using it. */
  checks: string[];
}

const KIND: Record<string, MediaSlotKind> = {
  background: "scene",
  subject: "scene",
  product: "product render",
  texture: "texture",
  detail: "close-up",
};

function aspect(width: number, height: number): MediaSlotBrief["aspectRatio"] {
  const ratio = width / Math.max(1, height);
  const options: [MediaSlotBrief["aspectRatio"], number][] = [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16]];
  return options.reduce((best, option) => (Math.abs(Math.log(option[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? option : best))[0];
}

/** Which part of the frame a region is in, in words. */
function side(x: number, y: number): string {
  const across = x < 0.4 ? "left" : x > 0.6 ? "right" : "";
  const down = y < 0.4 ? "upper" : y > 0.6 ? "lower" : "";
  return [down, across].filter(Boolean).join(" ") || "centre";
}

const TREATMENT_WORDS: Record<string, string> = {
  mono: "It will be shown in black and white, so it should read through light and shape rather than colour.",
  faded: "It will be shown softly faded; natural, muted light suits it.",
  film: "It will be shown with a film grade; warm, natural light suits it.",
  dramatic: "It will be shown with deep shadows; directional light suits it.",
  duotone: "It will be shown in two theme colours, so strong contrast matters more than colour.",
};

/**
 * The brief for a slot on a frame `width` by `height`, with `subject` (what the
 * person asked for, or the slot's own subject) at its centre.
 */
export function mediaSlotBrief(slot: MediaSlot, size: { width: number; height: number }, subject?: string): MediaSlotBrief {
  const cutout = slot.transparentRequired === true;
  const kind: MediaSlotKind = cutout ? "cut-out" : KIND[slot.role] ?? "scene";
  const what = (subject ?? slot.subject ?? "").trim();
  const lines: string[] = [];
  const checks: string[] = ["No words, letters or logos in the picture."];

  if (kind === "cut-out") {
    lines.push(
      `${what || "The subject"}, the whole figure in frame on a plain, even background that is easy to cut away.`,
      "Complete hands and feet visible; nothing cropped by the edge of the picture.",
    );
    checks.push("Hands, feet and the top of the head are all inside the picture.");
    checks.push("It needs a transparent background before it can stand in front of the slide: Deckastra does not remove backgrounds yet, so add a transparent PNG as a cut-out of this picture.");
  } else if (kind === "product render") {
    lines.push(
      `${what || "The product"}, rendered whole, with a clear margin of space around every edge.`,
      "Clean studio light on a simple background.",
    );
    checks.push("Every edge of the product is inside the picture, with space around it.");
  } else if (kind === "texture") {
    lines.push(`${what ? `${what}: a` : "A"} seamless surface texture, with no objects and no single point of interest.`);
  } else if (kind === "close-up") {
    lines.push(`${what || "A detail"}, a close-up with one clear point of focus.`);
  } else if (slot.role === "subject") {
    lines.push(`${what || "A person"}, photographed, with the whole of the head and shoulders in frame.`);
    checks.push("The face is not cut by the frame or by the outline the picture is masked to.");
  } else {
    lines.push(`${what || "A scene"}, photographed.`);
  }

  if (slot.focalRegion && kind !== "texture") {
    lines.push(`Place the main subject in the ${side(slot.focalRegion.x, slot.focalRegion.y)} of the picture.`);
  }
  if (slot.textSafeArea && kind !== "texture") {
    const area = slot.textSafeArea;
    const where = side(area.x + area.width / 2, area.y + area.height / 2);
    lines.push(`Keep the ${where} calm and uncluttered: words will sit there.`);
    checks.push(`The ${where} is quiet enough for words to be read over it.`);
  }
  if (slot.mask && slot.mask !== "rounded") {
    lines.push(`It will be cut to ${slot.mask === "arch" ? "an arch" : `a ${slot.mask}`}, so keep everything that matters well inside the edges.`);
  }
  if (slot.orientation) lines.push(`${slot.orientation[0]!.toUpperCase()}${slot.orientation.slice(1)} composition.`);
  const treatment = slot.treatmentPreset ? TREATMENT_WORDS[slot.treatmentPreset] : undefined;
  if (treatment) lines.push(treatment);
  lines.push("No text, letters or logos.");

  return { kind, aspectRatio: aspect(size.width, size.height), prompt: lines.join(" "), checks };
}

export interface SlideMediaSlot {
  elementId: string;
  name: string;
  slot: MediaSlot;
  width: number;
  height: number;
  /** Whether a picture already sits in the frame. */
  filled: boolean;
}

/**
 * The picture slots on a slide, front to back as drawn, each with whether a
 * picture already fills it: an image directly above the frame in the same box.
 */
export function slideMediaSlots(slide: Slide): SlideMediaSlot[] {
  const out: SlideMediaSlot[] = [];
  const visit = (elements: readonly PresentationElement[]) => {
    elements.forEach((element, index) => {
      const slot = (element as { mediaSlot?: MediaSlot }).mediaSlot;
      if (element.type === "shape" && slot) {
        const box = element.transform;
        const next = elements[index + 1];
        const filled = next?.type === "image" && next.transform.x === box.x && next.transform.y === box.y && next.transform.width === box.width;
        out.push({ elementId: element.id, name: element.name ?? "Picture frame", slot, width: box.width, height: box.height, filled });
      }
      const children = (element as { children?: PresentationElement[] }).children;
      if (children) visit(children);
    });
  };
  visit(slide.elements);
  return out;
}
