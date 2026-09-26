/**
 * The pictures an export draws, handed to the renderer as bytes.
 *
 * `resolveAssetUrl` is the prop that turns an `assetId` into something an
 * `<img>` can load, and until now **nothing in a headless render passed one** —
 * so every export drew the renderer's labelled gap and a PDF of a deck full of
 * photographs arrived as dashed boxes. The editor's half of this problem was
 * solved by `editor-ui/src/lib/asset-urls.ts`, and it does not transfer: that
 * code answers either a same-origin path the desktop proxy will authenticate,
 * or an object URL fetched with a bearer token. **The worker has neither.** It
 * has no session, no browser origin, and — deliberately — no network at all
 * (`render-page.ts` aborts every request that is not a `data:` URL, because a
 * document that could make the render host fetch a URL is an SSRF primitive as
 * well as a source of nondeterminism).
 *
 * So the bytes are handed *in*. The API authorizes and loads each asset the
 * document cites and passes an id → bytes map alongside the deck; this module
 * turns that into the synchronous resolver `SlideView` requires, as `data:`
 * URLs — the one scheme the render page allows.
 *
 * Two rules the rest of this file exists to keep:
 *
 * - **A payload that arrives is still checked.** The caller today is our own
 *   API, but a resolver that will happily build a `data:` URL out of whatever it
 *   was handed is one malformed row away from putting arbitrary content into a
 *   customer's PDF. Type, encoding and size are checked here, and the limits are
 *   the worker's own rather than a promise the caller keeps.
 * - **An asset that is not drawn is named.** A missing picture is the failure
 *   mode that looks like nothing: the slide renders, the export succeeds, and a
 *   dashed box arrives where a photograph should be. Every asset the scene needs
 *   and cannot get produces an `ExportWarning`, so it reaches the report the user
 *   reads before downloading (doc 04 §32.2).
 */

import type { ExportImage, ExportWarning } from "@deckastra/export-core";
import type { SceneNode, SlideScene } from "@deckastra/renderer";

/**
 * One asset, as the API hands it over.
 *
 * Either `data` (base64) or `problem` — the caller says *why* it could not
 * supply the bytes rather than omitting the entry, because "the API refused to
 * read a 400MB file" and "this deck cites an asset that does not exist" are
 * different things to tell a person, and an omission cannot tell them apart.
 */
export interface InlineAsset {
  assetId: string;
  storageKey?: string;
  mimeType?: string;
  /** Base64, no data-URL prefix. */
  data?: string;
  /** Why the bytes are absent, in words a user can read. */
  problem?: string;
}

/**
 * Per-file and whole-request ceilings.
 *
 * A data URL is base64 in an HTML string that Chromium parses in one go, so
 * these are memory in three places at once — the worker's string, the IPC or
 * CDP payload, and the page. The numbers are generous for photographs and
 * screenshots and refuse a video someone stored as an "image".
 */
export const MAX_INLINE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 32 * 1024 * 1024;

/** `data:` is the only scheme `render-page.ts` lets through, so images must be it. */
const IMAGE_TYPE = /^image\/[a-z0-9][a-z0-9.+-]*$/;
/**
 * A deck's uploaded fonts travel the same way (Design tab review, 2026-09-26):
 * the render page declares them with `@font-face` from a `data:` URL, because
 * it can fetch nothing else. Only the formats Chromium draws.
 */
const FONT_TYPE = /^(font\/(ttf|otf|woff|woff2|sfnt)|application\/font-woff)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Bytes a base64 string decodes to, without decoding it. */
function decodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

interface Accepted {
  url: string;
  storageKey?: string;
}

/**
 * Base64 to bytes, without Node's `Buffer`.
 *
 * `atob` is on `globalThis` in Node 18+ and in every browser, and it keeps this
 * module runnable in either — the worker's bundle has no Node polyfills beyond
 * what it imports explicitly.
 */
function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The assets a render was given, and the ones it was not.
 *
 * Built once per render and consulted synchronously, because the renderer's prop
 * is synchronous: there is nowhere in `renderToStaticMarkup` to await a fetch,
 * which is the same constraint the editor's resolver works under.
 */
export class AssetLibrary {
  private readonly byId = new Map<string, Accepted>();
  private readonly byKey = new Map<string, Accepted>();
  /** Asset id → why it is not drawable. */
  private readonly refused = new Map<string, string>();

