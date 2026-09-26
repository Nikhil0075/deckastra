import { newId } from "@deckastra/presentation-schema";
import type {
  PatchOperation,
  PresentationDocument,
  PresentationElement,
} from "@deckastra/presentation-schema";
import { resolveElementById } from "@deckastra/presentation-core";
import type { UploadedAsset, WorkspaceClient } from "@deckastra/workspace-contracts";

/**
 * The operations that put an uploaded picture on a slide.
 *
 * **Two writes in one patch, and that is the whole point.** An image element
 * cites an `assetId`, and the storage key behind it lives only in the document's
 * asset manifest — so an element added without its manifest entry is an element
 * nothing can resolve, and a manifest entry added without its element is an
 * asset the reference counter will sweep. Emitting them as one patch means they
 * arrive together, undo together, and can never half-exist.
 *
 * It is operations rather than a mutated document because
 * `packages/presentation-core` never returns one: a second mutation path would
 * mean undo, validation, provenance and autosave each wired in two places.
 */
export function insertImageOperations(
  document: PresentationDocument,
  input: { slideId: string; asset: UploadedAsset; at?: { x: number; y: number } },
): { operations: PatchOperation[]; elementId: string } {
  const elementId = newId("el");
  const { asset } = input;

  const { width, height } = fitImageBox(document.viewport, asset.width, asset.height);

  const operations: PatchOperation[] = [
    {
      op: "add",
      // `assets` is a required array on every document, so this is always an
      // append and never has to create the property.
      path: "/assets/-",
      value: {
        id: asset.id,
        type: "image",
        storageKey: asset.storage_key,
        ...(asset.filename ? { fileName: asset.filename } : {}),
        ...(asset.content_type ? { mimeType: asset.content_type } : {}),
        ...(asset.bytes ? { byteSize: asset.bytes } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      },
    },
    {
      op: "add",
      path: `/slides/id:${input.slideId}/elements/-`,
      value: {
        id: elementId,
        type: "image",
        assetId: asset.id,
        // Centred on the slide, or on where it was dropped — kept whole on the
        // slide either way, so every handle can be reached.
        transform: {
          x: placeAlong(input.at?.x, width, document.viewport.width),
          y: placeAlong(input.at?.y, height, document.viewport.height),
          width,
          height,
        },
        fit: "contain",
        // The file's own name, which is a poor description and better than
        // nothing: WCAG 1.1.1 is a gate this product checks (`accessibility.ts`),
        // and an image with no `altText` fails it. The inspector is where someone
        // writes a real one.
        ...(asset.filename ? { altText: asset.filename } : {}),
      },
    },
  ];

  return { operations, elementId };
}

/**
 * The box a newly placed picture gets, in slide units.
 *
 * Fitted to the slide rather than dropped at native size: a 4000px photograph
 * placed at its own dimensions lands mostly off-canvas. It fits inside half the
 * slide's width **and** most of its height, keeping its own aspect ratio. Width
 * alone used to be the constraint, so a tall portrait was scaled up to half the
 * width and ran off the top and bottom of the slide — a 100×1000 image became
 * 960×9600 at y = −4260, with no handle anyone could reach (MA-13).
 *
 * A picture smaller than that box is not blown up past its own size, except
 * that nothing lands smaller than 160 units on its long side: a 16px icon at
 * 16 units is a speck whose handles overlap.
 */
export function fitImageBox(
  viewport: { width: number; height: number },
  naturalWidth?: number | null,
  naturalHeight?: number | null,
): { width: number; height: number } {
  const maxWidth = viewport.width / 2;
  const maxHeight = viewport.height * 0.8;
  if (!naturalWidth || !naturalHeight || naturalWidth <= 0 || naturalHeight <= 0) {
    // No reported size: the old 16:9 half-width box, which fits every slide
    // this product makes.
    const width = Math.round(maxWidth);
    return { width, height: Math.round(Math.min(width * (9 / 16), maxHeight)) };
  }
  const longest = Math.max(naturalWidth, naturalHeight);
  const factor = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, Math.max(1, 160 / longest));
  return {
    width: Math.max(1, Math.round(naturalWidth * factor)),
    height: Math.max(1, Math.round(naturalHeight * factor)),
  };
}

/**
 * Upload a file and produce the patch that puts it on a slide.
 *
 * Separated from the shell for the reason the rest of this codebase separates
 * them: **operations are a pure module and the surface only gestures.** It also
 * makes the refusal testable — nothing in the repository renders `EditorShell`
 * in jsdom, because the editor measures text and jsdom has no layout, so a
 * failure path left inside the component is a failure path nothing can check.
 *
 * Throws what the client threw. The caller shows it: the likeliest refusal is
 * the storage quota, charged when the upload is registered, and a picture that
 * silently does not appear reads as the editor being broken.
 */
export async function uploadAndInsertImage(
  client: Pick<WorkspaceClient, "assets" | "session">,
  input: { document: PresentationDocument; slideId: string; file: File; at?: { x: number; y: number } },
): Promise<{ operations: PatchOperation[]; elementId: string }> {
  const session = await client.session.ensure();
  const asset = await client.assets.upload(input.file, {
    workspaceId: session.workspaceId,
    ...(await imageSize(input.file)),
  });
  return insertImageOperations(input.document, { slideId: input.slideId, asset, ...(input.at ? { at: input.at } : {}) });
}

