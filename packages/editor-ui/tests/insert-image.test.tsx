/**
 * Putting a picture in a deck (2026-09-17).
 *
 * The resolver landed first and made images *render*; this is the half that lets
 * a person create one. The property worth pinning down is that it is **one
 * patch**: an image element cites an `assetId`, and the storage key behind it
 * lives only in the document's asset manifest, so the two have to arrive
 * together. An element without its manifest entry is an element nothing can
 * resolve; a manifest entry without its element is an asset the reference
 * counter will sweep.
 */

import { cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { applyPatch } from "@deckastra/transactions";
import { validateDocument } from "@deckastra/presentation-schema";
import { testWorkspaceClient } from "@deckastra/workspace-client/testing";
import type { UploadedAsset } from "@deckastra/workspace-contracts";

import { newId } from "@deckastra/presentation-schema";

import { insertImageOperations, uploadAndInsertImage } from "../src/lib/insert-image";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A real id, minted the way the product mints them. A hand-written "ast_01IMAGE"
// is not a ULID and the validator says so — which is the gate working, and the
// third time this session that invented test data was caught by a real check
// rather than by review.
const UPLOADED: UploadedAsset = {
  id: newId("ast"),
  kind: "image",
  filename: "chart.png",
  content_type: "image/png",
  bytes: 4096,
  width: 1600,
  height: 900,
  storage_key: "workspaces/wsp_test/assets/obj_01XYZ.png",
};

it("adds the manifest entry and the element as one patch", () => {
  const document = structuredClone(loadFixture("technical"));
  const slideId = document.slides[0]!.id;

  const { operations, elementId } = insertImageOperations(document, {
    slideId,
    asset: UPLOADED,
  });

  // One patch, both writes. Two patches would mean a moment where the document
  // is one or the other, and an undo that leaves the wrong half behind.
  expect(operations).toHaveLength(2);
  expect(operations[0]!.path).toBe("/assets/-");
  expect(operations[1]!.path).toBe(`/slides/id:${slideId}/elements/-`);

  const applied = applyPatch(document, operations);
  const after = applied.document;

  const manifest = after.assets.find((one) => one.id === UPLOADED.id)!;
  expect(manifest.storageKey).toBe(UPLOADED.storage_key);

  const element = after.slides[0]!.elements.find((one) => one.id === elementId)!;
  expect(element.type).toBe("image");
  expect((element as { assetId: string }).assetId).toBe(UPLOADED.id);

  // The document the product would actually store.
  expect(validateDocument(after).errors).toEqual([]);
});

it("fits the picture to the slide rather than dropping it at native size", () => {
  // A 4000px photograph placed at its own dimensions lands mostly off-canvas,
  // and the first thing anyone would do is drag it back.
  const document = structuredClone(loadFixture("technical"));
  const { operations } = insertImageOperations(document, {
    slideId: document.slides[0]!.id,
    asset: { ...UPLOADED, width: 4000, height: 3000 },
  });

  const element = (operations[1] as { value: { transform: Record<string, number> } }).value;
  expect(element.transform.width).toBe(document.viewport.width / 2);
  // Its own aspect ratio, kept: 4000x3000 is 4:3, so half the width is
  // three-quarters of that in height.
  expect(element.transform.height).toBe(Math.round((document.viewport.width / 2) * 0.75));
  // Centred, and therefore on the slide.
  expect(element.transform.x).toBeGreaterThanOrEqual(0);
  expect(element.transform.y).toBeGreaterThanOrEqual(0);
});

it("carries alt text, because an image without it fails the accessibility gate", () => {
  // WCAG 1.1.1, which `accessibility.ts` checks. The filename is a poor
  // description and better than nothing; the inspector is where a real one goes.
  const document = structuredClone(loadFixture("technical"));
  const { operations } = insertImageOperations(document, {
    slideId: document.slides[0]!.id,
    asset: UPLOADED,
  });

  expect((operations[1] as { value: { altText?: string } }).value.altText).toBe("chart.png");
});

it("sends our credential to our own blob route and none to a presigned one", async () => {
  // The subtlety a caller should not have to know. A relative upload URL is this
  // API's own route and needs the bearer; an absolute one is a presigned
  // object-store URL whose signature *is* the credential, and attaching a second
  // one is how a presigned PUT gets rejected.
  const seen: { url: string; auth: string | undefined }[] = [];

  function clientFor(uploadUrl: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url: String(url), auth: headers.Authorization });
        if (String(url).includes("/uploads/complete")) {
          return { ok: true, json: async () => UPLOADED };
        }
        if (String(url).includes("/uploads")) {
          return {
            ok: true,
            json: async () => ({
              method: "PUT",
              upload_url: uploadUrl,
              headers: { "Content-Type": "image/png" },
              upload_token: "a-token-long-enough-to-pass",
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    return testWorkspaceClient();
  }

  const file = new File([new Uint8Array([1, 2, 3])], "chart.png", { type: "image/png" });

  const ours = clientFor("/v1/workspace/assets/blob/workspaces/wsp_test/assets/obj.png");
  await ours.assets.upload(file, { workspaceId: "wsp_test" });
  const toOurs = seen.find((one) => one.url.includes("/assets/blob/"))!;
  expect(toOurs.auth).toMatch(/^Bearer /);

  seen.length = 0;
  const presigned = clientFor("https://objects.example/bucket/obj.png?X-Amz-Signature=abc");
  await presigned.assets.upload(file, { workspaceId: "wsp_test" });
  const toStore = seen.find((one) => one.url.startsWith("https://objects.example"))!;
  expect(toStore.auth).toBeUndefined();
});

it("throws what the caller must show when an upload is refused", async () => {
  // The likeliest refusal is the storage quota, charged when the upload is
  // registered. A picture that silently does not appear reads as the editor
  // being broken, so the message has to reach the person.
  //
  // Driven through `uploadAndInsertImage` rather than the shell: nothing in this
  // repository renders `EditorShell` in jsdom, because the editor measures text
  // and jsdom has no layout — a failure path left inside the component is one
  // nothing can check.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/uploads")) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ detail: { message: "This workspace is out of storage." } }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );

  const document = structuredClone(loadFixture("technical"));
  const client = testWorkspaceClient();
  const file = new File([new Uint8Array([1])], "chart.png", { type: "image/png" });

  await expect(
    uploadAndInsertImage(client, {
      document,
      slideId: document.slides[0]!.id,
      file,
    }),
  ).rejects.toThrow(/storage/i);

  // And nothing was written: the caller never got operations to apply.
  expect(document.assets).toEqual([]);
});
