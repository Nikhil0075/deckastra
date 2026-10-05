import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { compileTransition, transitionCss, transitionSlideFromScene } from "@deckastra/animation-engine";
import { applyPatch } from "@deckastra/transactions";
import { withWorkspaceClient } from "@deckastra/workspace-client/testing";

import { TransitionPreview } from "../src/components/shell/TransitionPreview";
import { MotionModePanel } from "../src/components/shell/MotionModePanel";
import { EditorShell } from "../src/components/EditorShell";
import { removeBrokenPairs } from "../src/lib/transition-editing";
import type { EditorApi } from "../src/lib/useEditor";

/**
 * Motion authoring (manual-authoring review MA-24 to MA-27).
 */

vi.mock("../src/lib/measurer", () => ({ useBrowserMeasurer: () => undefined }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version_id: "v1" }) })));
  vi.stubGlobal("PointerEvent", MouseEvent);
  if (typeof CSS === "undefined" || !CSS.escape) vi.stubGlobal("CSS", { escape: (value: string) => value });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
});

const animation = () => structuredClone(loadFixture("animation")) as PresentationDocument;

function withFade(document: PresentationDocument, index: number, durationMs = 400): PresentationDocument {
  const slide = document.slides[index]!;
  slide.transition = { type: "fade", durationMs, easing: "linear" } as never;
  return document;
}

describe("transition preview (MA-25)", () => {
  it("shows both slides at the midpoint, styled exactly as present mode samples them", () => {
    const document = withFade(animation(), 1);
    const scene = buildDocumentScene(document);
    const view = render(<TransitionPreview scene={scene} slideIndex={1} />);
    fireEvent.click(screen.getByTestId("transition-middle"));

    const stage = view.container.querySelector("[data-transition-preview-stage]") as HTMLElement;
    expect(stage).toBeTruthy();
    // The outgoing slide is on screen too — it is a transition between two.
    const stages = view.container.querySelectorAll(".dk-transition-preview__stage > div > div");
    expect(stages.length).toBe(2);

    // The frame present mode would draw at the same instant.
    const compiled = compileTransition(
      scene.slides[1]!.transition,
      transitionSlideFromScene(scene.slides[0]!),
      transitionSlideFromScene(scene.slides[1]!),
      { motion: "full" },
    );
    const expected = transitionCss(compiled, compiled.durationMs / 2)["slide:in"]!;
    for (const [property, value] of Object.entries(expected)) {
      expect(stage.style.getPropertyValue(property)).toBe(value);
    }
  });

  it("at the end only the arriving slide remains", () => {
    const document = withFade(animation(), 1);
    const view = render(<TransitionPreview scene={buildDocumentScene(document)} slideIndex={1} />);
    fireEvent.change(screen.getByTestId("transition-scrub"), { target: { value: "400" } });
    expect(view.container.querySelectorAll(".dk-transition-preview__stage > div > div")).toHaveLength(1);
  });

  it("previews reduced motion as the room will get it, and explains the first slide", () => {
    const document = withFade(animation(), 1);
    const scene = buildDocumentScene(document);
    const reduced = compileTransition(scene.slides[1]!.transition, transitionSlideFromScene(scene.slides[0]!), transitionSlideFromScene(scene.slides[1]!), { motion: "reduced" });
    render(<TransitionPreview scene={scene} slideIndex={1} />);
    fireEvent.click(screen.getByRole("radio", { name: "Reduced motion" }));
    if (reduced.durationMs === 0) expect(screen.getByText(/reduced motion this transition is a cut/)).toBeTruthy();
    else expect((screen.getByTestId("transition-scrub") as HTMLInputElement).max).toBe(String(reduced.durationMs));

    cleanup();
    render(<TransitionPreview scene={scene} slideIndex={0} />);
    expect(screen.getByText(/nothing before it to move from/)).toBeTruthy();
  });
});

