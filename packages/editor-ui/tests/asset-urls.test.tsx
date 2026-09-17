/**
 * Resolving a deck's pictures (2026-09-17).
 *
 * `SlideView` has taken a `resolveAssetUrl` prop since the renderer was written
 * and **no caller anywhere passed one**, so every image in the product drew the
 * renderer's labelled gap. The prop was not forgotten: the two shells cannot
 * authenticate an image the same way, and there is no single URL that works for
 * both.
 *
 * The desktop's base URL is a path on the renderer's own origin and the main
 * process injects the bearer as the request passes through, so an `<img src>` at
 * the blob route works. The web app's base URL is another origin and its
 * credential is a header, which an `<img>` cannot send — there the bytes have to
 * be fetched and handed over as an object URL. Both halves are here, because
 * either alone is a picture that works on one shell and is broken on the other.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testWorkspaceClient, withWorkspaceClient } from "@deckastra/workspace-client/testing";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { assetKeysOf, useAssetUrls } from "../src/lib/asset-urls";

const KEY = "workspaces/wsp_01ABC/assets/obj_01XYZ.png";

/** The fixture plus one image in its manifest. */
function deckWithAnImage(): PresentationDocument {
  const document = structuredClone(loadFixture("technical"));
  // The real field names, not invented ones. A cast past this is how a test
  // comes to build something the product would never store — and vitest strips
  // types, so only the typechecker would ever have said so.
  document.assets = [
    {
      id: "ast_01IMAGE",
      type: "image",
      storageKey: KEY,
      fileName: "logo.png",
      mimeType: "image/png",
      byteSize: 12,
    },
  ];
  return document;
}

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:fake/${created.length}`;
      created.push(url);
      void blob;
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads every storage key out of the manifest and nothing else", () => {
  // The manifest is the only place a key lives. An element whose `assetId` has
  // no entry has nothing to resolve — a document problem the renderer already
  // reports, not something to go and fetch.
  const keys = assetKeysOf(deckWithAnImage());

  expect([...keys.entries()]).toEqual([["ast_01IMAGE", KEY]]);
  expect(assetKeysOf(null).size).toBe(0);
});

it("uses a plain URL where the browser can authenticate the request itself", async () => {
  // The desktop: a relative base is same-origin, and the proxy adds the bearer
  // as the request goes through. No fetch, because none is needed.
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetcher);

  const { result } = renderHook(() => useAssetUrls(deckWithAnImage()), {
    wrapper: withWorkspaceClient(testWorkspaceClient({ baseUrl: "/__api" })),
  });

  expect(result.current("ast_01IMAGE")).toBe(
    "/__api/v1/workspace/assets/blob/workspaces/wsp_01ABC/assets/obj_01XYZ.png",
  );
  // Segment by segment: the route is `{key:path}` and the slashes have to
  // survive, which `encodeURIComponent` over the whole key would not allow.
  expect(result.current("ast_01IMAGE")).toContain("/workspaces/wsp_01ABC/assets/");
  expect(fetcher).not.toHaveBeenCalled();
});

it("fetches the bytes where an <img> cannot carry the credential", async () => {
  // The web app: another origin, a bearer in a header. An `<img>` sends none, so
  // answering with a URL would produce a broken image rather than a picture.
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const fetcher = vi.fn(async (url: string) => {
    if (String(url).includes("/assets/blob/")) {
      return { ok: true, blob: async () => blob, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ token: "t", user_id: "u" }) };
  });
  vi.stubGlobal("fetch", fetcher);

  const { result } = renderHook(() => useAssetUrls(deckWithAnImage()), {
    wrapper: withWorkspaceClient(testWorkspaceClient({ baseUrl: "http://api.test" })),
  });

  // Nothing on the first render, which is what the renderer's labelled gap is
  // for — and then the picture, once the bytes are here.
  expect(result.current("ast_01IMAGE")).toBeUndefined();
  await waitFor(() => expect(result.current("ast_01IMAGE")).toBe("blob:fake/0"));

  const asked = fetcher.mock.calls.map(([url]) => String(url));
  expect(asked.some((one) => one.endsWith(`/v1/workspace/assets/blob/${KEY}`))).toBe(true);
});

it("releases the object URLs it made", async () => {
  // They pin their blob for the life of the document otherwise, and a deck of
  // photographs opened and closed all day is a leak that looks like the editor
  // getting slower.
  const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/assets/blob/")
        ? { ok: true, blob: async () => blob, json: async () => ({}) }
        : { ok: true, json: async () => ({ token: "t", user_id: "u" }) },
    ),
  );

  const { result, unmount } = renderHook(() => useAssetUrls(deckWithAnImage()), {
    wrapper: withWorkspaceClient(testWorkspaceClient({ baseUrl: "http://api.test" })),
  });
  await waitFor(() => expect(result.current("ast_01IMAGE")).toBe("blob:fake/0"));

  unmount();

  expect(revoked).toEqual(["blob:fake/0"]);
});

it("asks once for an object it cannot have", async () => {
  // Without this, one broken reference is a request on every render for as long
  // as the deck is open.
  const fetcher = vi.fn(async (url: string) =>
    String(url).includes("/assets/blob/")
      ? { ok: false, status: 404, json: async () => ({ detail: "Not found." }) }
      : { ok: true, json: async () => ({ token: "t", user_id: "u" }) },
  );
  vi.stubGlobal("fetch", fetcher);

  const { result, rerender } = renderHook(() => useAssetUrls(deckWithAnImage()), {
    wrapper: withWorkspaceClient(testWorkspaceClient({ baseUrl: "http://api.test" })),
  });

  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/assets/blob/"))).toBe(true),
  );
  const afterFirst = fetcher.mock.calls.filter(([url]) =>
    String(url).includes("/assets/blob/"),
  ).length;

  await act(async () => {
    rerender();
  });

  const afterSecond = fetcher.mock.calls.filter(([url]) =>
    String(url).includes("/assets/blob/"),
  ).length;
  expect(afterSecond).toBe(afterFirst);
  // And it stays unresolved, which is what the renderer draws its labelled gap
  // for — better than a toast naming a storage key.
  expect(result.current("ast_01IMAGE")).toBeUndefined();
});