  constructor(assets: readonly InlineAsset[] = []) {
    let total = 0;

    for (const asset of assets) {
      if (!asset.assetId) continue;

      if (asset.problem) {
        this.refused.set(asset.assetId, asset.problem);
        continue;
      }

      const type = (asset.mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (!IMAGE_TYPE.test(type) && !FONT_TYPE.test(type)) {
        this.refused.set(asset.assetId, `its content type (${asset.mimeType ?? "none"}) is not an image or a font`);
        continue;
      }

      const data = asset.data ?? "";
      // Length before content: a 400MB string is not worth running a regular
      // expression over to learn that it is also too large.
      const size = decodedBytes(data);
      if (size === 0) {
        this.refused.set(asset.assetId, "no bytes were supplied for it");
        continue;
      }
      if (size > MAX_INLINE_ASSET_BYTES) {
        this.refused.set(
          asset.assetId,
          `it is ${Math.round(size / 1024 / 1024)}MB, over the ${MAX_INLINE_ASSET_BYTES / 1024 / 1024}MB this renderer embeds`,
        );
        continue;
      }
      if (!BASE64.test(data)) {
        this.refused.set(asset.assetId, "its bytes did not arrive as valid base64");
        continue;
      }
      if (total + size > MAX_INLINE_TOTAL_BYTES) {
        this.refused.set(
          asset.assetId,
          `this deck's images exceed the ${MAX_INLINE_TOTAL_BYTES / 1024 / 1024}MB a single render embeds`,
        );
        continue;
      }

      total += size;
      const entry: Accepted = {
        url: `data:${type};base64,${data}`,
        ...(asset.storageKey ? { storageKey: asset.storageKey } : {}),
      };
      this.byId.set(asset.assetId, entry);
      // Also by key, because a slide *background* carries only an `assetId`
      // while an image element carries both, and a caller that had one and not
      // the other should still find the picture.
      if (asset.storageKey) this.byKey.set(asset.storageKey, entry);
    }
  }

  /**
   * The same pictures as raw bytes, for an adapter that must embed rather than
   * reference them.
   *
   * PDF gets `data:` URLs because it renders in a browser; a `.pptx` is a zip and
   * a picture in one is a part inside it, so PPTX needs the bytes themselves.
   * Decoded once per export rather than per slide — a logo on twelve slides is
   * one decode and one part.
   */
  images(): ReadonlyMap<string, ExportImage> {
    const byId = new Map<string, ExportImage>();
    for (const [assetId, entry] of this.byId) {
      const comma = entry.url.indexOf(",");
      const header = entry.url.slice("data:".length, entry.url.indexOf(";base64"));
      // A font is not a picture; PowerPoint cannot embed one from here and the
      // PPTX report says so rather than dropping it into ppt/media.
      if (!header.startsWith("image/")) continue;
      byId.set(assetId, {
        bytes: base64Bytes(entry.url.slice(comma + 1)),
        contentType: header,
      });
    }
    return byId;
  }

  /** The resolver `SlideView` takes. Bound, so it can be passed as a value. */
  readonly resolve = (assetId: string, storageKey?: string): string | undefined => {
    const found = this.byId.get(assetId) ?? (storageKey ? this.byKey.get(storageKey) : undefined);
    return found?.url;
  };

  /**
   * Everything this render needed and could not draw.
   *
   * Derived from the **scenes** rather than from the resolver's misses, so it is
   * known before a pixel is drawn and does not depend on when React happened to
   * call the prop — which matters because the PDF adapter assembles its report
   * around the render rather than after it.
   */
  problems(slides: readonly SlideScene[], decodeFailures: readonly string[] = []): ExportWarning[] {
    const warnings: ExportWarning[] = [];
    const reported = new Set<string>();
    const failed = new Set(decodeFailures);

    const note = (assetId: string, slideId: string, elementId: string | undefined, why: string) => {
      if (reported.has(assetId)) return;
      reported.add(assetId);
      warnings.push({
        severity: "warning",
        slideId,
        ...(elementId ? { elementId } : {}),
        // Per asset rather than a single "image" line: the ledger deduplicates on
        // feature and action, so one feature name would collapse four missing
        // pictures into one warning naming one of them.
        feature: `asset:${assetId}`,
        action: "dropped",
        message: `An image could not be drawn because ${why}. The slide shows a placeholder where it should be.`,
      });
    };

    for (const slide of slides) {
      for (const face of slide.fontFaces ?? []) {
        if (reported.has(face.assetId) || (this.byId.has(face.assetId) && !failed.has(face.assetId))) continue;
        reported.add(face.assetId);
        warnings.push({
          severity: "warning",
          slideId: slide.slideId,
          feature: `font:${face.assetId}`,
          action: "approximated",
          message: `The uploaded font "${face.family}" could not be used because ${
            this.refused.get(face.assetId) ?? "it was not available to the renderer"
          }. Text set in it is drawn in a fallback font.`,
        });
      }
      for (const [assetId, elementId] of neededAssets(slide)) {
        if (this.byId.has(assetId) && !failed.has(assetId)) continue;
        const why =
          this.refused.get(assetId) ??
          (failed.has(assetId)
            ? "the browser could not decode the bytes supplied for it"
            : "it was not available to the renderer");
        note(assetId, slide.slideId, elementId, why);
      }
    }

    // A decode failure for something no scene asked for should still be heard
    // rather than swallowed; it means the two halves disagree about what is on
    // the page, which is worth knowing.
    for (const assetId of failed) {
      note(assetId, "", undefined, "the browser could not decode the bytes supplied for it");
    }

    return warnings;
  }
}

/**
 * Every asset a slide's scene draws, as `[assetId, elementId?]`.
 *
 * The scene rather than the document, because the scene is what the markup is
 * generated from: an element the layout dropped cannot produce a missing-image
 * warning, and a background the theme resolved can.
 */
export function neededAssets(slide: SlideScene): Array<[string, string | undefined]> {
  const found: Array<[string, string | undefined]> = [];

  if (slide.background?.assetId) found.push([slide.background.assetId, undefined]);

  const walk = (nodes: readonly SceneNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      const payload = node.renderPayload;
      if (payload.kind === "image" && payload.assetId) found.push([payload.assetId, node.id]);
      walk(node.children);
    }
  };
  walk(slide.nodes);

  return found;
}
