import type { PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { newId } from "@deckastra/presentation-schema";
import { resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";
import {
  buildDocumentScene,
  checkAccessibility,
  checkLayout,
  readableColor,
  type DocumentScene,
  type SceneNode,
  type TextMeasurer,
} from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";
import { compileTimeline } from "@deckastra/animation-engine";
import type { AnimationTrack } from "@deckastra/presentation-schema";

import { altTextFor, altTextProperty, auditAccessibility, needsAltText } from "./accessibility";
import { resizeOperations } from "./resize-operations";
import { resolveColorValue } from "./colors";

/**
 * Design Check (design review, 2026-09-27): everything on a deck an author
 * would want to fix before presenting it, each with the change that fixes it.
 *
 * It reads the scene the canvas already built, so it judges what is drawn —
 * applied font sizes after fit, world boxes after group transforms, the fill
 * painted behind a run of text — rather than what the document says. The
 * findings come from the renderer (`checkLayout`, `checkAccessibility`) and the
 * editor's own alt-text audit; nothing here re-derives geometry.
 *
 * A fix is a list of changes, not operations, so several can be combined into
 * one patch ("Fix all on this slide") by applying them in turn to a working
 * copy: two fixes that move the same box must add up, and two that write into
 * the same missing `typography` object must not both create it.
 */

export type FindingSeverity = "error" | "warning";

export type FindingChange =
  | { elementId: string; property: string; value: unknown }
  | { elementId: string; move: { dx: number; dy: number } }
  /** Make a text box as tall as its words, measured when the fix is applied. */
  | { elementId: string; growToContent: true }
  /** Scale an object down to fit a rectangle, and move it inside it. */
  | { elementId: string; fitInto: { x: number; y: number; width: number; height: number } }
  /** Give an object a new box outright (a diagram's frame fitted to its boxes). */
  | { elementId: string; frame: { x: number; y: number; width: number; height: number } }
  /** Put an opaque card, in the theme's surface colour, behind a text box. */
  | { elementId: string; cardBehind: true };

export interface FindingFix {
  label: string;
  changes: FindingChange[];
}

export interface DesignFinding {
  /** Stable across rebuilds, for React keys and for "fixed" bookkeeping. */
  key: string;
  code: string;
  severity: FindingSeverity;
  slideId: string;
  elementId?: string;
  relatedElementId?: string;
  title: string;
  message: string;
  fix?: FindingFix;
  /** A second choice, where there is a real one (move it, or it is intended). */
  alternative?: FindingFix;
  /**
   * A fix that needs words from the person: the panel asks, and writes what
   * they type to `property` on the object (a picture's description).
   */
  prompt?: { label: string; placeholder: string; property: string };
}

/**
 * Codes a person can dismiss on one object, recorded in its metadata. No dot
 * in the name: `setPropertyDeep` reads a dot as a level.
 */
export const IGNORE_KEY = "designCheckIgnore";

const TITLES: Record<string, string> = {
  W103: "Text does not fit",
  W104: "Outside the safe area",
  W110: "Objects overlap",
  W216: "Text too small",
  W217: "Diagram too small in its frame",
  W218: "Contrast cannot be measured",
  A101: "No alternative text",
  A102: "Low contrast",
  A103: "Reading order",
  W323: "Narration on a click that is gone",
  W325: "Font cannot draw this language",
  THEME: "Theme contrast",
};

export function designCheck(document: PresentationDocument, scene: DocumentScene): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const minTextPx = numberSetting(document, "deckastra.minTextPx");

  for (const slide of scene.slides) {
    const bySlide = document.slides.find((candidate) => candidate.id === slide.slideId);
    if (!bySlide) continue;
    const ignored = (elementId: string | undefined, code: string) => {
      if (!elementId) return false;
      const element = resolveElementById(document, elementId)?.element;
      const list = (element?.metadata as Record<string, unknown> | undefined)?.[IGNORE_KEY];
      return Array.isArray(list) && list.includes(code);
    };
    const push = (finding: Omit<DesignFinding, "key" | "title"> & { title?: string }) => {
      if (ignored(finding.elementId, finding.code)) return;
      const key = `${finding.code}:${finding.slideId}:${finding.elementId ?? "slide"}:${findings.length}`;
      findings.push({ ...finding, key, title: finding.title ?? TITLES[finding.code] ?? finding.code });
    };

    // Overflow first: it is the commonest thing wrong with a slide.
    for (const node of flatten(slide.nodes)) {
      if (node.flags.hidden || !node.flags.overflow || node.renderPayload.kind !== "text") continue;
      push({
        code: "W103",
        severity: "warning",
        slideId: slide.slideId,
        elementId: node.id,
        message: `${nameOf(document, node.id)} runs past the bottom of its box at ${Math.round(node.renderPayload.metrics.appliedFontSize)}px.`,
        // The box grows first: it keeps the size the author chose, and
        // shrinking stops at half that size, which may still not fit.
        fix: grow(node.id),
        alternative: shrink(node.id),
      });
    }

    for (const issue of checkLayout(slide, minTextPx ? { minTextPx } : {})) {
      const id = issue.elementId;
      const detail = issue.detail;
      const base = { code: issue.code, severity: issue.severity === "error" ? "error" : "warning", slideId: slide.slideId, elementId: id, relatedElementId: detail?.kind === "overlap" ? detail.otherId : undefined, message: issue.message } as const;
      if (!id || !detail) {
        push(base);
        continue;
      }
      const ignore: FindingFix = { label: "It's intended", changes: [ignoreChange(document, id, issue.code)] };
      switch (detail.kind) {
        case "overlap": {
          // A move that would carry the object out of the safe area only
          // trades one finding for another, and Fix all then goes back and
          // forth between them. A box that is simply too wide for its gap is
          // made narrower on the side that overlaps instead.
          const narrowed = narrowInstead(document, id, detail.dx, detail.dy);
          push({
            ...base,
            fix: narrowed
              ? { label: detail.dx ? "Make it narrower" : "Make it shorter", changes: [{ elementId: id, frame: narrowed }] }
              : { label: "Move it clear", changes: [{ elementId: id, move: { dx: detail.dx, dy: detail.dy } }] },
            alternative: ignore,
          });
          break;
        }
        case "safeArea":
          push({
            ...base,
            fix: detail.scale && detail.safe
              ? { label: "Shrink it to fit inside", changes: [{ elementId: id, fitInto: detail.safe }] }
              : { label: "Move it inside", changes: [{ elementId: id, move: { dx: detail.dx, dy: detail.dy } }] },
            alternative: ignore,
          });
          break;
        case "smallText":
          push({
            ...base,
            fix: { label: `Make it ${Math.ceil(detail.minimum)}px`, changes: [{ elementId: id, property: "typography.fontSize", value: Math.ceil(detail.minimum) }] },
            alternative: ignore,
          });
          break;
        case "contrast": {
          const choice = readableToken(document, detail.behind);
          // Where the colour lives depends on what the text is: a text box's
          // or a label's own typography, a table's heading colour. Body text
          // in a table and chart labels take the theme's colours, which the
          // Theme panel's Customise view changes for the whole deck.
          const property =
            detail.target === "text" || detail.target === "label" ? "typography.color" : detail.target === "tableHeader" ? "tableStyle.headerColor" : undefined;
          push({
            ...base,
            fix: choice && property ? { label: `Use ${choice.name} text`, changes: [{ elementId: id, property, value: choice.value }] } : undefined,
            alternative: property ? undefined : ignore,
            message: property ? base.message : `${base.message} Change it for the whole deck under Theme, Customise.`,
          });
          break;
        }
        case "contrastUnknown":
          push({
            ...base,
            fix: { label: "Put a card behind it", changes: [{ elementId: id, cardBehind: true }] },
            alternative: { label: "Checked by eye", changes: [ignoreChange(document, id, issue.code)] },
          });
          break;
        case "diagram": {
          const element = resolveElementById(document, id)?.element;
          const pad = 24;
          const frame =
            element && detail.coverage < 0.25
              ? {
                  x: Math.round(element.transform.x + detail.used.x - pad),
                  y: Math.round(element.transform.y + detail.used.y - pad),
                  width: Math.round(detail.used.width + pad * 2),
                  height: Math.round(detail.used.height + pad * 2),
                }
              : undefined;
          push({ ...base, fix: frame ? { label: "Fit the frame to the diagram", changes: [{ elementId: id, frame }] } : undefined, alternative: ignore });
          break;
        }
        case "glyphs": {
          // A face this build ships that draws the script (integration plan 01
          // §3.9). Offered, never applied by Fix all on its own judgement of a
          // brand: it is in `fix` because it is the change that makes the text
          // print, and the person sees which family it names before pressing.
          // A text box and a shape's label both keep their family at `typography.fontFamily`.
          const family = detail.families[0];
          push({
            ...base,
            fix: family ? { label: `Use ${family}`, changes: [{ elementId: id, property: "typography.fontFamily", value: family }] } : undefined,
            alternative: ignore,
          });
          break;
        }
      }
    }

    // Alt text from the editor's own audit, which knows the document's field
    // for it; reading order from the renderer, which knows the visual order.
    for (const element of walk(bySlide.elements)) {
      if (!needsAltText(element) || altTextFor(element)) continue;
      push({
        code: "A101",
        severity: "error",
        slideId: slide.slideId,
        elementId: element.id,
        message: `${nameOf(document, element.id)} has no alternative text, so a screen reader announces nothing.`,
        prompt: { label: "Describe it", placeholder: "What does this show? The finding, not the shape.", property: altTextProperty(element) },
        alternative: { label: "It's decoration", changes: [{ elementId: element.id, property: "semanticRole", value: "decoration" }] },
      });
    }
    for (const issue of checkAccessibility(slide)) {
      if (issue.code !== "A103") continue;
      push({ code: "A103", severity: "warning", slideId: slide.slideId, elementId: issue.elementId, message: issue.message });
    }

    // Narration on a click step the slide no longer has (W323, plan 01 §3.3):
    // kept, and played nowhere. Judged against the compiled timeline, the same
    // one present mode plays; Motion mode's narration panel offers the move.
    const cues = bySlide.narration?.cues ?? [];
    if (cues.length) {
      const steps = compileTimeline(slide, (slide.animations ?? []) as AnimationTrack[]).segments.length;
      const lost = cues.filter((cue) => cue.step >= steps);
      if (lost.length) {
        push({
          code: "W323",
          severity: "warning",
          slideId: slide.slideId,
          message: `${lost.length} narration line${lost.length === 1 ? "" : "s"} belong${lost.length === 1 ? "s" : ""} to click ${lost[0]!.step}, which this slide no longer has. ${lost.length === 1 ? "It is" : "They are"} kept and play nowhere; move ${lost.length === 1 ? "it" : "them"} in Motion › Narration.`,
        });
      }
    }
  }

  for (const issue of auditAccessibility(document)) {
    if (issue.code !== "low-theme-contrast") continue;
    findings.push({
      key: `THEME:${findings.length}`,
      code: "THEME",
      severity: "error",
      slideId: document.slides[0]?.id ?? "",
      title: TITLES.THEME!,
      message: `${issue.message} ${issue.fix}`,
    });
  }
  return findings;
}

/**
 * Every fix that needs no judgement: moves, sizes, colours, fit. Never "it's
 * intended", and never a card behind text on a picture: adding an object to a
 * slide is a design decision, offered one at a time rather than in bulk.
 */
export function safeFixes(findings: readonly DesignFinding[]): FindingFix[] {
  return findings.flatMap((finding) => (finding.fix && finding.code !== "W218" && finding.code !== "W325" ? [finding.fix] : []));
}

/**
 * Every safe fix for `findings`, as one patch, in two rounds: positions and
 * sizes first, then colour, judged again on the moved slide. Contrast depends
 * on what is behind the text, and a move is exactly what changes that — a
 * colour chosen for the card a label sat on is wrong once it has moved off it.
 */
export function fixAllOperations(
  document: PresentationDocument,
  findings: readonly DesignFinding[],
  measurer?: TextMeasurer,
  excludedCodes: readonly string[] = [],
): PatchOperation[] {
  const layout = findings.filter((finding) => finding.fix && finding.code !== "A102" && !excludedCodes.includes(finding.code));
  const slides = new Set(findings.map((finding) => finding.slideId));
  // Moves are judged pair by pair, so three boxes stacked on one spot can be
  // moved onto each other; check again after each pass, a few times at most.
  const first: PatchOperation[] = [];
  let moved = document;
  let pending = layout;
  for (let pass = 0; pass < 5 && pending.length; pass += 1) {
    const operations = fixOperations(moved, safeFixes(pending), measurer);
    if (!operations.length) break;
    first.push(...operations);
    moved = applyPatch(moved, operations).document;
    pending = designCheck(moved, buildDocumentScene(moved, measurer ? { measurer } : {})).filter(
      (finding) => finding.fix && finding.code !== "A102" && !excludedCodes.includes(finding.code) && slides.has(finding.slideId),
    );
  }
  const keys = new Set(findings.filter((finding) => finding.code === "A102").map((finding) => `${finding.slideId}:${finding.elementId}`));
  const again = designCheck(moved, buildDocumentScene(moved, measurer ? { measurer } : {})).filter(
    (finding) => finding.code === "A102" && slides.has(finding.slideId) && (keys.has(`${finding.slideId}:${finding.elementId}`) || layout.some((l) => l.elementId === finding.elementId)),
  );
  return [...first, ...fixOperations(moved, safeFixes(again), measurer)];
}

/**
 * The operations for one or more fixes, as one patch. Each change is written
 * against the document as the previous ones left it.
 */
export function fixOperations(document: PresentationDocument, fixes: readonly FindingFix[], measurer?: TextMeasurer): PatchOperation[] {
  let working = document;
  const operations: PatchOperation[] = [];
  for (const fix of fixes) {
    for (const change of fix.changes) {
      const found = resolveElementById(working, change.elementId);
      if (!found) continue;
      const next: PatchOperation[] =
        "growToContent" in change
          ? growOperations(working, change.elementId, measurer)
          : "fitInto" in change
          ? fitIntoOperations(working, change.elementId, change.fitInto)
          : "frame" in change
          ? (["x", "y", "width", "height"] as const).flatMap((key) =>
              found.element.transform[key] === change.frame[key] ? [] : setPropertyDeep(working, change.elementId, `transform.${key}`, change.frame[key]),
            )
          : "cardBehind" in change
          ? cardBehindOperations(working, change.elementId)
          : "move" in change
          ? [
              ...setPropertyDeep(working, change.elementId, "transform.x", Math.round(found.element.transform.x + change.move.dx)),
              ...setPropertyDeep(working, change.elementId, "transform.y", Math.round(found.element.transform.y + change.move.dy)),
            ]
          : setPropertyDeep(working, change.elementId, change.property, change.value);
      if (next.length === 0) continue;
      working = applyPatch(working, next).document;
      operations.push(...next);
    }
  }
  return operations;
}

// ------------------------------------------------------------------ helpers

/**
 * The box an overlapping object should have instead of being moved, when the
 * move would take it outside the safe area: the overlapping side pulled in by
 * the overlap. Only for top-level, unrotated objects that keep at least 40% of
 * their size; anything else is moved as before.
 */
function narrowInstead(
  document: PresentationDocument,
  elementId: string,
  dx: number,
  dy: number,
): { x: number; y: number; width: number; height: number } | undefined {
  const found = resolveElementById(document, elementId);
  if (!found || found.ancestors.length || found.element.transform.rotation) return undefined;
  const box = found.element.transform;
  const safe = document.viewport.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const moved = { x: box.x + dx, y: box.y + dy };
  const leaves =
    moved.x < safe.left ||
    moved.y < safe.top ||
    moved.x + box.width > document.viewport.width - safe.right ||
    moved.y + box.height > document.viewport.height - safe.bottom;
  if (!leaves) return undefined;
  if (dx && box.width - Math.abs(dx) >= box.width * 0.4) {
    return { x: dx > 0 ? box.x + dx : box.x, y: box.y, width: box.width - Math.abs(dx), height: box.height };
  }
  if (dy && box.height - Math.abs(dy) >= box.height * 0.4) {
    return { x: box.x, y: dy > 0 ? box.y + dy : box.y, width: box.width, height: box.height - Math.abs(dy) };
  }
  return undefined;
}

/** Scale an object uniformly so its box fits `area`, then move it inside. */
function fitIntoOperations(document: PresentationDocument, elementId: string, area: { x: number; y: number; width: number; height: number }): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found) return [];
  const box = found.element.transform;
  const scale = Math.min(1, area.width / box.width, area.height / box.height);
  const width = Math.floor(box.width * scale);
  const height = Math.floor(box.height * scale);
  const x = Math.round(Math.min(Math.max(box.x, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(box.y, area.y), area.y + area.height - height));
  return resizeOperations(document, elementId, { ...box, x, y, width, height });
}

