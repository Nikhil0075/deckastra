import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { PresentationDocumentSchema } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { useEditor, type EditorApi } from "@deckastra/editor-ui";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { DesktopMotionPanel } from "../src/renderer/motion/DesktopMotionStudio";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function setup(change?: (document: ReturnType<typeof loadFixture>) => void) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version_id: "v1" }) })));
  const document = loadFixture("technical");
  change?.(document);
  let editor!: EditorApi;
  const preview = vi.fn();
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <DesktopMotionPanel
      editor={editor}
      presentationId={document.id}
      scene={buildDocumentScene(editor.document)}
      preview={preview}
    />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  return { document, get editor() { return editor; }, preview };
}

it("previews on the selected object without writing, then applies and undoes the effect", async () => {
  const harness = setup();
  await waitFor(() => expect(harness.editor.recoveryReady).toBe(true));
  const target = harness.editor.document.slides[0]!.elements.find((element) => element.type === "text")!;
  act(() => harness.editor.setSelection((current) => ({ ...current, selectedIds: [target.id], primaryId: target.id })));
  const before = structuredClone(harness.editor.document);
  const tile = await screen.findByTestId("effect-tile-byWord");
  fireEvent.mouseEnter(tile);
  expect(harness.preview).toHaveBeenCalledWith([expect.objectContaining({
    targetId: target.id,
    clips: [expect.objectContaining({ presetParams: expect.objectContaining({ segmentCount: expect.any(Number) }) })],
  })]);
  expect(harness.editor.document).toEqual(before);
  fireEvent.click(tile);
  expect(harness.editor.document.slides[0]!.animations?.filter((track) => track.targetId === target.id)).toHaveLength(1);
  expect(PresentationDocumentSchema.safeParse(harness.editor.document).success).toBe(true);
  act(() => harness.editor.undo());
  expect(harness.editor.document).toEqual(before);
});

it("fills style gaps without replacing authored tracks or Magic Move pairs", async () => {
  const harness = setup((document) => {
    const first = document.slides[0]!;
    const second = document.slides[1]!;
    first.animations = [{
      id: "anm_authored",
      targetId: first.elements[0]!.id,
      trigger: { type: "click" },
      clips: [{ id: "clp_authored", preset: "byLetter", startMs: 0, durationMs: 700 }],
    }];
    second.transition = {
      type: "morph",
      durationMs: 600,
      sharedElements: [{ sourceElementId: first.elements[0]!.id, destinationElementId: second.elements[0]!.id }],
    };
  });
  await waitFor(() => expect(harness.editor.recoveryReady).toBe(true));
  fireEvent.click(screen.getByTestId("motion-style-playful"));
  const first = harness.editor.document.slides[0]!;
  const second = harness.editor.document.slides[1]!;
  expect(first.animations).toContainEqual(expect.objectContaining({ id: "anm_authored", trigger: { type: "click" } }));
  expect(second.transition).toMatchObject({ type: "morph", sharedElements: [expect.any(Object)] });
});

it("applies an entire deck style as one undo entry", async () => {
  const harness = setup();
  await waitFor(() => expect(harness.editor.recoveryReady).toBe(true));
  const before = structuredClone(harness.editor.document);
  fireEvent.click(screen.getByTestId("motion-style-calm"));
  expect(harness.editor.document.slides.every((slide) => Boolean(slide.animations?.length))).toBe(true);
  act(() => harness.editor.undo());
  expect(harness.editor.document).toEqual(before);
});
