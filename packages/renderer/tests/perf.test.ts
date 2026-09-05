import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId } from "@deckastra/presentation-schema";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { buildDocumentScene } from "../src/scene";
import {
  BUDGETS,
  DROPPED_FRAME_ALLOWANCE,
  FrameSampler,
  Stopwatch,
  checkBudget,
  checkFrameBudget,
  formatBudget,
  type PhaseTiming,
} from "../src/perf";

/**
 * Budget checks (doc 04 §31.1).
 *
 * Scene build is the part of the paint budget this package owns; the rest — the
 * browser's commit, image decode — is measured in the app. The assertions here
 * are deliberately loose (a multiple of budget, not the budget itself) because a
 * shared CI runner is not a performance lab, and a flaky perf test gets deleted
 * within a week. What they catch is the regression that matters: an accidental
 * O(n²), which does not creep past a threshold, it blows through it.
 *
 * The measured numbers are printed so the trend is visible in a CI log even
 * while the dashboard (Phase 9) does not exist.
 */

function syntheticDeck(objectCount: number): PresentationDocument {
  const base = loadFixture("technical");
  const doc = JSON.parse(JSON.stringify(base)) as PresentationDocument;
  const template = doc.slides[0]!.elements[0]!;

  const elements = Array.from({ length: objectCount }, (_, i) => ({
    ...(JSON.parse(JSON.stringify(template)) as typeof template),
    id: newId("el"),
    transform: {
      x: (i % 20) * 90,
      y: Math.floor(i / 20) * 60,
      width: 80,
      height: 50,
    },
  }));

  doc.slides = [{ ...doc.slides[0]!, elements }];
  return doc;
}

describe("scene build budget", () => {
  it("builds a 120-object slide well inside the typical-paint budget", () => {
    const doc = syntheticDeck(120);
    // One warm-up: the first build pays for lazy module init and would report a
    // number that says more about the runtime than about the code.
    buildDocumentScene(doc);

    const timings: PhaseTiming[] = [];
    const started = performance.now();
    buildDocumentScene(doc, { timings });
    const result = checkBudget("slidePaintTypical", performance.now() - started);

    console.log(`[perf] ${formatBudget(result)} (scene build only)`);
    expect(result.measuredMs).toBeLessThan(BUDGETS.slidePaintTypical!.ms);
    expect(timings.length).toBeGreaterThan(0);
  });

  it("stays roughly linear from 120 to 480 objects", () => {
    // The regression this is really for. An accidental O(n²) — a lookup that
    // walks the slide per element, say — shows up here as a 16x, not a 4x.
    const small = syntheticDeck(120);
    const large = syntheticDeck(480);
    buildDocumentScene(small);
    buildDocumentScene(large);

    const time = (doc: PresentationDocument): number => {
      const started = performance.now();
      for (let i = 0; i < 3; i += 1) buildDocumentScene(doc);
      return (performance.now() - started) / 3;
    };

    const smallMs = time(small);
    const largeMs = time(large);
    const growth = largeMs / Math.max(smallMs, 0.01);

    console.log(`[perf] 120 objects ${smallMs.toFixed(1)}ms, 480 objects ${largeMs.toFixed(1)}ms (${growth.toFixed(1)}x for 4x the objects)`);
    expect(growth).toBeLessThan(10);
  });

  it("builds a 300-object slide inside the heavy-paint budget", () => {
    const doc = syntheticDeck(300);
    buildDocumentScene(doc);

    const started = performance.now();
    buildDocumentScene(doc);
    const result = checkBudget("slidePaintHeavy", performance.now() - started);

    console.log(`[perf] ${formatBudget(result)} (scene build only)`);
    expect(result.withinBudget).toBe(true);
  });
});