/**
 * An opaque card behind a text box that sits on a picture: the one change that
 * makes its contrast both readable and measurable. In the theme's surface
 * colour, a little larger than the text, directly beneath it in the stack.
 */
function cardBehindOperations(document: PresentationDocument, elementId: string): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found) return [];
  const siblings = found.ancestors.length
    ? ((found.ancestors[found.ancestors.length - 1] as { children?: PresentationElement[] }).children ?? [])
    : found.slide.elements;
  const index = siblings.findIndex((element) => element.id === elementId);
  const pad = 16;
  const box = found.element.transform;
  const card = {
    id: newId("el"),
    type: "shape",
    shape: "rectangle",
    name: "Card behind text",
    transform: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2, ...(box.rotation ? { rotation: box.rotation } : {}) },
    style: { fill: { type: "solid", color: "token:colors.surface" }, cornerRadius: 12 },
  } as unknown as PresentationElement;
  const parent = found.path.slice(0, found.path.lastIndexOf("/"));
  return [{ op: "add", path: `${parent}/${Math.max(0, index)}`, value: card }];
}

const shrink = (elementId: string): FindingFix => ({ label: "Shrink text to fit", changes: [{ elementId, property: "fit", value: "shrinkToFit" }] });
const grow = (elementId: string): FindingFix => ({ label: "Make the box taller", changes: [{ elementId, growToContent: true }] });

