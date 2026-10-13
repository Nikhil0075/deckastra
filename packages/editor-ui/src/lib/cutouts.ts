import type { ImageElement, PatchOperation, PresentationDocument, PresentationElement } from "@deckastra/presentation-schema";
import { LAYER_ROLES, newId } from "@deckastra/presentation-schema";
import { resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";
import type { UploadedAsset, WorkspaceClient } from "@deckastra/workspace-contracts";

import { imageSize, manifestOperations, readPictureFacts } from "./insert-image";

/**
 * Subject cut-outs (2026-10-13).
 *
 * A cut-out is a second picture of the same photograph with its background
 * already removed, stacked over the original so a person or a product can
 * stand in front of decorations that sit behind it, while the slide's text
 * stays in front of both. Deckastra does not remove backgrounds yet: the person
 * or an agent brings the transparent PNG, and this places it.
 *
 * Adding one is one patch, so it undoes as one step: the picture's manifest
 * entry (recording which picture it was cut from and that it is transparent),
 * the new element directly above its source with the same box, fit and focal
 * point so the two line up exactly, and the source marked as the scene when it
 * had no role yet.
 */

/** The layer roles, in the words the editor shows. */
export const LAYER_ROLE_LABELS: Readonly<Record<(typeof LAYER_ROLES)[number], string>> = {
  background: "Background",
  scene: "Scene",
  "decoration-behind-subject": "Behind the subject",
  subject: "Subject",
  content: "Content",
  foreground: "In front of everything",
};

export function addCutoutOperations(
  document: PresentationDocument,
  input: { sourceElementId: string; asset: UploadedAsset; hasAlpha?: boolean },
): { operations: PatchOperation[]; elementId?: string } {
  const found = resolveElementById(document, input.sourceElementId);
  if (!found || found.element.type !== "image") return { operations: [] };
  const source = found.element as ImageElement;

  const operations: PatchOperation[] = [
    ...manifestOperations(document, input.asset, {
      derivedFrom: source.assetId,
      ...(input.hasAlpha !== undefined ? { hasAlpha: input.hasAlpha } : {}),
    }),
  ];

  const id = newId("el");
  const cutout = {
    id,
    type: "image",
    name: source.name ? `${source.name} (cut-out)` : "Subject cut-out",
    layerRole: "subject",
    assetId: input.asset.id,
    transform: { ...source.transform },
    ...(source.fit ? { fit: source.fit } : {}),
    ...(source.focalPoint ? { focalPoint: { ...source.focalPoint } } : {}),
    // The cut-out is what a reader should hear about: it is the subject.
    ...(source.altText ? { altText: source.altText } : {}),
  } as unknown as PresentationElement;

  // Directly above the source, in the same stack.
  const parentPath = found.path.slice(0, found.path.lastIndexOf("/"));
  operations.push({ op: "add", path: `${parentPath}/${found.index + 1}`, value: cutout });

  if (!source.layerRole) {
    operations.push(...setPropertyDeep(document, source.id, "layerRole", "scene"));
  }
  return { operations, elementId: id };
}

/** Upload a cut-out file and produce the patch that places it over its source. */
export async function uploadAndAddCutout(
  client: Pick<WorkspaceClient, "assets" | "session">,
  input: { document: PresentationDocument; sourceElementId: string; file: File },
): Promise<{ operations: PatchOperation[]; elementId?: string; opaque: boolean }> {
  const session = await client.session.ensure();
  const asset = await client.assets.upload(input.file, { workspaceId: session.workspaceId, ...(await imageSize(input.file)) });
  const { hasAlpha } = await readPictureFacts(input.file);
  return { ...addCutoutOperations(input.document, { sourceElementId: input.sourceElementId, asset, hasAlpha }), opaque: hasAlpha === false };
}

/** The element's layer role, or undefined to clear it, as one patch. */
export function layerRoleOperations(document: PresentationDocument, elementId: string, role: string | undefined): PatchOperation[] {
  return setPropertyDeep(document, elementId, "layerRole", role);
}
