import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { newId, PatchOperationSchema, PresentationDocumentSchema } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { compileTimeline } from "@deckastra/animation-engine";
import { MotionPanel } from "../src/components/MotionPanel";
import { useEditor, type EditorApi } from "../src/lib/useEditor";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it("edits stored timing independently of the previous track, rejects negative offsets and undoes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version_id: "v1" }) })));
  const document = loadFixture("technical");
  delete document.theme.motion?.reducedMotionFallback;
  const slide = document.slides[0]!;
  slide.animations = [
    { id: newId("anm"), targetId: slide.elements[0]!.id, trigger: { type: "slideEnter" }, clips: [{ id: newId("clp"), preset: "fade", startMs: 0, durationMs: 400 }] },
    { id: newId("anm"), targetId: slide.elements[1]!.id, trigger: { type: "afterPrevious" }, clips: [{ id: newId("clp"), preset: "fade", startMs: 100, durationMs: 400 }] },
  ];
  let editor!: EditorApi;
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <MotionPanel document={editor.document} scene={buildDocumentScene(editor.document).slides[0]!} slideIndex={0} selectedIds={[]}
      apply={(operations, label) => editor.apply(PatchOperationSchema.array().parse(operations), { label })} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  fireEvent.click(screen.getByTitle(/500–900ms/));
  expect((screen.getByLabelText("Start offset (ms)") as HTMLInputElement).value).toBe("100");
  fireEvent.change(screen.getByLabelText("Delay (ms)"), { target: { value: "200" } });
  fireEvent.change(screen.getByLabelText("Start offset (ms)"), { target: { value: "250" } });
  const current = () => editor.document.slides[0]!.animations![1]!.clips[0]!;
  expect(current()).toMatchObject({ startMs: 250, delayMs: 200 });
  const compiled = compileTimeline(buildDocumentScene(editor.document).slides[0]!, editor.document.slides[0]!.animations!);
  expect(compiled.clips[1]!.startMs).toBe(850);
  expect(PresentationDocumentSchema.safeParse(editor.document).success).toBe(true);
  fireEvent.change(screen.getByLabelText("Start offset (ms)"), { target: { value: "-1" } });
  expect(current().startMs).toBe(250);
  act(() => editor.undo());
  expect(current()).toMatchObject({ startMs: 100, delayMs: 200 });
  act(() => editor.undo());
  expect(current().delayMs).toBeUndefined();
});

it("reorders a whole track in both directions, preserves its contents and undoes the order", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version_id: "v1" }) })));
  const document = loadFixture("technical");
  delete document.theme.motion?.reducedMotionFallback;
  const slide = document.slides[0]!;
  slide.animations = [100, 200, 300].map((durationMs, index) => ({
    id: newId("anm"), targetId: slide.elements[index]!.id,
    trigger: { type: "afterPrevious" },
    label: `Track ${index}`, extensions: { "test.future": { retained: true } },
    clips: [{ id: newId("clp"), preset: "fade", startMs: 0, durationMs }],
  }));
  slide.animations[1]!.clips.push({ id: newId("clp"), preset: "fade", startMs: 220, durationMs: 100 });
  const original = structuredClone(slide.animations);
  let editor!: EditorApi;
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <MotionPanel document={editor.document} scene={buildDocumentScene(editor.document).slides[0]!} slideIndex={0} selectedIds={[]}
      apply={(operations, label) => editor.apply(PatchOperationSchema.array().parse(operations), { label })} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  fireEvent.click(screen.getByTitle(/100–300ms/));
  fireEvent.click(screen.getByRole("button", { name: "Move track earlier" }));
  const tracks = () => editor.document.slides[0]!.animations!;
  expect(tracks()).toEqual([original[1], original[0], original[2]]);
  expect((screen.getByRole("button", { name: "Move track earlier" }) as HTMLButtonElement).disabled).toBe(true);
  const timeline = compileTimeline(buildDocumentScene(editor.document).slides[0]!, tracks());
  expect(timeline.clips.find(clip => clip.id === original[1]!.clips[0]!.id)!.startMs).toBe(0);
  expect(timeline.clips.find(clip => clip.id === original[0]!.clips[0]!.id)!.startMs).toBe(320);
  fireEvent.click(screen.getByRole("button", { name: "Move track later" }));
  fireEvent.click(screen.getByRole("button", { name: "Move track later" }));
  expect(tracks()).toEqual([original[0], original[2], original[1]]);
  expect((screen.getByRole("button", { name: "Move track later" }) as HTMLButtonElement).disabled).toBe(true);
  expect(PresentationDocumentSchema.safeParse(editor.document).success).toBe(true);
  act(() => editor.undo());
  expect(tracks()).toEqual(original);
  act(() => editor.undo());
  expect(tracks()).toEqual([original[1], original[0], original[2]]);
  act(() => editor.undo());
  expect(tracks()).toEqual(original);
});


