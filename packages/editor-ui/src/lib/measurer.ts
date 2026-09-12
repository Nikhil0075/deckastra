"use client";

import { createDomMeasurer, type TextMeasurer } from "@deckastra/renderer";
import { useMemo, useSyncExternalStore } from "react";

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

export function browserMeasurer(): TextMeasurer | undefined {
  // A server/no-body lookup must not permanently poison the browser singleton.
  if (!cached) cached = createDomMeasurer();
  return cached;
}

let revision = 0;
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;
const snapshot = () => revision;
const serverSnapshot = () => 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopListening && typeof document !== "undefined") {
    // Register the measurer's invalidation before our React notification.
    browserMeasurer();
    const fonts = document.fonts;
    let active = true;
    const changed = () => {
      if (!active) return;
      revision += 1;
      for (const notify of listeners) notify();
    };
    fonts?.addEventListener?.("loadingdone", changed);
    fonts?.addEventListener?.("loadingerror", changed);
    void fonts?.ready?.then(changed, changed);
    stopListening = () => {
      active = false;
      fonts?.removeEventListener?.("loadingdone", changed);
      fonts?.removeEventListener?.("loadingerror", changed);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
}

/** A stable measurer identity until fonts settle/change, so memoized scenes
 * rebuild. The underlying measurement cache/DOM host remains shared. */
export function useBrowserMeasurer(): TextMeasurer | undefined {
  const fontRevision = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return useMemo(() => {
    const measurer = browserMeasurer();
    return measurer ? { measure: (request) => measurer.measure(request) } : undefined;
  }, [fontRevision]);
}
