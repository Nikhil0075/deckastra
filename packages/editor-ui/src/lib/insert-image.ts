import { newId } from "@deckastra/presentation-schema";
import type {
  PatchOperation,
  PresentationDocument,
} from "@deckastra/presentation-schema";
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
  input: { slideId: string; asset: UploadedAsset },
): { operations: PatchOperation[]; elementId: string } {
  const elementId = newId("el");
  const { asset } = input;

  // Fitted to the slide rather than dropped at native size: a 4000px photograph
  // placed at its own dimensions lands mostly off-canvas, and the first thing
  // anyone would do is drag it back. Half the viewport's width, centred, with the
  // picture's own aspect ratio kept when it reported one.
  const width = Math.round(document.viewport.width / 2);
  const ratio =
    asset.width && asset.height ? asset.height / asset.width : 9 / 16;
  const height = Math.round(width * ratio);

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
        transform: {
          x: Math.round((document.viewport.width - width) / 2),
          y: Math.round((document.viewport.height - height) / 2),
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
  input: { document: PresentationDocument; slideId: string; file: File },
): Promise<{ operations: PatchOperation[]; elementId: string }> {
  const session = await client.session.ensure();
  const asset = await client.assets.upload(input.file, {
    workspaceId: session.workspaceId,
  });
  return insertImageOperations(input.document, { slideId: input.slideId, asset });
}