/**
 * The height a text box needs for its words at the size it has: measured by
 * laying it out once with `autoHeight`, the same measurement the canvas uses.
 */
function growOperations(document: PresentationDocument, elementId: string, measurer?: TextMeasurer): PatchOperation[] {
  const found = resolveElementById(document, elementId);
  if (!found || found.element.type !== "text") return [];
  const probe = applyPatch(document, setPropertyDeep(document, elementId, "fit", "autoHeight")).document;
  const slide = probe.slides.find((candidate) => candidate.id === found.slide.id);
  if (!slide) return [];
  const scene = buildDocumentScene({ ...probe, slides: [slide] }, measurer ? { measurer } : {});
  const node = flatten(scene.slides[0]?.nodes ?? []).find((candidate) => candidate.id === elementId);
  if (!node || node.renderPayload.kind !== "text") return [];
  const height = Math.ceil(node.renderPayload.metrics.height + 8);
  if (height <= found.element.transform.height) return [];
  return setPropertyDeep(document, elementId, "transform.height", height);
}

function ignoreChange(document: PresentationDocument, elementId: string, code: string): FindingChange {
  const element = resolveElementById(document, elementId)?.element;
  const current = (element?.metadata as Record<string, unknown> | undefined)?.[IGNORE_KEY];
  const list = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
  return { elementId, property: `metadata.${IGNORE_KEY}`, value: [...new Set([...list, code])] };
}

