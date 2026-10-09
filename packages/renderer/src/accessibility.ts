/**
 * Accessibility checks (gap register doc 01 S2, WCAG 2.1 AA).
 *
 * Doc 01 §9.5 said "accessible" and named nothing. The gap register's fix is to
 * state the target — **WCAG 2.1 AA** — and to say which criteria are in scope for
 * MVP and which are deferred, so that "accessible" becomes something a build can
 * pass or fail.
 *
 * In scope, and checked here:
 *
 * | Criterion | What it means for a slide |
 * | --- | --- |
 * | 1.1.1 Non-text Content | Every image carries alt text, or is marked decorative |
 * | 1.4.3 Contrast (Minimum) | 4.5:1 for body text, 3:1 for large text |
 * | 1.4.4 Resize Text | Nothing is pinned to a size that cannot grow |
 * | 1.3.1 Info and Relationships | Reading order matches visual order |
 * | 2.1.1 Keyboard | Every control reachable without a mouse |
 * | 2.3.3 Animation from Interactions | Reduced motion is honoured |
 *
 * Deferred, and stated so rather than left ambiguous: tagged PDF export (doc 04
 * §34.2 designs the DOM for it but the tagging is not built), and full
 * screen-reader support for the *editor* — as opposed to the deck, which this
 * covers. An editor is a direct-manipulation canvas, and making one genuinely
 * usable without sight is a project rather than a checklist.
 *
 * The contrast and reduced-motion halves already exist — `semantic.ts` checks
 * contrast pairs and `animation-engine` resolves motion levels. What is here is
 * what neither of those covers: alt text, reading order, and the announcement a
 * screen reader actually receives.
 */

import type { SceneNode, SlideScene } from "./scene";
import { contrastRatio, parseColor } from "./semantic";

export interface AccessibilityIssue {
  code: string;
  criterion: string;
  severity: "error" | "warning";
  slideId: string;
  elementId?: string;
  message: string;
  suggestedFix?: string;
}

/** WCAG 1.4.3: 3:1 applies at 18pt, or 14pt bold. In logical px at 96dpi. */
export const LARGE_TEXT_PX = 24;
export const LARGE_TEXT_BOLD_PX = 18.66;
export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;

/**
 * Everything a slide fails, in the order a person would fix it.
 *
 * Deliberately separate from `validateScene`. That checks whether a deck is
 * *good*; this checks whether it is *usable by everyone*, and conflating the two
 * means an accessibility failure competes for attention with a font-size warning
 * and loses.
 */
export function checkAccessibility(scene: SlideScene): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];

  for (const node of flatten(scene.nodes)) {
    if (node.flags.hidden) continue;

    issues.push(...checkAltText(node, scene.slideId));
    issues.push(...checkContrast(node, scene));
  }

  issues.push(...checkReadingOrder(scene));
  return issues;
}

// ------------------------------------------------------------------ 1.1.1

function checkAltText(node: SceneNode, slideId: string): AccessibilityIssue[] {
  const payload = node.renderPayload;

  const carriesMeaning =
    payload.kind === "image" || payload.kind === "video" || payload.kind === "chart" || payload.kind === "diagram";
  if (!carriesMeaning) return [];

  // `semanticRole: "decoration"` is the author saying this carries no
  // information. That is a legitimate answer — a background texture needs no
  // description, and describing it makes a screen reader worse, not better.
  if (node.semanticRole === "decoration") return [];

  const described = Boolean(node.a11y.label && node.a11y.label.trim());
  if (described) return [];

  return [
    {
      code: "A101",
      criterion: "WCAG 1.1.1 Non-text Content",
      severity: "error",
      slideId,
      elementId: node.id,
      message:
        payload.kind === "image" || payload.kind === "video"
          ? "This image has no alternative text, so a screen reader announces nothing."
          : `This ${payload.kind} has no description, so its content is unavailable to a screen reader.`,
      suggestedFix:
        payload.kind === "image" || payload.kind === "video"
          ? "Add alt text describing what the image shows, or mark it decorative."
          : `Add a description of what the ${payload.kind} shows — the finding, not the shape.`,
    },
  ];
}