describe("frame sampling", () => {
  it("reports percentiles and the worst frame, not an average", () => {
    // A drag that is smooth except for one 90ms stall feels broken, and a mean
    // hides exactly that.
    const sampler = new FrameSampler();
    for (let i = 0; i < 99; i += 1) sampler.record(8);
    sampler.record(90);

    const stats = sampler.stats()!;
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(8);
    // Nearest-rank: one bad frame in a hundred is, correctly, not the 99th
    // percentile. `worst` is what surfaces it, which is why it is reported.
    expect(stats.p99).toBe(8);
    expect(stats.worst).toBe(90);
  });

  it("catches a stall that is frequent enough to feel", () => {
    const sampler = new FrameSampler();
    for (let i = 0; i < 90; i += 1) sampler.record(8);
    for (let i = 0; i < 10; i += 1) sampler.record(45);

    const stats = sampler.stats()!;
    expect(stats.p95).toBe(45);
    expect(stats.p95).toBeGreaterThan(BUDGETS.dragFrame!.ms);
  });

  it("counts the fraction of frames over budget", () => {
    const sampler = new FrameSampler();
    for (let i = 0; i < 8; i += 1) sampler.record(10);
    for (let i = 0; i < 2; i += 1) sampler.record(30);
    expect(sampler.stats()!.overBudget).toBe(0.2);
  });

  it("has nothing to say before it has samples", () => {
    expect(new FrameSampler().stats()).toBeUndefined();
  });

  it("infers the display's cadence rather than assuming 60Hz", () => {
    // The drag budget is judged against the screen the user actually has. A
    // hardcoded 16ms would fail every drag on a 60Hz display and pass every drag
    // on a 144Hz one, which is backwards.
    const sixty = new FrameSampler();
    for (let i = 0; i < 100; i += 1) sixty.record(16.7);
    expect(sixty.stats()!.displayIntervalMs).toBeCloseTo(16.7, 1);

    const oneForty = new FrameSampler();
    for (let i = 0; i < 100; i += 1) oneForty.record(6.9);
    expect(oneForty.stats()!.displayIntervalMs).toBeCloseTo(6.9, 1);
  });

  it("does not mistake one short interval for the display's cadence", () => {
    const sampler = new FrameSampler();
    sampler.record(0.4);
    for (let i = 0; i < 99; i += 1) sampler.record(16.7);
    // Taking the minimum would report 0.4ms and call every frame dropped.
    expect(sampler.stats()!.displayIntervalMs).toBeCloseTo(16.7, 1);
    expect(sampler.stats()!.dropped).toBe(0);
  });
});

describe("the drag budget", () => {
  it("passes a drag that keeps up with a 60Hz display", () => {
    // 16.67ms is what a perfectly smooth drag looks like at 60Hz. Read literally
    // against the spec's "<16ms p95" it would fail, which is why the budget is
    // judged as dropped frames instead.
    const sampler = new FrameSampler();
    for (let i = 0; i < 120; i += 1) sampler.record(16.7);

    const verdict = checkFrameBudget(sampler.stats()!);
    expect(verdict.withinBudget).toBe(true);
    expect(verdict.summary).toContain("60Hz");
    expect(verdict.summary).toContain("0.0% dropped");
  });

  it("fails a drag that drops frames", () => {
    const sampler = new FrameSampler();
    for (let i = 0; i < 80; i += 1) sampler.record(16.7);
    for (let i = 0; i < 20; i += 1) sampler.record(33.4);

    const verdict = checkFrameBudget(sampler.stats()!);
    expect(verdict.dropped).toBeGreaterThan(DROPPED_FRAME_ALLOWANCE);
    expect(verdict.withinBudget).toBe(false);
  });

  it("tolerates ordinary jitter", () => {
    // A frame that runs 20% long is not a dropped frame, and a gate that says it
    // is gets switched off.
    const sampler = new FrameSampler();
    for (let i = 0; i < 100; i += 1) sampler.record(i % 5 === 0 ? 19 : 16.7);
    expect(checkFrameBudget(sampler.stats()!).withinBudget).toBe(true);
  });

  it("holds a 144Hz display to a 144Hz standard", () => {
    const sampler = new FrameSampler();
    for (let i = 0; i < 90; i += 1) sampler.record(6.9);
    for (let i = 0; i < 10; i += 1) sampler.record(13.8);

    // Every one of those intervals is under the spec's literal 16ms, and ten
    // percent of them are dropped frames.
    expect(sampler.stats()!.p95).toBeLessThan(BUDGETS.dragFrame!.ms);
    expect(checkFrameBudget(sampler.stats()!).withinBudget).toBe(false);
  });
});

describe("budgets", () => {
  it("reports how far over, not just whether", () => {
    const result = checkBudget("dragFrame", 32);
    expect(result.withinBudget).toBe(false);
    expect(result.ratio).toBe(2);
    expect(formatBudget(result)).toContain("OVER");
  });

  it("refuses an unknown budget id rather than passing it silently", () => {
    expect(() => checkBudget("nonexistent", 1)).toThrow(/Unknown performance budget/);
  });

  it("times phases separately so a regression names its stage", () => {
    const watch = new Stopwatch();
    watch.mark("a");
    watch.mark("b");
    const report = watch.report();
    expect(report.phases.map((phase) => phase.phase)).toEqual(["a", "b"]);
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
  });
});
