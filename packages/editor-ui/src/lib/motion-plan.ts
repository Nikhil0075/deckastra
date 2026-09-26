/**
 * Planning a slide's motion in roles, in the editor (editor Phase 7, Figma
 * frame "agent-planned motion").
 *
 * The planner is the product's own — `motion.py`, the one agents reach over
 * MCP — asked for a dry run: it answers with operations and writes nothing. The
 * person sees the plan, measured, and applies it as their own edit. Three things
 * here make that honest:
 *
 * - **The total is measured, not quoted.** The plan is applied to a copy and
 *   compiled by the same engine present mode plays; the budget read back is the
 *   one the timeline enforces (doc 04 §24.2).
 * - **A plan is for the slide it was planned against.** It names element ids
 *   and replaces the slide's tracks (or its transition) whole, so if the slide
 *   changed since, applying it would animate a slide nobody planned. The
 *   fingerprint check refuses that and asks for a new plan.
 * - **Roles, never ids or milliseconds.** What the person chooses is the same
 *   vocabulary an agent speaks, so a plan written here survives a re-layout.
 */

import {
  canonicalize,
  walkElements,
  type PatchOperation,
  type PresentationDocument,
  type Slide,
} from "@deckastra/presentation-schema";
import { applyPatch } from "@deckastra/transactions";
import { buildDocumentScene } from "@deckastra/renderer";
import { compileTimeline } from "@deckastra/animation-engine";

import { objectLabel } from "./transition-editing";

export interface RoleCount {
  role: string;
  count: number;
}

/**
 * The semantic roles this slide's top-level elements carry, in document order.
 * Top level only, as the planner reads them: a group's children animate through
 * the group, and a role that exists only inside one would plan to nothing.
 */
export function slideRoles(slide: Slide | undefined): RoleCount[] {
  const counts = new Map<string, number>();
  for (const element of slide?.elements ?? []) {
    const role = (element as { semanticRole?: string }).semanticRole;
    if (!role) continue;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts.entries()].map(([role, count]) => ({ role, count }));
}

/** Roles a morph can carry: on both this slide and the one before it. */
export function carryableRoles(previous: Slide | undefined, slide: Slide | undefined): string[] {
  const before = new Set(slideRoles(previous).map((entry) => entry.role));
  return slideRoles(slide)
    .map((entry) => entry.role)
    .filter((role) => before.has(role));
}

export interface MeasuredPlan {
  after: PresentationDocument | null;
  error: string | null;
  /** The entrance as the timeline will play it, against the theme's budget. */
  budget: { entranceMs: number; limitMs: number; exceeded: boolean } | null;
  /** Tracks the slide ends up with, one line each. */
  tracks: string[];
}

/** Apply a plan to a copy and measure it the way present mode will play it. */
export function measurePlan(
  document: PresentationDocument,
  slideId: string,
  operations: readonly PatchOperation[],
): MeasuredPlan {
  let after: PresentationDocument;
  try {
    after = applyPatch(document, operations).document;
  } catch (error) {
    return {
      after: null,
      error: error instanceof Error ? error.message : "The plan does not apply to this slide.",
      budget: null,
      tracks: [],
    };
  }
  const index = after.slides.findIndex((slide) => slide.id === slideId);
  const slide = after.slides[index];
  if (!slide) return { after, error: `No slide ${slideId}.`, budget: null, tracks: [] };
  // No measurer: timing does not depend on text metrics, and this runs anywhere.
  const scene = buildDocumentScene(after).slides[index]!;
  const timeline = compileTimeline(scene, (slide.animations ?? []) as never);
  // "headline — fadeUp · on click": what moves, how, and when.
  const elements = new Map([...walkElements(slide.elements)].map(({ element }) => [element.id, element]));
  const tracks = (slide.animations ?? []).map((track) => {
    const clip = track.clips[0] as { preset?: string } | undefined;
    const trigger = (track as { trigger?: { type?: string } }).trigger?.type;
    const target = elements.get(track.targetId);
    const who = target ? objectLabel(target) : "an object";
    const line = `${who} — ${clip?.preset ?? "motion"}`;
    return trigger === "click" ? `${line} · on click` : line;
  });
  return { after, error: null, budget: timeline.budget, tracks };
}

/** "Total 2.1s — within the 2.5s budget", or what happened instead. */
export function budgetLine(budget: MeasuredPlan["budget"]): string {
  if (!budget) return "";
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  if (budget.entranceMs === 0) return "Everything is on screen from the first frame.";
  return budget.exceeded
    ? `Total ${seconds(budget.entranceMs)} — over the ${seconds(budget.limitMs)} budget`
    : `Total ${seconds(budget.entranceMs)} — within the ${seconds(budget.limitMs)} budget`;
}

/**
 * What a plan depends on, so a stale one can be refused: the slide without the
 * property the plan replaces, and for a transition the slide before it too,
 * whose elements a morph pairs with.
 */
export function planFingerprint(
  document: PresentationDocument,
  slideId: string,
  replaces: "animations" | "transition",
): string {
  const index = document.slides.findIndex((slide) => slide.id === slideId);
  const strip = (slide: Slide | undefined) => {
    if (!slide) return null;
    const { [replaces]: _replaced, ...rest } = slide as Slide & Record<string, unknown>;
    return rest;
  };
  const parts = [strip(document.slides[index])];
  if (replaces === "transition") parts.push(strip(index > 0 ? document.slides[index - 1] : undefined));
  return JSON.stringify(canonicalize(parts));
}
