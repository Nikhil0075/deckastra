/**
 * Going back through a deck (doc 04 §26.3).
 *
 * Two rules, and both are about the same idea: **a transition and an entrance
 * describe arriving, and going back is not arriving.** A presenter stepping back
 * is checking something they already showed — replaying its build makes them
 * wait through a reveal the room has seen, and running the transition backwards
 * animates a move that never happened in that direction.
 *
 * Both were implemented and neither was covered, which is the kind of gap that
 * survives until someone presents with it.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { PresentMode } from "../src/components/PresentMode";

/**
 * The two children are stood in for rather than marked up.
 *
 * Counting mounted slides and reading `autoPlay` are both questions about what
 * `PresentMode` *decided*, and answering them through the real renderer would
 * mean adding attributes to production components for a test's benefit. The
 * stand-ins expose exactly the two decisions and nothing else.
 */
vi.mock("@deckastra/renderer/react", () => ({
  SlideView: ({ scene }: { scene: { slideId: string } }) => (
    <div data-slide-stage={scene.slideId} />
  ),
}));

const LIVE_MOTION = '[data-slide-motion="[data-present-stage]"]';

vi.mock("../src/components/SlideMotion", () => ({
  // The root says which motion this is: present mode's own, on the live stage,
  // or a transition's final frame of the slide being left.
  SlideMotion: ({ autoPlay, rootSelector }: { autoPlay?: boolean; rootSelector?: string }) => (
    <div data-slide-motion={rootSelector ?? ""} data-autoplay={String(autoPlay ?? true)} />
  ),
}));

/** Every observer made during a test, so a case can hand them a size. */
let observers: { callback: ResizeObserverCallback; element: Element }[] = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

  // jsdom lays nothing out, so present mode measures zero and draws no stage at
  // all — which would make every assertion below vacuously true. This reports a
  // real size, which is the only way the stage exists to be counted.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observers.push({ callback: this.callback, element });
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function measure(width = 1920, height = 1080) {
  act(() => {
    for (const { callback, element } of observers) {
      callback(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      void element;
    }
  });
}

function present() {
  const scene = buildDocumentScene(loadFixture("animation"));
  const view = render(<PresentMode scene={scene} onExit={() => {}} channelName="back-test" />);
  measure();
  return { ...view, scene };
}

/** Stages currently mounted: two while a transition runs, one otherwise. */
function stages(container: HTMLElement): number {
  return container.querySelectorAll("[data-slide-stage]").length;
}

it("plays a transition going forward", () => {
  // The control for the case below. Without it, "one stage going back" would
  // pass just as well on a build that never transitions at all.
  const { container } = present();

  fireEvent.keyDown(window, { key: "ArrowRight" });

  expect(stages(container)).toBe(2);
});

it("plays no transition going back", () => {
  const { container } = present();

  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(stages(container)).toBe(2);

  fireEvent.keyDown(window, { key: "ArrowLeft" });

  // One stage: the slide is simply there. Running the transition would animate a
  // move the deck never made in that direction.
  expect(stages(container)).toBe(1);
});

it("shows a slide's final state rather than replaying its build", () => {
  // The second half of §26.3. `autoPlay` is what decides it, and a presenter
  // stepping back to answer a question must not have to click through the
  // reveal again to get there.
  const { container } = present();

  fireEvent.keyDown(window, { key: "ArrowRight" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });

  const motion = container.querySelector(LIVE_MOTION);
  expect(motion?.getAttribute("data-autoplay")).toBe("false");
});

it("starts playing again as soon as the presenter goes forward", () => {
  // Backwards is a property of the arrival, not a mode the deck gets stuck in.
  const { container } = present();

  fireEvent.keyDown(window, { key: "ArrowRight" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  fireEvent.keyDown(window, { key: "ArrowRight" });

  expect(container.querySelector(LIVE_MOTION)?.getAttribute("data-autoplay")).toBe(
    "true",
  );
  expect(stages(container)).toBe(2);
});

it("does not step back past the first slide", () => {
  present();

  fireEvent.keyDown(window, { key: "ArrowLeft" });

  expect(screen.getByText(/^\s*1 \/ \d+\s*$/)).toBeTruthy();
});

it("mounts the slide's motion only once the stage it animates exists", () => {
  // SlideMotion looks up the elements it animates under `[data-present-stage]`
  // when it mounts, and never again. Mounted in the first render — before the
  // container was measured and the stage drawn — it found nothing, so the slide
  // a talk started on never played its entrances or its click reveals. The
  // desktop presenter check found it: Next on the laptop changed slide instead
  // of revealing a bullet, because the projector's motion did not exist.
  const scene = buildDocumentScene(loadFixture("animation"));
  const { container } = render(<PresentMode scene={scene} onExit={() => {}} channelName="mount-test" />);

  expect(container.querySelector("[data-slide-stage]")).toBeNull();
  expect(container.querySelector(LIVE_MOTION)).toBeNull();

  measure();

  expect(container.querySelector("[data-slide-stage]")).not.toBeNull();
  expect(container.querySelector(LIVE_MOTION)).not.toBeNull();
});
