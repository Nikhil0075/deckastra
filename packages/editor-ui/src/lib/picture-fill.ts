import type { PatchOperation, PresentationDocument, TextElement } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";

/**
 * Picture-filled text (2026-10-13): the words stay editable text, painted with
 * a picture, in the canvas, the PDF and PowerPoint. Each change writes the
 * whole `pictureFill` once, so it is one undo step, and choosing another
 * picture keeps how the current one was placed.
 */
export type PictureFill = NonNullable<TextElement["pictureFill"]>;

/** The deck's pictures a fill can use, by name. */
export function deckPictures(document: PresentationDocument): { id: string; label: string }[] {
  return document.assets
    .filter((asset) => asset.type === "image")
    .map((asset) => ({ id: asset.id, label: asset.fileName ?? asset.altText ?? asset.id }));
}

export function pictureFillWithAsset(current: PictureFill | undefined, assetId: string | undefined, fallbackColor?: string): PictureFill | undefined {
  if (!assetId) return undefined;
  return {
    ...(current ?? { fit: "cover" }),
    assetId,
    ...(current?.fallbackColor || !fallbackColor ? {} : { fallbackColor }),
  };
}

export function pictureFillOperations(document: PresentationDocument, elementId: string, fill: PictureFill | undefined): PatchOperation[] {
  return setPropertyDeep(document, elementId, "pictureFill", fill);
}
