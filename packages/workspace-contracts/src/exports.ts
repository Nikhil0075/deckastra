export type ExportKind = "pdf" | "pptx";

/**
 * One degradation, as the ledger recorded it (doc 04 §32.2).
 *
 * `action` names what happened rather than saying "unsupported", because a reader
 * can act on "flattened" and can do nothing with "unsupported".
 */
export interface ExportWarning {
  severity: "info" | "warning";
  slideId: string;
  elementId?: string;
  feature: string;
  action: "flattened" | "rasterized" | "dropped" | "approximated";
  message: string;
}

export interface ExportReport {
  warnings: ExportWarning[];
  flattenedElements: string[];
  unsupportedFeatures: string[];
  slideCount: number;
  durationMs: number;
  /** True when any text fell back to the estimator rather than a browser measurement. */
  metricsEstimated: boolean;
}

export interface ExportJob {
  id: string;
  kind: ExportKind;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
  filename: string | null;
  bytes: number;
  report: ExportReport | null;
  error: string | null;
  /** The deck version this file is of — what the export pinned when it started. */
  version_id?: string | null;
}

export interface ExportRequest {
  kind: ExportKind;
  include_notes: boolean;
  /** Which frame animations resolve to. `final` by default (doc 04 §41.1). */
  at_time: "final" | "initial";
  idempotency_key: string;
  /**
   * The version to export. When given and the stored head is different, the
   * service refuses with 409 rather than exporting a deck the caller never saw.
   */
  expected_version_id?: string;
  /**
   * The language to export (integration plan 01 §3.10): one of the deck's
   * overlays, or absent for its own. The service refuses a language the deck
   * does not have rather than exporting the original under its name.
   */
  locale?: string;
}
