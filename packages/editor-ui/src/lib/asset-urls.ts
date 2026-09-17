"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

/**
 * Every storage key a document cites, by asset id.
 *
 * The manifest is the only place a key lives, so an element whose `assetId` has
 * no entry has nothing to resolve — a document problem the renderer already
 * reports rather than something to go and fetch.
 */
export function assetKeysOf(
  document: PresentationDocument | null | undefined,
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const asset of document?.assets ?? []) {
    if (asset.storageKey) byId.set(asset.id, asset.storageKey);
  }
  return byId;
}

/**
 * Turning a deck's assets into something `<img>` can load.
 *
 * `SlideView` has taken a `resolveAssetUrl` prop since the renderer was written
 * and **no caller anywhere passed one**, so every image in the product drew the
 * renderer's labelled gap instead of a picture. The reason it stayed unwired is
 * not an oversight about a prop: it is that the two shells cannot authenticate an
 * image the same way, and there is no one URL that works for both.
 *
 * The desktop's base URL is a path on the renderer's own origin, and the main
 * process injects the bearer as the request passes through the proxy — so an
 * `<img src>` at the blob route simply works, and the page still never learns the
 * token or the loopback port. The web app's base URL is a different origin and
 * its credential is an `Authorization` header, which an `<img>` cannot send: the
 * bytes have to be fetched with the credential and handed over as an object URL.
 *
 * So the client answers `directUrl` where the browser can do it alone, and this
 * hook covers the other case — asynchronously, because a fetch is, while giving
 * components the **synchronous** resolver the renderer's prop requires. A key
 * that has not arrived yet resolves to `undefined`, which is the same thing the
 * renderer already draws a labelled gap for; the re-render when it lands replaces
 * the gap with the picture.
 *
 * Two things here are easy to get wrong and expensive when they are:
 *
 * - **Object URLs are revoked**, on unmount and whenever the set of keys
 *   changes. They pin their blob in memory for the life of the document
 *   otherwise, and a deck of photographs re-opened all day is a leak that looks
 *   like the editor getting slower.
 * - **A failed fetch is remembered**, so a missing or forbidden object is asked
 *   for once rather than on every render. Without that, one broken reference
 *   becomes a request loop for as long as the deck is open.
 */
export function useAssetUrls(
  document: PresentationDocument | null | undefined,
): (assetId: string, storageKey?: string) => string | undefined {
  const client = useWorkspaceClient();

  // Derived every render — it is a walk over a handful of manifest entries — and
  // then reduced to a **string** that the effect depends on.
  //
  // Depending on the array or the Map is what a first version did, and it is an
  // infinite loop: `document.assets` is a fresh array on every render for any
  // caller that rebuilds or replaces the document, so the effect re-ran, fetched,
  // set state, re-rendered, and fetched again. The test caught it by counting the
  // object URLs it had created — 1,109 of them for one image.
  const keys = assetKeysOf(document);
  const signature = [...keys.entries()]
    .map(([assetId, storageKey]) => `${assetId}:${storageKey}`)
    .sort()
    .join("|");

  const [objectUrls, setObjectUrls] = useState<Record<string, string>>({});
  // Asked-and-failed, so one broken reference is one request rather than one per
  // render. A ref rather than state: remembering a failure must not itself cause
  // the re-render that retries it.
  const refused = useRef<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    const created: string[] = [];

    // Read back off the signature rather than closing over `keys`, so the effect
    // depends on content and nothing else. A `keys` in the dependency list is the
    // identity trap again, one level along.
    const needed = signature
      .split("|")
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf(":") + 1))
      .filter((storageKey) => client.assets.directUrl(storageKey) === undefined);

    void (async () => {
      for (const storageKey of needed) {
        if (!live || refused.current.has(storageKey)) continue;
        try {
          const blob = await client.assets.fetchBlob(storageKey);
          if (!live) return;
          const url = URL.createObjectURL(blob);
          created.push(url);
          setObjectUrls((existing) => ({ ...existing, [storageKey]: url }));
        } catch {
          // Reported by absence: the renderer draws a labelled gap for an
          // unresolved image, which says more to the person looking at the slide
          // than a toast about a storage key would.
          refused.current.add(storageKey);
        }
      }
    })();

    return () => {
      live = false;
      // Pinned blobs, released. A deck of photographs opened and closed all day
      // leaks every one of them otherwise.
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [client, signature]);

  const lookup = useRef(keys);
  lookup.current = keys;

  return useMemo(() => {
    return (assetId: string, storageKey?: string) => {
      const key = storageKey ?? lookup.current.get(assetId);
      if (!key) return undefined;
      return client.assets.directUrl(key) ?? objectUrls[key];
    };
    // `signature` rather than `keys`, for the same reason the effect uses it.
  }, [client, signature, objectUrls]);
}
