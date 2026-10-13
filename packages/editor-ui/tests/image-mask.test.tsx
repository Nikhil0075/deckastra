/**
 * Image masks in the editor (2026-10-13): the choices the inspector offers,
 * what each writes, and that replacing the picture keeps the mask.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { applyPatch } from "@deckastra/transactions";
import { newId, validateDocument, type ImageElement, type MaskDefinition, type PatchOperation, type PresentationDocument } from "@deckastra/presentation-schema";
import { WorkspaceClientProvider } from "@deckastra/workspace-client/react";
import { testWorkspaceClient } from "@deckastra/workspace-client/testing";

import { MASK_CHOICES, maskChoice, maskExportNote, maskWithChoice, maskWithOptions, maskWithPath } from "../src/lib/image-mask";
import { replaceImageOperations } from "../src/lib/insert-image";
import { ImageSection } from "../src/components/inspector/ImageSection";

afterEach(cleanup);

function withImage(mask?: MaskDefinition): { document: PresentationDocument; image: ImageElement } {
  const document = structuredClone(loadFixture("technical"));
  for (const slide of document.slides) {
    const image = slide.elements.find((element) => element.type === "image") as ImageElement | undefined;
    if (image) {
      if (mask) image.mask = mask;
      return { document, image };
    }
  }
  throw new Error("the technical fixture has no image");
}

describe("mask choices", () => {
  it("writes each choice as a valid document", () => {
    for (const { value } of MASK_CHOICES) {
      const { document, image } = withImage();
      const mask = maskWithChoice(undefined, value);
      if (mask) image.mask = mask;
      else delete image.mask;
      expect(validateDocument(document).errors, value).toEqual([]);
      expect(maskChoice(image.mask)).toBe(value);
    }
  });

  it("keeps the turn and the inversion when the outline changes", () => {
    const arch: MaskDefinition = { type: "shape", shape: "arch", rotation: 30, invert: true };
    expect(maskWithChoice(arch, "blob")).toEqual({ type: "shape", shape: "blob", rotation: 30, invert: true });
    expect(maskWithChoice(arch, "rounded")).toEqual({ type: "rounded", radius: 24, rotation: 30, invert: true });
    expect(maskWithChoice(arch, "none")).toBeUndefined();
  });

  it("turns and inverts without touching the outline, and drops a zero turn", () => {
    const circle: MaskDefinition = { type: "shape", shape: "circle" };
    expect(maskWithOptions(circle, { rotation: 405 })).toEqual({ type: "shape", shape: "circle", rotation: 45 });
    expect(maskWithOptions({ ...circle, rotation: 45 }, { rotation: 360 })).toEqual(circle);
    expect(maskWithOptions(circle, { invert: true })).toEqual({ ...circle, invert: true });
    expect(maskWithOptions({ ...circle, invert: true }, { invert: false })).toEqual(circle);
    expect(maskWithOptions(undefined, { invert: true })).toBeUndefined();
  });

  it("takes a typed outline only when it draws one, and says why not", () => {
    expect(maskWithPath(undefined, "M0,1 L0.5,0 L1,1 Z")).toEqual({ mask: { type: "path", pathData: "M0,1 L0.5,0 L1,1 Z" } });
    expect(maskWithPath(undefined, "")).toEqual({ error: expect.stringMatching(/Type a path/) });
    expect(maskWithPath(undefined, "<script>")).toEqual({ error: expect.stringMatching(/only the letters/) });
    expect(maskWithPath(undefined, "M0.5,0.5 Z")).toEqual({ error: expect.stringMatching(/no outline/) });
  });

  it("says before export which masks PowerPoint receives as a cut-out picture", () => {
    expect(maskExportNote({ type: "shape", shape: "arch" }, "cover")).toBeUndefined();
    expect(maskExportNote({ type: "shape", shape: "arch", invert: true }, "cover")).toMatch(/already cut to shape/);
    expect(maskExportNote({ type: "ellipse" }, "contain")).toMatch(/already cut to shape/);
    expect(maskExportNote(undefined, "contain")).toBeUndefined();
  });
});

it("keeps the mask, fit and focal point when the picture is replaced", () => {
  const { document, image } = withImage({ type: "shape", shape: "arch", rotation: 12 });
  image.fit = "cover";
  image.focalPoint = { x: 0.2, y: 0.7 };
  const asset = { id: newId("ast"), storage_key: "workspaces/w/new.png", filename: "new.png", content_type: "image/png", width: 800, height: 1200 };
  const { operations } = replaceImageOperations(document, { elementId: image.id, asset: asset as never, box: "match" });
  const after = applyPatch(document, operations).document;
  const replaced = after.slides.flatMap((slide) => slide.elements).find((element) => element.id === image.id) as ImageElement;
  expect(replaced.assetId).toBe(asset.id);
  expect(replaced.mask).toEqual({ type: "shape", shape: "arch", rotation: 12 });
  expect(replaced.fit).toBe("cover");
  expect(replaced.focalPoint).toEqual({ x: 0.2, y: 0.7 });
});

it("changes the mask from the inspector in one undo step", () => {
  const { document, image } = withImage();
  const edits: { operations: PatchOperation[]; label: string }[] = [];
  render(
    <WorkspaceClientProvider client={testWorkspaceClient(() => new Response("{}"))}>
      <ImageSection document={document} element={image} edit={(operations, label) => edits.push({ operations, label })} disabled={false} resolveAssetUrl={() => undefined} />
    </WorkspaceClientProvider>,
  );
  fireEvent.click(screen.getByTestId("image-mask"));
  fireEvent.click(screen.getByTestId("image-mask-arch"));
  expect(edits).toHaveLength(1);
  expect(edits[0]!.label).toBe("Mask image");
  const after = applyPatch(document, edits[0]!.operations).document;
  const masked = after.slides.flatMap((slide) => slide.elements).find((element) => element.id === image.id) as ImageElement;
  expect(masked.mask).toEqual({ type: "shape", shape: "arch" });
  expect(screen.getByRole("button", { name: "Mask: No mask" })).toBeTruthy();
});
