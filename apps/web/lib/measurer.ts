"use client";

import { createDomMeasurer, type TextMeasurer } from "@deckastra/renderer";

/**
 * The browser's text measurer, shared by every scene build in the app.
 *
 * One instance, because the measurer owns a cache and an off-screen host
 * element; creating one per scene build would throw the cache away on every
 * keystroke and add a DOM node each time.
 *
 * `undefined` during server rendering, where there is no document. The scene
 * builder falls back to the estimator in that case, which is correct — the
 * server has no fonts to measure against, and a guess made against the wrong
 * fonts is worse than a guess that admits it is one.
 */

let cached: TextMeasurer | undefined;
let attempted = false;

export function browserMeasurer(): TextMeasurer | undefined {
  if (!attempted) {
    attempted = true;
    cached = createDomMeasurer();
  }
  return cached;
}
