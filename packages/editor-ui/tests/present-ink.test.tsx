/**
 * Ink in present mode (UI audit 2026-10-10, unit 6): the keys, the click that
 * must not advance, and a stroke drawn, undone and redone. The rules about two
 * windows agreeing are `ink.test.ts`'s; these are about one window behaving.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { PresentMode } from "../src/components/PresentMode";

vi.mock("@deckastra/renderer/react", () => ({
  SlideView: ({ scene }: { scene: { slideId: string } }) => <div data-slide-stage={scene.slideId} />,
  ScaledSlide: () => <div />,
}));

vi.mock("../src/components/SlideMotion", () => ({
  SlideMotion: () => <div />,
}));

let observers: { callback: ResizeObserverCallback }[] = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        observers.push({ callback: this.callback });
      }
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no PointerEvent: without one, Testing Library sends a plain Event
  // with no coordinates, which looks exactly like a layer ignoring the pointer.
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    },
  );
  // The slide's box: 1600×900 at the window's corner.
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function present(onExit = vi.fn()) {
  const scene = buildDocumentScene(loadFixture("animation"));
  const view = render(<PresentMode scene={scene} onExit={onExit} />);
  act(() => {
    for (const { callback } of observers) callback([{ contentRect: { width: 1920, height: 1080 } } as ResizeObserverEntry], {} as ResizeObserver);
  });
  const root = view.container.querySelector<HTMLElement>(".dk-present")!;
  const layer = () => view.container.querySelector<SVGSVGElement>('[data-testid="present-ink"]')!;
  return { ...view, root, layer, onExit };
}

it("picks a tool by its key, and the same key puts it down", () => {
  const { root } = present();
  fireEvent.keyDown(window, { key: "e" });
  expect(root.dataset.presentInkTool).toBe("pen");
  fireEvent.keyDown(window, { key: "h" });
  expect(root.dataset.presentInkTool).toBe("highlighter");
  fireEvent.keyDown(window, { key: "h" });
  expect(root.dataset.presentInkTool).toBe("");
});

it("puts the tool down on the first Escape and leaves on the second", () => {
  const { root, onExit } = present();
  fireEvent.keyDown(window, { key: "k" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(root.dataset.presentInkTool).toBe("");
  expect(onExit).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onExit).toHaveBeenCalledTimes(1);
});

it("never advances the slide on a press with a tool in hand", () => {
  const { root, layer } = present();
  fireEvent.keyDown(window, { key: "e" });
  fireEvent.click(layer(), { clientX: 900, clientY: 400 });
  expect(root.dataset.presentSlideIndex).toBe("0");
  expect(root.dataset.presentStep).toBe("0");

  // The control: with no tool the same click is navigation.
  fireEvent.keyDown(window, { key: "e" });
  const before = `${root.dataset.presentSlideIndex}/${root.dataset.presentStep}`;
  fireEvent.click(root.querySelector(".dk-present__stage")!, { clientX: 900, clientY: 400 });
  // Either a reveal or the next slide; what matters is that something moved.
  expect(`${root.dataset.presentSlideIndex}/${root.dataset.presentStep}`).not.toBe(before);
});

it("draws a stroke, and undo, redo and clear act on this slide's ink", () => {
  const { root, layer } = present();
  fireEvent.keyDown(window, { key: "e" });

  fireEvent.pointerDown(layer(), { clientX: 160, clientY: 90, pointerId: 1, buttons: 1 });
  fireEvent.pointerMove(layer(), { clientX: 800, clientY: 450, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(layer(), { clientX: 800, clientY: 450, pointerId: 1 });
  expect(root.dataset.presentInkCount).toBe("1");
  const path = layer().querySelector("path[data-ink-stroke]")!;
  // 0–1 of the slide, drawn in slide pixels: (160, 90) of a 1600×900 box is 10%.
  expect(path.getAttribute("d")).toMatch(/^M\d+(\.\d)? \d+(\.\d)? L/);
  expect(path.getAttribute("d")!.startsWith("M192 108")).toBe(true);

  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(root.dataset.presentInkCount).toBe("0");
  fireEvent.keyDown(window, { key: "y", ctrlKey: true });
  expect(root.dataset.presentInkCount).toBe("1");
  fireEvent.keyDown(window, { key: "c" });
  expect(root.dataset.presentInkCount).toBe("0");
});

it("erases a stroke it passes over", () => {
  const { root, layer } = present();
  fireEvent.keyDown(window, { key: "e" });
  fireEvent.pointerDown(layer(), { clientX: 100, clientY: 450, pointerId: 1, buttons: 1 });
  fireEvent.pointerMove(layer(), { clientX: 700, clientY: 450, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(layer(), { pointerId: 1 });
  expect(root.dataset.presentInkCount).toBe("1");

  fireEvent.keyDown(window, { key: "x" });
  fireEvent.pointerDown(layer(), { clientX: 400, clientY: 452, pointerId: 2, buttons: 1 });
  fireEvent.pointerUp(layer(), { pointerId: 2 });
  expect(root.dataset.presentInkCount).toBe("0");
});

it("offers Save annotated copy only where the save is wired, and says what happened", async () => {
  const scene = buildDocumentScene(loadFixture("animation"));
  const onSaveInk = vi.fn(async (strokes: Map<string, unknown[]>) => `Saved ${strokes.size} slide`);
  const view = render(<PresentMode scene={scene} onExit={() => {}} onSaveInk={onSaveInk} />);
  act(() => {
    for (const { callback } of observers) callback([{ contentRect: { width: 1920, height: 1080 } } as ResizeObserverEntry], {} as ResizeObserver);
  });
  const layer = view.container.querySelector<SVGSVGElement>('[data-testid="present-ink"]')!;
  fireEvent.keyDown(window, { key: "e" });
  fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(layer, { pointerId: 1 });

  await act(async () => {
    fireEvent.click(view.getByTestId("ink-save"));
  });
  expect(onSaveInk).toHaveBeenCalledTimes(1);
  expect(view.getByRole("status").textContent).toBe("Saved 1 slide");
});