describe("morph pairs (MA-27)", () => {
  function fakeEditor(document: PresentationDocument, slideIndex: number) {
    return {
      document,
      slideIndex,
      apply: vi.fn(),
      saveNow: vi.fn(async () => true),
      currentVersionId: () => "ver_1",
    } as unknown as EditorApi & { apply: ReturnType<typeof vi.fn> };
  }

  it("outlines a pair's source and destination on the two slides when the pair is focused", () => {
    const document = animation();
    const index = document.slides.findIndex((slide) => slide.transition?.type === "morph");
    const pair = document.slides[index]!.transition!.sharedElements![0]!;
    const editor = fakeEditor(document, index);
    render(<MotionModePanel editor={editor} presentationId="doc_1" scene={buildDocumentScene(document)} />, { wrapper: withWorkspaceClient() });
    const row = screen.getAllByTestId("pair-row").find((candidate) => candidate.getAttribute("data-origin") === "manual")!;
    fireEvent.focus(row);
    const preview = screen.getByTestId("pair-preview");
    const marks = [...preview.querySelectorAll("[data-highlight]")].map((mark) => mark.getAttribute("data-highlight"));
    expect(marks).toEqual([pair.sourceElementId, pair.destinationElementId]);
  });

  it("offers to remove pairs whose objects are gone, in one patch", () => {
    const document = animation();
    const index = document.slides.findIndex((slide) => slide.transition?.type === "morph");
    const pairs = document.slides[index]!.transition!.sharedElements!;
    pairs.push({ sourceElementId: "el_01JZZZZZZZZZZZZZZZZZZZZZZZ", destinationElementId: pairs[0]!.destinationElementId } as never);
    const change = removeBrokenPairs(document, document.slides[index]!.id);
    const after = applyPatch(document, change.operations).document;
    expect(after.slides[index]!.transition!.sharedElements).toHaveLength(pairs.length - 1);
    expect(change.notice).toMatch(/Removed 1 pair/);

    const editor = fakeEditor(document, index);
    render(<MotionModePanel editor={editor} presentationId="doc_1" scene={buildDocumentScene(document)} />, { wrapper: withWorkspaceClient() });
    fireEvent.click(screen.getByTestId("pair-repair"));
    expect(editor.apply).toHaveBeenCalledTimes(1);
  });
});

describe("in the shell (MA-24, MA-26)", () => {
  async function mount(document = animation()) {
    const view = render(<EditorShell initialDocument={document} presentationId="prs_motion" initialVersionId="v0" />, {
      wrapper: withWorkspaceClient(),
    });
    await waitFor(() => expect(view.container.querySelector("[data-editor-canvas]")).toBeTruthy());
    return view;
  }

  it("a slide's menu opens how the deck moves into that slide", async () => {
    await mount();
    const menus = screen.getAllByTestId("slide-menu");
    fireEvent.click(menus[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Transition in:/ }));
    expect(await screen.findByTestId("motion-panel")).toBeTruthy();
    expect(screen.getByText("Transition into slide 2")).toBeTruthy();
  });

  it("the first slide says why it cannot morph", async () => {
    await mount();
    fireEvent.click(screen.getAllByTestId("slide-menu")[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Transition in:/ }));
    expect(await screen.findByTestId("first-slide-note")).toBeTruthy();
  });

  it("a scrubbed preview says so, and ends on Back to editing, on leaving Motion, and on a press on the canvas", async () => {
    const view = await mount();
    // The timeline is a tab of the dock, put away while designing.
    if (!view.container.querySelector("[data-dock-panel='timeline']")) fireEvent.click(screen.getByTestId("dock-tab-timeline"));
    const dock = view.container.querySelector("[data-dock-panel='timeline']") as HTMLElement;
    const scrub = within(dock).getByLabelText("Scrub the slide timeline");
    fireEvent.change(scrub, { target: { value: "120" } });
    expect(await screen.findByTestId("motion-preview-banner")).toBeTruthy();
    fireEvent.click(screen.getByTestId("stop-motion-preview"));
    await waitFor(() => expect(screen.queryByTestId("motion-preview-banner")).toBeNull());

    fireEvent.change(scrub, { target: { value: "60" } });
    expect(await screen.findByTestId("motion-preview-banner")).toBeTruthy();
    act(() => {
      fireEvent.pointerDown(view.container.querySelector("[data-editor-canvas]")!, { button: 0, clientX: 5, clientY: 5 });
    });
    await waitFor(() => expect(screen.queryByTestId("motion-preview-banner")).toBeNull());
  });
});
