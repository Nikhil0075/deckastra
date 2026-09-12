/**
 * The export adapter contract (doc 04 §32, doc 05 §16).
 *
 * Two ideas hold this together, and the second is the one that has to be
 * structural rather than remembered.
 *
 * **Adapters consume resolved scenes, never the document.** `ExportInput` carries
 * `scenes`, already built by the renderer, so PDF and PPTX cannot disagree about
 * where a thing sits — they are looking at the same numbers the editor drew. An
 * adapter that took the document would re-derive layout, and the first time a
 * measurement differed, the export would quietly stop matching the screen.
 *
 * **A degradation is a value, not a side effect.** Every adapter declares what it
 * cannot do (`ExportCapability`), and the only way to skip or approximate
 * something is to go through `DegradationLedger`, which records it. Doc 04 §32.2
 * says the user sees the report *before* download, not after they have sent the
 * file to a client — and a warning that depends on someone remembering to write
 * it is a warning that eventually is not written.
 */

import type { PresentationDocument } from "@deckastra/presentation-schema";
import type { SlideScene } from "@deckastra/renderer";

export type ExportFormat = "pdf" | "pptx" | "image" | "video" | "html";

/** Doc 04 §32.2, verbatim. */
export interface ExportCapability {
  supportsBlur: boolean;
  supportsMorph: boolean;
  supportsVideo: boolean;
  supportsAnimation: boolean;
  supportsVectorText: boolean;
  supportsInteractivity: boolean;
  maxImageDpi: number;
}

/**
 * What happened to something the target could not represent.
 *
 * `action` is the part that matters to a reader. "Unsupported" tells them
 * nothing; "rasterized" tells them the text in that element is no longer
 * selectable, and "dropped" tells them to look for what is missing.
 */
export interface ExportWarning {
  severity: "info" | "warning";
  slideId: string;
  elementId?: string;
  feature: string;
  action: "flattened" | "rasterized" | "dropped" | "approximated";
  message: string;
}

/** Doc 05 §16. */
export interface ExportReport {
  warnings: ExportWarning[];
  flattenedElements: string[];
  unsupportedFeatures: string[];
  /** Slides actually written, so a range option cannot silently produce fewer. */
  slideCount: number;
  durationMs: number;
  /** Set when any text was measured by estimate rather than by a real browser. */
  metricsEstimated: boolean;
}

export interface ExportInput {
  document: PresentationDocument;
  /** Pre-resolved, one per slide, keyed by slide id (doc 04 §32.1). */
  scenes: Map<string, SlideScene>;
  fontManifest: FontSpec[];
  options: ExportOptions;
  signal?: AbortSignal;
}

export interface FontSpec {
  family: string;
  weights: number[];
  /** False when the face was not available and a fallback was substituted. */
  available: boolean;
}

export interface ExportOptions {
  /** 1 | 2 | 3 for raster targets. Ignored by vector ones. */
  scale?: number;
  /** Slide ids to include. All visible slides when absent. */
  slideIds?: string[];
  includeHiddenSlides?: boolean;
  includeNotes?: boolean;
  /**
   * Which frame of each slide's motion to freeze (doc 04 §32.3).
   *
   * `"final"` is the default and the right one for a deck someone will read.
   * `"initial"` exists for a handout of a click-reveal deck, where the final
   * state gives away every answer at once.
   */
  atTime?: "final" | "initial" | number;
}

export interface ExportResult {
  /** Where the artifact was written. A path or a storage key, adapter's choice. */
  artifactUri: string;
  bytes: number;
  report: ExportReport;
}

export interface ExportAdapter {
  id: ExportFormat;
  capabilities: ExportCapability;
  export(input: ExportInput): Promise<ExportResult>;
}

// ------------------------------------------------------------------ ledger

/**
 * The only way to degrade something.
 *
 * An adapter calls `record` and gets back nothing useful — the point is that it
 * cannot skip a feature without the skip appearing in the report. Doc 04 §32.2's
 * "every degradation is reported" is a property of this object rather than a
 * rule each adapter has to remember.
 *
 * It deduplicates. A blur on forty elements is one line the user can act on;
 * forty lines is a wall they will scroll past.
 */