/** The theme colour that reads on `behind`, kept as a token so it follows the theme. */
function readableToken(document: PresentationDocument, behind: string): { name: string; value: string } | undefined {
  const candidates = [
    { name: "text", value: "token:colors.foreground" },
    { name: "background", value: "token:colors.background" },
    { name: "surface", value: "token:colors.surface" },
    { name: "white", value: "#FFFFFF" },
    { name: "black", value: "#111111" },
  ].flatMap((candidate) => {
    const resolved = resolveColorValue(document, candidate.value);
    return resolved ? [{ ...candidate, resolved }] : [];
  });
  const chosen = readableColor(behind, candidates.map((candidate) => candidate.resolved));
  return candidates.find((candidate) => candidate.resolved === chosen);
}

function numberSetting(document: PresentationDocument, key: string): number | undefined {
  const value = (document.theme.extensions as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && value > 0 ? value : undefined;
}

function nameOf(document: PresentationDocument, elementId: string): string {
  const element = resolveElementById(document, elementId)?.element;
  if (!element) return "This object";
  return element.name?.trim() ? `"${element.name.trim()}"` : `This ${element.type}`;
}

function flatten(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (list: SceneNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

function* walk(elements: readonly PresentationElement[]): Generator<PresentationElement> {
  for (const element of elements) {
    yield element;
    const children = (element as { children?: PresentationElement[] }).children;
    if (Array.isArray(children)) yield* walk(children);
  }
}
