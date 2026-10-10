import { newId, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";

import { HIGHLIGHTER_OPACITY, type InkStroke } from "./ink";

/**
 * Ink written into a deck, for "Save annotated copy" (UI audit 2026-10-10, unit 6).
 *
 * Ink is session state, so the only way it reaches a document is deliberately,
 * and never into the deck that was presented: the copy is a duplicate with its
 * own history, and the original is untouched. One patch for the whole copy, so
 * the annotations arrive together and undo together.
 *
 * Each annotated slide gains one locked group named "Annotations", covering the
 * slide, holding one locked custom-path shape per stroke. Locked, because ink
 * drawn during a talk is a record of the talk, and a click that moved a stroke
 * while someone edited the copy would be a quiet way to change what was said.
 * A custom path rather than a picture: it stays crisp at any size, exports to
 * PowerPoint as a shape, and can be deleted stroke by stroke.
 *
 * The copy has fresh ids throughout, so strokes are matched to its slides by
 * position in the deck that was presented, which a duplicate keeps.
 */
export function inkAnnotationOperations(
  copy: PresentationDocument,
  presentedSlideIds: string[],
  strokesBySlide: Map<string, InkStroke[]>,
): PatchOperation[] {
  const { width, height } = copy.viewport;
  const operations: PatchOperation[] = [];
  presentedSlideIds.forEach((presentedId, index) => {
    const strokes = strokesBySlide.get(presentedId);
    const target = copy.slides[index];
    if (!strokes?.length || !target) return;
    operations.push({
      op: "add",
      path: `/slides/id:${target.id}/elements/-`,
      value: {
        id: newId("el"),
        type: "group",
        name: "Annotations",
        locked: true,
        transform: { x: 0, y: 0, width, height },
        children: strokes.map((stroke) => strokeElement(stroke, width, height)),
      },
    });
  });
  return operations;
}

function strokeElement(stroke: InkStroke, width: number, height: number) {
  const xs = stroke.points.map(([x]) => x * width);
  const ys = stroke.points.map(([, y]) => y * height);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  // A box of at least one pixel, so a dot or a perfectly straight line still has
  // a box to be scaled into.
  const boxWidth = Math.max(1, Math.max(...xs) - left);
  const boxHeight = Math.max(1, Math.max(...ys) - top);
  const local = stroke.points.map((_, i) => `${norm((xs[i]! - left) / boxWidth)} ${norm((ys[i]! - top) / boxHeight)}`);
  const pathData = local.length === 1 ? `M${local[0]} L${local[0]}` : `M${local[0]} L${local.slice(1).join(" L")}`;
  return {
    id: newId("el"),
    type: "shape",
    shape: "customPath",
    name: stroke.tool === "highlighter" ? "Highlight" : "Pen stroke",
    semanticRole: "decoration",
    locked: true,
    pathData,
    transform: { x: round(left), y: round(top), width: round(boxWidth), height: round(boxHeight) },
    style: {
      fill: { type: "none" },
      stroke: { paint: { type: "solid", color: stroke.color }, width: stroke.width, cap: "round", join: "round" },
    },
    ...(stroke.tool === "highlighter" ? { opacity: HIGHLIGHTER_OPACITY } : {}),
  };
}

function norm(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The few calls a save needs, so it can be tested without a whole client. */
export interface AnnotatedCopyClient {
  clientId: string;
  documents: {
    duplicate(presentationId: string): Promise<{ presentation_id: string; title: string }>;
    read(presentationId: string): Promise<{ document: PresentationDocument; version_id: string }>;
    commit(
      presentationId: string,
      body: { operations: PatchOperation[]; intent: string; expected_version_id: string; client_id: string },
    ): Promise<unknown>;
  };
}

/**
 * Save the talk's ink as a new deck: drain the save queue, duplicate, then add
 * the annotations to the duplicate in one change.
 *
 * The drain comes first because the copy is made from what is stored: a copy
 * missing the last edit would show ink over a slide that no longer looks like
 * the one it was drawn on. A drain that fails stops the save and says why.
 */
export async function saveAnnotatedCopy(
  client: AnnotatedCopyClient,
  input: {
    presentationId: string;
    presentedSlideIds: string[];
    strokes: Map<string, InkStroke[]>;
    saveNow: () => Promise<boolean>;
  },
): Promise<{ presentationId: string; title: string }> {
  if (!(await input.saveNow())) {
    throw new Error("Your latest changes are not saved yet, so a copy would not include them. Try again in a moment.");
  }
  const copy = await client.documents.duplicate(input.presentationId);
  const read = await client.documents.read(copy.presentation_id);
  const operations = inkAnnotationOperations(read.document, input.presentedSlideIds, input.strokes);
  const title = `${read.document.metadata?.title ?? copy.title} (annotated)`;
  operations.push({ op: "replace", path: "/metadata/title", value: title });
  await client.documents.commit(copy.presentation_id, {
    operations,
    intent: "Add the annotations drawn while presenting",
    expected_version_id: read.version_id,
    client_id: client.clientId,
  });
  return { presentationId: copy.presentation_id, title };
}