/** A start coordinate that puts a box of `size` centred on `at` (or the middle), inside `extent`. */
function placeAlong(at: number | undefined, size: number, extent: number): number {
  const start = at === undefined ? (extent - size) / 2 : at - size / 2;
  return Math.round(Math.min(Math.max(start, 0), Math.max(0, extent - size)));
}

/**
 * Put a different picture into an existing image element (MA-21).
 *
 * Replacing is not delete-and-insert: the element keeps its id, so its
 * animation clips, its morph pairings and its place in the z-order all survive,
 * and so does its box — the author placed it deliberately. What happens to the
 * box when the new picture has a different shape is the author's choice and is
 * asked, not guessed:
 *
 * - `keep`: the box stays exactly as it is, and the element's fit mode decides
 *   how the picture sits in it.
 * - `match`: the box keeps its width and centre and takes the new picture's
 *   aspect ratio, so nothing is cropped or letterboxed.
 *
 * The manifest entry for the new asset is added in the same patch, and the old
 * one is left in the manifest: the version history still cites it, and Undo
 * puts the old picture back by restoring one `assetId`.
 *
 * Alt text was written for the old picture. It is kept (a person may have
 * written a good one) and the caller is told it now needs checking.
 */
export function replaceImageOperations(
  document: PresentationDocument,
  input: { elementId: string; asset: UploadedAsset; box: "keep" | "match" },
): { operations: PatchOperation[]; altTextNeedsReview: boolean } {
  const found = resolveElementById(document, input.elementId);
  if (!found || found.element.type !== "image") return { operations: [], altTextNeedsReview: false };
  const element = found.element as { assetId: string; altText?: string; transform: PresentationElement["transform"] };
  const { asset } = input;

  const operations: PatchOperation[] = [...manifestOperations(document, asset)];
  operations.push({ op: "replace", path: `${found.path}/assetId`, value: asset.id });

  if (input.box === "match" && asset.width && asset.height) {
    const t = element.transform;
    const height = Math.max(1, Math.round((t.width * asset.height) / asset.width));
    operations.push({
      op: "replace",
      path: `${found.path}/transform`,
      value: { ...t, y: Math.round(t.y + (t.height - height) / 2), height },
    });
  }

  const oldAsset = document.assets.find((existing) => existing.id === element.assetId) as { fileName?: string } | undefined;
  // A filename is a placeholder, not a description; it follows the file.
  if (element.altText !== undefined && oldAsset?.fileName && element.altText === oldAsset.fileName && asset.filename) {
    operations.push({ op: "replace", path: `${found.path}/altText`, value: asset.filename });
    return { operations, altTextNeedsReview: true };
  }
  return { operations, altTextNeedsReview: element.altText !== undefined && element.altText !== "" };
}

/**
 * The manifest entry an uploaded picture needs before anything may cite it, or
 * nothing when the deck already lists it. A citation without its entry is a
 * picture nothing can resolve, so every path that cites an upload starts here.
 */
export function manifestOperations(document: PresentationDocument, asset: UploadedAsset): PatchOperation[] {
  if (document.assets.some((existing) => existing.id === asset.id)) return [];
  return [
    {
      op: "add",
      path: "/assets/-",
      value: {
        id: asset.id,
        type: "image",
        storageKey: asset.storage_key,
        ...(asset.filename ? { fileName: asset.filename } : {}),
        ...(asset.content_type ? { mimeType: asset.content_type } : {}),
        ...(asset.bytes ? { byteSize: asset.bytes } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      },
    },
  ];
}

/** Upload a picture into the deck's workspace, measured first, and hand back the stored asset. */
export async function uploadPicture(
  client: Pick<WorkspaceClient, "assets" | "session">,
  file: File,
): Promise<UploadedAsset> {
  const session = await client.session.ensure();
  return client.assets.upload(file, { workspaceId: session.workspaceId, ...(await imageSize(file)) });
}

/** Upload a file and produce the patch that swaps it into an image element. */
export async function uploadAndReplaceImage(
  client: Pick<WorkspaceClient, "assets" | "session">,
  input: { document: PresentationDocument; elementId: string; file: File; box: "keep" | "match" },
): Promise<{ operations: PatchOperation[]; altTextNeedsReview: boolean }> {
  const session = await client.session.ensure();
  const asset = await client.assets.upload(input.file, { workspaceId: session.workspaceId, ...(await imageSize(input.file)) });
  return replaceImageOperations(input.document, { elementId: input.elementId, asset, box: input.box });
}

/**
 * A picture's pixel size, read in the browser before it is uploaded.
 *
 * The upload records a size only when it is told one, and nothing used to tell
 * it: every inserted picture was placed in the 16:9 fallback box, a portrait
 * letterboxed inside it, and the PowerPoint export stretched what it could not
 * fit because the manifest had no dimensions (found by the `authoring`
 * acceptance step, which pastes a real portrait PNG). Undefined where the
 * environment cannot decode it — an SVG, or a test without a browser — and the
 * fallback box is then the honest answer.
 */
export async function imageSize(file: Blob): Promise<{ width?: number; height?: number }> {
  if (typeof createImageBitmap !== "function") return {};
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size.width > 0 && size.height > 0 ? size : {};
  } catch {
    return {};
  }
}