it("duplicates custom keyframes and future fields without changing timing, then edits and undoes independently", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version_id: "v1" }) })));
  const document = loadFixture("technical");
  delete document.theme.motion?.reducedMotionFallback;
  const slide = document.slides[0]!;
  slide.animations = [{ id: newId("anm"), targetId: slide.elements[0]!.id, trigger: { type: "slideEnter" }, clips: [{
    id: newId("clp"), startMs: 100, delayMs: 50, durationMs: 400,
    propertyTracks: [{ property: "opacity", keyframes: [{ offset: 0, value: 0.2 }, { offset: 1, value: 1, easing: "linear" }] }],
    futureData: { values: [1, 2, 3] }, fill: "forwards",
  }] }];
  const original = structuredClone(slide.animations[0]!.clips[0]!);
  let editor!: EditorApi;
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <MotionPanel document={editor.document} scene={buildDocumentScene(editor.document).slides[0]!} slideIndex={0} selectedIds={[]}
      apply={(operations, label) => editor.apply(PatchOperationSchema.array().parse(operations), { label })} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  fireEvent.click(screen.getByTitle(/150–550ms/));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate clip" }));
  const clips = () => editor.document.slides[0]!.animations![0]!.clips;
  expect(clips()).toHaveLength(2);
  expect(clips()[0]).toEqual(original);
  expect(clips()[1]!.id).not.toBe(original.id);
  expect({ ...clips()[1], id: original.id }).toEqual(original);
  expect(PresentationDocumentSchema.safeParse(editor.document).success).toBe(true);
  fireEvent.change(screen.getByLabelText("Start offset (ms)"), { target: { value: "600" } });
  expect(clips()[1]!.startMs).toBe(600);
  expect(clips()[0]).toEqual(original);
  act(() => editor.undo());
  expect(clips()[1]!.startMs).toBe(100);
  act(() => editor.undo());
  expect(clips()).toEqual([original]);
});

it("edits and duplicates a stagger child through its source clip", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version_id: "v1" }) })));
  const document = loadFixture("technical");
  delete document.theme.motion?.reducedMotionFallback;
  const slide = document.slides[0]!;
  const groupId = newId("el");
  slide.elements = [{ id: groupId, type: "group", transform: { x: 0, y: 0, width: 1000, height: 700 }, children: slide.elements.slice(0, 2) }];
  slide.animations = [{ id: newId("anm"), targetId: groupId, trigger: { type: "slideEnter" }, clips: [{
    id: newId("clp"), preset: "staggerReveal", presetParams: { childPreset: "fade", staggerMs: 90 }, startMs: 0, durationMs: 400,
  }] }];
  let editor!: EditorApi;
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <MotionPanel document={editor.document} scene={buildDocumentScene(editor.document).slides[0]!} slideIndex={0} selectedIds={[]}
      apply={(operations, label) => editor.apply(PatchOperationSchema.array().parse(operations), { label })} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  fireEvent.click(screen.getByTitle(/90–490ms/));
  fireEvent.change(screen.getByLabelText("Delay (ms)"), { target: { value: "75" } });
  const clips = () => editor.document.slides[0]!.animations![0]!.clips;
  expect(clips()[0]!.delayMs).toBe(75);
  fireEvent.click(screen.getByRole("button", { name: "Duplicate clip" }));
  expect(clips()).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "600" } });
  expect(clips()[1]!.durationMs).toBe(600);
  expect(clips()[0]!.durationMs).toBe(400);
  act(() => editor.undo());
  act(() => editor.undo());
  act(() => editor.undo());
  expect(clips()).toEqual(slide.animations![0]!.clips);
});


it("treats the theme fallback as a fallback, not as a request to reduce motion", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version_id: "v1" }) })));
  const document = loadFixture("technical");
  delete document.theme.motion?.reducedMotionFallback;
  document.theme.motion = { ...document.theme.motion, reducedMotionFallback: "fade" };
  const slide = document.slides[0]!;
  slide.animations = [{ id: newId("anm"), targetId: slide.elements[0]!.id, trigger: { type: "slideEnter" }, clips: [{
    id: newId("clp"), preset: "fade", startMs: 0, durationMs: 400,
  }] }];
  let editor!: EditorApi;
  function Harness() {
    editor = useEditor({ initialDocument: document, presentationId: document.id, initialVersionId: "v0" });
    return <MotionPanel document={editor.document} scene={buildDocumentScene(editor.document).slides[0]!} slideIndex={0} selectedIds={[]}
      apply={(operations, label) => editor.apply(PatchOperationSchema.array().parse(operations), { label })} />;
  }
  render(<Harness />, { wrapper: withWorkspaceClient() });
  await waitFor(() => expect(editor.recoveryReady).toBe(true));
  const before = compileTimeline(buildDocumentScene(editor.document).slides[0]!, slide.animations);
  expect(before.motionLevel).toBe("full");
  expect(before.clips[0]!.endMs).toBe(400);
  fireEvent.click(screen.getByTitle(new RegExp(`0–${before.clips[0]!.endMs}ms`)));
  const duration = () => screen.getByLabelText("Duration") as HTMLInputElement;
  expect(duration().value).toBe("400");
  fireEvent.change(duration(), { target: { value: "800" } });
  expect(duration().value).toBe("800");
  expect(editor.document.slides[0]!.animations![0]!.clips[0]!.durationMs).toBe(800);
  fireEvent.change(duration(), { target: { value: "" } });
  fireEvent.change(duration(), { target: { value: "-100" } });
  expect(editor.document.slides[0]!.animations![0]!.clips[0]!.durationMs).toBe(800);
  act(() => editor.undo());
  expect(duration().value).toBe("400");
});

it("keeps the default web authoring catalog frozen at the original ten presets", () => {
  const document = loadFixture("technical");
  const slide = document.slides[0]!;
  render(<MotionPanel
    document={document}
    scene={buildDocumentScene(document).slides[0]!}
    slideIndex={0}
    selectedIds={[slide.elements[0]!.id]}
    apply={() => undefined}
  />);
  const select = screen.getByLabelText("Add animation to the selection") as HTMLSelectElement;
  expect([...select.options].slice(1).map((option) => option.value)).toEqual([
    "fade", "slide", "scale", "blurReveal", "maskReveal", "staggerReveal",
    "drawPath", "numberCount", "springIn", "sharedElementMorph",
  ].filter((name) => name !== "sharedElementMorph"));
  expect([...select.options].some((option) => option.value === "float")).toBe(false);
});