export class DegradationLedger {
  private readonly warnings: ExportWarning[] = [];
  private readonly seen = new Set<string>();
  private readonly flattened = new Set<string>();
  private readonly features = new Set<string>();
  private estimated = false;

  record(warning: ExportWarning): void {
    this.features.add(warning.feature);

    if (warning.action === "flattened" || warning.action === "rasterized") {
      if (warning.elementId) this.flattened.add(warning.elementId);
    }

    // Deduplicated on what the user would act on — the feature and what happened
    // to it — not on the element, so one line covers forty blurs.
    const key = `${warning.feature}|${warning.action}|${warning.slideId}`;
    if (this.seen.has(key)) return;

    this.seen.add(key);
    this.warnings.push(warning);
  }

  /** Called when a slide's text metrics came from an estimate, not a browser. */
  noteEstimatedMetrics(): void {
    this.estimated = true;
  }

  report(slideCount: number, durationMs: number): ExportReport {
    return {
      // Sorted so the same export twice produces the same report — doc 04 §32.3
      // asks for a byte-stable artifact, and a report that reorders makes two
      // identical exports look different.
      warnings: [...this.warnings].sort(
        (left, right) =>
          left.slideId.localeCompare(right.slideId) ||
          left.feature.localeCompare(right.feature) ||
          left.action.localeCompare(right.action),
      ),
      flattenedElements: [...this.flattened].sort(),
      unsupportedFeatures: [...this.features].sort(),
      slideCount,
      durationMs,
      metricsEstimated: this.estimated,
    };
  }
}

// ------------------------------------------------------------------ helpers

/**
 * The slides an export should contain, in order.
 *
 * Hidden slides are excluded by default (doc 04 §34.2). A `slideIds` option
 * naming a hidden slide includes it: naming a slide is an explicit request, and
 * silently dropping it would be the export refusing an instruction.
 */
export function slidesToExport(
  document: PresentationDocument,
  options: ExportOptions,
): string[] {
  const named = options.slideIds ? new Set(options.slideIds) : undefined;

  return document.slides
    .filter((slide) => {
      if (named) return named.has(slide.id);
      if (options.includeHiddenSlides) return true;
      return slide.hidden !== true;
    })
    .map((slide) => slide.id);
}

/**
 * What a capability set means for one feature, as a warning or nothing.
 *
 * Returning `undefined` for "this is fine" rather than a boolean keeps the call
 * site honest: the adapter passes the result straight to the ledger, so there is
 * no branch in which it forgets to report.
 */
export function degradeIfUnsupported(
  supported: boolean,
  warning: ExportWarning,
): ExportWarning | undefined {
  return supported ? undefined : warning;
}

/** Every font the scenes actually asked for, and whether it was there. */
export function fontManifest(scenes: Iterable<SlideScene>): FontSpec[] {
  const byFamily = new Map<string, FontSpec>();

  for (const scene of scenes) {
    for (const usage of scene.fonts) {
      const existing = byFamily.get(usage.family);
      if (existing) {
        // A family that resolved on one slide and fell back on another has not
        // resolved: the export has to embed or outline for the worst case.
        existing.available = existing.available && usage.resolved;
        continue;
      }
      byFamily.set(usage.family, {
        family: usage.family,
        weights: [],
        available: usage.resolved,
      });
    }
  }

  return [...byFamily.values()].sort((left, right) => left.family.localeCompare(right.family));
}

/** Includes nested text, so reports reflect actual measurement fallbacks. */
export function sceneUsedEstimatedMetrics(scene: SlideScene): boolean {
  const walk = (nodes: SlideScene["nodes"]): boolean => nodes.some((node) =>
    (node.renderPayload.kind === "text" && node.renderPayload.metrics.estimated) ||
    (node.children ? walk(node.children) : false),
  );
  return walk(scene.nodes);
}
