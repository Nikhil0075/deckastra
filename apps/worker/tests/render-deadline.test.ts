import { describe, expect, it } from "vitest";

import { RENDER_TIMEOUT_MS, RENDER_TIMEOUT_PER_SLIDE_MS, renderDeadlineFor } from "../src/render";

/**
 * The export deadline has to grow with the deck (item 30).
 *
 * `withPage` wraps the whole export — the lease, the browser starting, every
 * slide's text measurement and the render — and it was bounded by a flat twenty
 * seconds. That is ample for the five-slide fixtures every previous measurement
 * in this repository used, and not enough for sixty slides with photographs:
 * measured on 2026-09-20, the first attempt died on the deadline and the export
 * succeeded only because the job retried into a warm browser.
 *
 * The retry is what kept it invisible. The row said `completed` and carried the
 * failed attempt's error text, which reads like a transient blip rather than a
 * limit nobody had scaled since the fixtures were written.
 */

describe("how long an export may take", () => {
  it("still bounds a small deck the way it always did", () => {
    expect(renderDeadlineFor(1)).toBe(RENDER_TIMEOUT_MS + RENDER_TIMEOUT_PER_SLIDE_MS);
  });

  it("gives a sixty-slide deck more than a five-slide one", () => {
    expect(renderDeadlineFor(60)).toBeGreaterThan(renderDeadlineFor(5));
  });

  it("allows the sixty-slide deck that failed on the flat deadline", () => {
    // The measured export took about 54 seconds on its first, cold attempt.
    // Anything at or under the old flat bound would fail it again.
    expect(renderDeadlineFor(60)).toBeGreaterThan(60_000);
    expect(renderDeadlineFor(60)).toBeGreaterThan(RENDER_TIMEOUT_MS);
  });

  it("is still a bound, not an open door", () => {
    // Its job is to stop a wedged render holding the sole page lease forever.
    // A deck big enough to need ten minutes is a deck this should give up on.
    expect(renderDeadlineFor(60)).toBeLessThan(5 * 60_000);
  });

  it("treats a nonsensical slide count as one slide rather than as no time at all", () => {
    // A zero or a NaN must not produce a deadline of twenty seconds flat — or,
    // worse, one that has already passed.
    for (const count of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderDeadlineFor(count)).toBeGreaterThanOrEqual(
        RENDER_TIMEOUT_MS + RENDER_TIMEOUT_PER_SLIDE_MS,
      );
    }
  });
});