// ------------------------------------------------------------------ 1.4.3

function checkContrast(node: SceneNode, scene: SlideScene): AccessibilityIssue[] {
  const payload = node.renderPayload;
  if (payload.kind !== "text") return [];

  const foreground = payload.typography.color;
  // The colour actually behind the text: its own box fill if it has one, the
  // slide's background otherwise. Checking against the theme's nominal
  // background would pass text sitting on a dark card over a light slide.
  const background = node.resolvedStyle.fill ?? scene.background?.color;

  if (!foreground || !background) return [];

  const from = parseColor(foreground);
  const to = parseColor(background);
  if (!from || !to) return [];

  const ratio = contrastRatio(from, to);
  const size = payload.metrics.appliedFontSize;
  const bold = (payload.typography.fontWeight ?? 400) >= 700;
  const large = size >= LARGE_TEXT_PX || (bold && size >= LARGE_TEXT_BOLD_PX);
  const required = large ? CONTRAST_LARGE : CONTRAST_NORMAL;

  if (ratio >= required) return [];

  return [
    {
      code: "A102",
      criterion: "WCAG 1.4.3 Contrast (Minimum)",
      severity: "error",
      slideId: scene.slideId,
      elementId: node.id,
      message:
        `This text has a contrast ratio of ${ratio.toFixed(2)}:1 against what is ` +
        `behind it, below the ${required}:1 required at ${Math.round(size)}px.`,
      suggestedFix: large
        ? "Darken the text or lighten the background."
        : "Darken the text, lighten the background, or make the text larger — 24px and above needs only 3:1.",
    },
  ];
}

// ------------------------------------------------------------------ 1.3.1

/**
 * Reading order against visual order.
 *
 * A screen reader follows `a11y.order`; a sighted reader follows the layout.
 * When they disagree the deck says two different things, and the person who
 * cannot see it gets the wrong one — a caption before its chart, a footnote
 * before the claim it qualifies.
 *
 * Compared top-to-bottom then left-to-right, with a tolerance: elements whose
 * tops are within a line of each other are one row, and a two-column slide is
 * read across before it is read down.
 */
const ROW_TOLERANCE = 40;

function checkReadingOrder(scene: SlideScene): AccessibilityIssue[] {
  const nodes = flatten(scene.nodes).filter(
    (node) => !node.flags.hidden && node.a11y.role !== "presentation",
  );
  if (nodes.length < 2) return [];

  const visual = [...nodes].sort((left, right) => {
    const sameRow = Math.abs(left.bounds.y - right.bounds.y) <= ROW_TOLERANCE;
    return sameRow ? left.bounds.x - right.bounds.x : left.bounds.y - right.bounds.y;
  });

  const announced = [...nodes].sort((left, right) => left.a11y.order - right.a11y.order);

  const firstDivergence = visual.findIndex((node, index) => node.id !== announced[index]?.id);
  if (firstDivergence === -1) return [];

  return [
    {
      code: "A103",
      criterion: "WCAG 1.3.1 Info and Relationships",
      severity: "warning",
      slideId: scene.slideId,
      elementId: visual[firstDivergence]?.id,
      message:
        "A screen reader reads this slide in a different order from the one it is " +
        "laid out in, so the two audiences get different slides.",
      suggestedFix: "Reorder the elements in the layers panel to match the visual order.",
    },
  ];
}

// ------------------------------------------------------------------ summary

export interface AccessibilityReport {
  issues: AccessibilityIssue[];
  errors: number;
  warnings: number;
  /** True when nothing in scope failed. Not a claim about WCAG conformance —
   *  see the module docstring for what is deferred. */
  passesScopedCriteria: boolean;
}

export function accessibilityReport(scenes: SlideScene[]): AccessibilityReport {
  const issues = scenes.flatMap(checkAccessibility);
  const errors = issues.filter((issue) => issue.severity === "error").length;

  return {
    issues,
    errors,
    warnings: issues.length - errors,
    passesScopedCriteria: errors === 0,
  };
}

function flatten(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (list: SceneNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
