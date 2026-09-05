import { describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene, flattenScene, measurerFor } from "@deckastra/renderer";
import type { TextMeasurementService } from "@deckastra/layout-engine";

/**
 * The measured text path.
 *
 * jsdom does not do real font layout — `getClientRects` returns zeros — so this
 * cannot check that measured numbers match a browser's. What it *can* check, and
 * what actually breaks, is the wiring: that a supplied measurer is the one the
 * scene build uses, that its answers reach the payload, and that the shrink
 * search behaves. A fake service makes all three observable, which a real
 * measurer in jsdom would not.
 *
 * The claim that measuring beats estimating is checked where it is checkable —
 * in the pixel suite, against real Chromium.
 */

/** A service with known, deliberately un-estimator-like answers. */
function fakeService(perLineHeight: number): TextMeasurementService & { calls: number } {
  const service = {
    calls: 0,
    fontRevision: 0,
    measure(input: { text: string; typography: { fontSize: number }; maxWidth: number }) {
      return service.measureBatch([input])[0]!;
    },
    measureBatch(inputs: readonly { text: string; typography: { fontSize: number } }[]) {
      service.calls += inputs.length;
      return inputs.map((input) => {
        // Deliberately simple and size-proportional, so a shrink search converges.
        const lineCount = Math.max(1, Math.ceil(input.text.length / 20));
        return {
          text: input.text,
          width: input.text.length * input.typography.fontSize * 0.5,
          height: lineCount * input.typography.fontSize * (perLineHeight / 100),
          lineCount,
          lines: [],
          firstBaseline: 0,
          lastBaseline: 0,
          overflow: false,
          usedFontFamily: "FakeFace",
          estimated: false,
        };
      });
    },
  };
  return service as unknown as TextMeasurementService & { calls: number };
}

const technical = loadFixture("technical");

describe("the measured text path", () => {
  it("uses the measurer the caller supplied", () => {
    const service = fakeService(130);
    buildDocumentScene(technical, { measurer: measurerFor(service) });
    expect(service.calls).toBeGreaterThan(0);
  });

  it("marks measured metrics as not estimated, so exports can trust them", () => {
    const scene = buildDocumentScene(technical, { measurer: measurerFor(fakeService(130)) });
    const text = flattenScene(scene.slides[0]!).find(
      (node) => node.renderPayload.kind === "text",
    )!;

    expect(text.renderPayload.kind).toBe("text");
    if (text.renderPayload.kind !== "text") return;
    expect(text.renderPayload.metrics.estimated).toBe(false);
    expect(text.flags.metricsEstimated).toBe(false);
  });

  it("falls back to the estimator when no measurer is supplied", () => {
    const scene = buildDocumentScene(technical);
    const text = flattenScene(scene.slides[0]!).find(
      (node) => node.renderPayload.kind === "text",
    )!;

    if (text.renderPayload.kind !== "text") throw new Error("expected text");
    // Flagged rather than silently passed off as measured, so an export knows to
    // re-measure instead of trusting a guess (doc 04 §6.4).
    expect(text.renderPayload.metrics.estimated).toBe(true);
  });

  it("shrinks to fit and quantizes the result the same way the estimator does", () => {
    // A document that shrank to 93px in Node must not shrink to 93.0001 in the
    // browser and produce a spurious diff.
    const scene = buildDocumentScene(technical, { measurer: measurerFor(fakeService(400)) });
    const headline = flattenScene(scene.slides[0]!).find(
      (node) => node.semanticRole === "headline",
    )!;

    if (headline.renderPayload.kind !== "text") throw new Error("expected text");
    const size = headline.renderPayload.metrics.appliedFontSize;

    expect(size).toBeLessThan(96);
    expect(Number.isInteger(size * 4)).toBe(true);
  });

  it("bounds the shrink search rather than looping until it fits", () => {
    // A fixed iteration count is what keeps the pipeline deterministic
    // (doc 02 §2.1); an unbounded search on pathological input would not return.
    const service = fakeService(4000);
    buildDocumentScene(
      { ...technical, slides: [technical.slides[0]!] },
      { measurer: measurerFor(service) },
    );
    expect(service.calls).toBeLessThan(200);
  });
});
