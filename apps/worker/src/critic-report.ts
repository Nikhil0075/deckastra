import { validateLayout, type LayoutValidation } from "@deckastra/layout-engine";
import {
  accessibilityReport,
  validateScene,
  type AccessibilityIssue,
  type DocumentScene,
  type SceneNode,
  type SemanticIssue,
  type SlideScene,
} from "@deckastra/renderer";

export interface CriticSlideSignals {
  slideId: string;
  layout: LayoutValidation;
  density: {
    occupiedAreaRatio: number;
    textCharacters: number;
    visibleElements: number;
  };
  alignment: {
    alignedElements: number;
    unalignedElementIds: string[];
    tolerance: number;
  };
  semanticIssues: SemanticIssue[];
  accessibilityIssues: AccessibilityIssue[];
}

export interface CriticRenderReport {
  version: 1;
  documentId: string;
  fontDigest: string;
  slides: CriticSlideSignals[];
  totals: {
    overflow: number;
    overlaps: number;
    outOfBounds: number;
    lowContrast: number;
    accessibilityErrors: number;
    missingFonts: number;
  };
}

/**
 * Facts extracted from the exact resolved scene used for PNG/PDF output.
 * The report deliberately contains no pass/fail verdict: deterministic code
 * measures the render and the Critic decides whether those facts matter.
 */
export function buildCriticReport(scene: DocumentScene): CriticRenderReport {
  const semantic = validateScene(scene);
  const accessibility = accessibilityReport(scene.slides);
  const slides = scene.slides.map((slide) =>
    slideSignals(
      slide,
      semantic.filter((issue) => issue.slideId === slide.slideId || !issue.slideId),
      accessibility.issues.filter((issue) => issue.slideId === slide.slideId),
    ),
  );

  return {
    version: 1,
    documentId: scene.documentId,
    fontDigest: scene.fontDigest,
    slides,
    totals: {
      overflow: slides.reduce((sum, slide) => sum + slide.layout.overflowCount, 0),
      overlaps: slides.reduce((sum, slide) => sum + slide.layout.overlapCount, 0),
      outOfBounds: slides.reduce((sum, slide) => sum + slide.layout.outOfBoundsIds.length, 0),
      lowContrast: accessibility.issues.filter((issue) => issue.code === "A102").length,
      accessibilityErrors: accessibility.errors,
      missingFonts: semantic.filter((issue) => issue.code === "W250").length,
    },
  };
}

function slideSignals(
  slide: SlideScene,
  semanticIssues: SemanticIssue[],
  accessibilityIssues: AccessibilityIssue[],
): CriticSlideSignals {
  const nodes = flatten(slide.nodes).filter((node) => !node.flags.hidden);
  const safe = slide.safeArea;
  const layout = validateLayout({
    elements: nodes.map((node) => ({
      id: node.id,
      bounds: node.bounds,
      semanticRole: node.semanticRole,
      hasFill: Boolean(node.resolvedStyle.fill),
      overflow: node.flags.overflow,
      hidden: node.flags.hidden,
      fontSize:
        node.renderPayload.kind === "text"
          ? node.renderPayload.metrics.appliedFontSize
          : undefined,
    })),
    slide: { x: 0, y: 0, width: slide.width, height: slide.height },
    safeArea: safe
      ? {
          x: safe.left,
          y: safe.top,
          width: Math.max(0, slide.width - safe.left - safe.right),
          height: Math.max(0, slide.height - safe.top - safe.bottom),
        }
      : undefined,
  });

  const slideArea = Math.max(1, slide.width * slide.height);
  const occupied = nodes.reduce(
    (sum, node) => sum + Math.max(0, node.bounds.width) * Math.max(0, node.bounds.height),
    0,
  );
  const textCharacters = nodes.reduce((sum, node) => {
    if (node.renderPayload.kind !== "text") return sum;
    return sum + node.renderPayload.blocks.reduce(
      (blockSum, block) => blockSum + block.spans.reduce((spanSum, span) => spanSum + span.text.length, 0),
      0,
    );
  }, 0);

  return {
    slideId: slide.slideId,
    layout,
    density: {
      occupiedAreaRatio: round(Math.min(1, occupied / slideArea)),
      textCharacters,
      visibleElements: nodes.length,
    },
    alignment: alignmentSignals(nodes),
    semanticIssues,
    accessibilityIssues,
  };
}

const ALIGNMENT_TOLERANCE = 2;

function alignmentSignals(nodes: SceneNode[]): CriticSlideSignals["alignment"] {
  if (nodes.length < 2) {
    return { alignedElements: nodes.length, unalignedElementIds: [], tolerance: ALIGNMENT_TOLERANCE };
  }

  const edges = nodes.map((node) => [
    node.bounds.x,
    node.bounds.x + node.bounds.width / 2,
    node.bounds.x + node.bounds.width,
    node.bounds.y,
    node.bounds.y + node.bounds.height / 2,
    node.bounds.y + node.bounds.height,
  ]);
  const unalignedElementIds = nodes
    .filter((_, index) =>
      !edges[index]!.some((edge, dimension) =>
        edges.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index && Math.abs(candidate[dimension]! - edge) <= ALIGNMENT_TOLERANCE,
        ),
      ),
    )
    .map((node) => node.id);

  return {
    alignedElements: nodes.length - unalignedElementIds.length,
    unalignedElementIds,
    tolerance: ALIGNMENT_TOLERANCE,
  };
}

function flatten(nodes: SceneNode[]): SceneNode[] {
  const result: SceneNode[] = [];
  const visit = (items: SceneNode[]): void => {
    for (const node of items) {
      result.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return result;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
