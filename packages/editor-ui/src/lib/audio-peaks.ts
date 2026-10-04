import { useEffect, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { waveformPeaks } from "@deckastra/renderer";

import { audioContext } from "./audio-player";

/**
 * Waveforms for the deck's own recordings and sound files, drawn on the Audio
 * lanes (integration plan 01 §3.6).
 *
 * Read from the bytes, not from anything stored beside them. The service keeps
 * the peaks it measured at upload, but the document does not carry them and a
 * second copy of a file's shape is one that can disagree with the file — a
 * voiced take replaced in place would keep the old drawing. Decoding the take
 * the player is about to play anyway is the one answer that cannot.
 *
 * Three rules, the same as `useAssetUrls` for the same reasons:
 * - **The effect depends on a string**, never on the document's arrays, which
 *   are fresh on every render.
 * - **A failure is remembered** as `null`, so a missing file or a browser with
 *   no audio decoder is asked once, not on every render.
 * - **Results are cached by asset id for the session.** An asset id names one
 *   file forever, so its shape never needs working out twice.
 */

export const LANE_PEAKS = 32;

const cache = new Map<string, number[] | null>();
const inflight = new Map<string, Promise<number[] | null>>();

/** The shape of any audio the browser can decode, as `buckets` peaks in 0..1. */
export async function peaksOfBlob(blob: Blob, buckets = LANE_PEAKS): Promise<number[] | null> {
  const context = audioContext();
  if (!context) return null;
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  if (!decoded.length) return null;
  const peaks = waveformPeaks(decoded.getChannelData(0), buckets);
  // Scaled to the loudest bucket, so a quiet recording still reads as speech
  // rather than a flat line; the lane is about where the words are, not volume.
  const top = Math.max(...peaks);
  return top > 0 ? peaks.map((peak) => Math.round((peak / top) * 1000) / 1000) : peaks;
}

/** For tests: forget every shape worked out so far. */
export function resetRecordedPeaks(): void {
  cache.clear();
  inflight.clear();
}

export function useRecordedPeaks(
  document: PresentationDocument,
  assetIds: readonly string[],
  load: ((storageKey: string) => Promise<Blob>) | undefined,
): ReadonlyMap<string, number[]> {
  const keys = new Map<string, string>();
  for (const id of assetIds) {
    const entry = document.assets.find((asset) => asset.id === id);
    if (entry?.storageKey) keys.set(id, entry.storageKey);
  }
  const signature = [...keys.entries()]
    .map(([id, key]) => `${id}:${key}`)
    .sort()
    .join("|");
  const [, setSettled] = useState(0);

  useEffect(() => {
    if (!load || !signature) return;
    let live = true;
    for (const pair of signature.split("|")) {
      const split = pair.indexOf(":");
      const id = pair.slice(0, split);
      const key = pair.slice(split + 1);
      if (cache.has(id)) continue;
      let pending = inflight.get(id);
      if (!pending) {
        pending = load(key)
          .then((blob) => peaksOfBlob(blob))
          .catch(() => null)
          .then((peaks) => {
            cache.set(id, peaks);
            inflight.delete(id);
            return peaks;
          });
        inflight.set(id, pending);
      }
      void pending.then(() => {
        if (live) setSettled((count) => count + 1);
      });
    }
    return () => {
      live = false;
    };
  }, [signature, load]);

  const out = new Map<string, number[]>();
  for (const id of keys.keys()) {
    const peaks = cache.get(id);
    if (peaks) out.set(id, peaks);
  }
  return out;
}
