/**
 * Performance budgets and their instrumentation (doc 04 §31).
 *
 * The budgets are in the spec as a table. A table nobody measures against is a
 * wish, so they are declared here as data and the measuring apparatus sits next
 * to them: a stopwatch for the phases of a scene build, and a frame sampler that
 * reports p95 and p99 rather than an average — a drag that is smooth except for
 * one 90ms stall feels broken, and an average hides exactly that.
 *
 * Nothing here reports anywhere yet. Telemetry is Phase 9 (doc 05 §32); what
 * exists now is the measurement, so that when the dashboard lands it has real
 * numbers to draw and the editor can already show them.
 */

export interface Budget {
  id: string;
  label: string;
  /** Milliseconds. For frame budgets this is the p95. */
  ms: number;
  /** Secondary limit where the spec gives one (frame p99). */
  p99Ms?: number;
}

/** doc 04 §31.1, verbatim. Changing a number here means changing the spec. */
export const BUDGETS: Record<string, Budget> = {
  slidePaintTypical: { id: "slidePaintTypical", label: "Typical slide (≤120 objects) first paint", ms: 250 },
  slidePaintHeavy: { id: "slidePaintHeavy", label: "Heavy slide (300 objects) first paint", ms: 700 },
  dragFrame: { id: "dragFrame", label: "Drag/resize frame time", ms: 16, p99Ms: 24 },
  slideSwitchWarm: { id: "slideSwitchWarm", label: "Slide switch (warm)", ms: 120 },
  slideSwitchCold: { id: "slideSwitchCold", label: "Slide switch (cold)", ms: 400 },
  timelineScrub: { id: "timelineScrub", label: "Timeline scrub frame", ms: 16 },
  thumbnailStrip: { id: "thumbnailStrip", label: "Thumbnail strip, 60 slides", ms: 1000 },
};

/** Beyond this the editor warns; beyond 800 the vector layer should flatten (§31.1). */
export const OBJECT_WARNING_THRESHOLD = 400;
export const OBJECT_FLATTEN_THRESHOLD = 800;

function now(): number {
  // `performance.now` is monotonic and sub-millisecond; `Date.now` is neither,
  // and a frame sampler built on it reports quantised nonsense.
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ---------------------------------------------------------------- stopwatch

export interface PhaseTiming {
  phase: string;
  ms: number;
}

/**
 * Phase timing for one operation.
 *
 * Deliberately cheap enough to leave on: two `performance.now()` calls per
 * phase. An instrument that has to be enabled is an instrument that is off when
 * the regression happens.
 */
export class Stopwatch {
  private started = now();
  private last = this.started;
  private readonly phases: PhaseTiming[] = [];

  mark(phase: string): void {
    const at = now();
    this.phases.push({ phase, ms: Math.round((at - this.last) * 100) / 100 });
    this.last = at;
  }

  get totalMs(): number {
    return Math.round((now() - this.started) * 100) / 100;
  }

  report(): { totalMs: number; phases: PhaseTiming[] } {
    return { totalMs: this.totalMs, phases: [...this.phases] };
  }
}

// ------------------------------------------------------------ frame sampler

export interface FrameStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  /** Frames over the budget's p95, as a fraction. */
  overBudget: number;
}

/**
 * Samples the interval between frames during an interaction.
 *
 * Measures *frame intervals*, not the duration of a handler. A handler that
 * takes 3ms but forces a synchronous layout costs 40ms of frame time, and only
 * the interval sees it — which is exactly the class of bug the drag budget
 * exists to catch.
 */
export class FrameSampler {
  private readonly intervals: number[] = [];
  private previous?: number;
  private running = false;
  private handle?: number;

  start(): void {
    if (this.running || typeof requestAnimationFrame === "undefined") return;
    this.running = true;
    this.previous = undefined;

    const tick = (timestamp: number): void => {
      if (!this.running) return;
      if (this.previous !== undefined) this.intervals.push(timestamp - this.previous);
      this.previous = timestamp;
      this.handle = requestAnimationFrame(tick);
    };

    this.handle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.handle);
    }
    this.handle = undefined;
  }

  reset(): void {
    this.intervals.length = 0;
    this.previous = undefined;
  }

  /** Feed a measured interval directly. For tests, and for callers with their own loop. */
  record(intervalMs: number): void {
    this.intervals.push(intervalMs);
  }

  stats(budget: Budget = BUDGETS.dragFrame!): FrameStats | undefined {
    if (this.intervals.length === 0) return undefined;

    const sorted = [...this.intervals].sort((a, b) => a - b);
    const at = (fraction: number): number => {
      // Nearest-rank, so a 20-sample p95 names a real frame rather than an
      // interpolation between two.
      const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
      return Math.round(sorted[Math.max(0, index)]! * 100) / 100;
    };

    return {
      count: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      worst: Math.round(sorted.at(-1)! * 100) / 100,
      overBudget:
        Math.round((sorted.filter((value) => value > budget.ms).length / sorted.length) * 1000) / 1000,
    };
  }
}

// ------------------------------------------------------------------ budgets

export interface BudgetResult {
  budget: Budget;
  measuredMs: number;
  withinBudget: boolean;
  /** How far over, as a multiple. 1 means exactly at budget. */
  ratio: number;
}

export function checkBudget(budgetId: string, measuredMs: number): BudgetResult {
  const budget = BUDGETS[budgetId];
  if (!budget) throw new Error(`Unknown performance budget "${budgetId}".`);

  return {
    budget,
    measuredMs: Math.round(measuredMs * 100) / 100,
    withinBudget: measuredMs <= budget.ms,
    ratio: Math.round((measuredMs / budget.ms) * 100) / 100,
  };
}

/** One line per budget, for a log or an editor readout. */
export function formatBudget(result: BudgetResult): string {
  return `${result.budget.label}: ${result.measuredMs}ms / ${result.budget.ms}ms ${
    result.withinBudget ? "ok" : `OVER (${result.ratio}x)`
  }`;
}
