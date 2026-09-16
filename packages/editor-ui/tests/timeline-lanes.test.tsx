/**
 * Dragging clips on the timeline (D4.2, doc 04 §25.2, §31.2).
 *
 * The operation builders are tested where they live. What only a mounted drag
 * surface can be wrong about is the *gesture*: whether a cancelled drag writes
 * anything, whether the pointer is read once per frame or once per event, and
 * whether the value committed is rounded once at the end rather than at every
 * step.
 *
 * Frames are driven by hand for the same reason the transition test drives them:
 * jsdom registers `requestAnimationFrame` and never calls anything back, so a
 * test that waited for a real frame would wait for ever — and driving them is
 * how you ask what one frame did without depending on a clock.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineView } from "@deckastra/animation-engine";

import { TimelineLanes, type TimelineGesture } from "../src/components/TimelineLanes";

afterEach(cleanup);

/**
 * jsdom has no `PointerEvent`, so Testing Library falls back to a plain `Event`
 * — which carries no `clientX` and no `shiftKey`. A drag test against that is
 * measuring undefined, and it *looks* like the component ignoring the pointer.
 * Extending `MouseEvent` gives back exactly the fields these handlers read.
 */
class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

// Re-stubbed per test and cleared in one place. Doing the clearing inside a test
// removed the polyfill for every test after it, and those then read undefined
// coordinates — which looks exactly like the component ignoring the pointer.
beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frameDriver() {
  const pending: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    flush() {
      const queued = pending.splice(0, pending.length);
      act(() => {
        for (const callback of queued) callback(performance.now());
      });
    },
    get queued() {
      return pending.length;
    },
  };
}

const view: TimelineView = {
  lanes: [
    {
      targetId: "el_1",
      label: "Headline",
      bars: [
        {
          clipId: "clp_1",
          trackId: "anm_1",
          targetId: "el_1",
          label: "fade",
          startMs: 200,
          endMs: 600,
          segment: 0,
          preset: "fade",
          conflicted: false,
        },
      ],
    },
  ],
  durationMs: 1000,
  segments: [],
  ticks: [0, 1000],
  warnings: [],
  budget: { limitMs: 2500, entranceMs: 600, exceeded: false },
};

/** A lane 1000px wide, so one pixel is one millisecond and the arithmetic is readable. */
function sizeTheLane() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const isBar = this.getAttribute("role") === "button";
    return {
      width: 1000,
      height: 20,
      left: 0,
      right: isBar ? 600 : 1000,
      top: 0,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function bar() {
  return screen.getByRole("button", { name: /fade/ });
}

function mount(onCommit: (gesture: TimelineGesture) => void) {
  return render(
    <TimelineLanes
      view={view}
      selectedClipId={null}
      playheadMs={0}
      onSelect={() => {}}
      onCommit={onCommit}
    />,
  );
}

describe("dragging a clip", () => {
  it("commits once, on pointer-up, with a rounded value", () => {
    sizeTheLane();
    const frames = frameDriver();
    const onCommit = vi.fn();
    mount(onCommit);

    fireEvent.pointerDown(bar(), { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 420.6 });
    frames.flush();

    // Nothing is written while the pointer is down: the document changes once,
    // when the author lets go.
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(bar(), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const gesture = onCommit.mock.calls[0]![0] as TimelineGesture;
    expect(gesture.kind).toBe("move");
    // 200 + 120.6, rounded exactly once at the end rather than per frame.
    expect(gesture.startMs).toBe(321);
    expect(Number.isInteger(gesture.durationMs)).toBe(true);
  });

  it("coalesces many moves into one frame", () => {
    // Doc 04 §31.2. Handling every pointermove is what drops frames on a dense
    // slide, and the budget is judged as dropped frames rather than milliseconds.
    sizeTheLane();
    const frames = frameDriver();
    mount(() => {});

    fireEvent.pointerDown(bar(), { pointerId: 1, clientX: 300 });
    for (let x = 301; x <= 340; x += 1) fireEvent.pointerMove(bar(), { pointerId: 1, clientX: x });

    expect(frames.queued).toBe(1);
  });

  it("writes nothing when the gesture is cancelled", () => {
    // Losing capture is a system dialog, a dragged-out pointer, a touch
    // interrupted by a call. Committing wherever the pointer happened to be is
    // how a clip lands somewhere nobody chose.
    sizeTheLane();
    const frames = frameDriver();
    const onCommit = vi.fn();
    mount(onCommit);

    fireEvent.pointerDown(bar(), { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 500 });
    frames.flush();
    fireEvent.pointerCancel(bar(), { pointerId: 1 });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("trims from the right edge rather than moving", () => {
    sizeTheLane();
    const frames = frameDriver();
    const onCommit = vi.fn();
    mount(onCommit);

    // The bar's right edge is at 600 in this layout; within EDGE_PX of it.
    fireEvent.pointerDown(bar(), { pointerId: 1, clientX: 596 });
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 700 });
    frames.flush();
    fireEvent.pointerUp(bar(), { pointerId: 1 });

    const gesture = onCommit.mock.calls[0]![0] as TimelineGesture;
    expect(gesture.kind).toBe("trim");
    expect(gesture.startMs).toBe(200);
    expect(gesture.durationMs).toBe(504);
  });

  it("asks for a ripple when Shift is held", () => {
    sizeTheLane();
    const frames = frameDriver();
    const onCommit = vi.fn();
    mount(onCommit);

    fireEvent.pointerDown(bar(), { pointerId: 1, clientX: 596 });
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 700, shiftKey: true });
    frames.flush();
    fireEvent.pointerUp(bar(), { pointerId: 1 });

    expect((onCommit.mock.calls[0]![0] as TimelineGesture).ripple).toBe(true);
  });

  it("selects on a plain click, without a drag", () => {
    // The bar claims `role="button"`, so it has to answer a click whoever
    // produced it — a keyboard, an assistive technology, a test.
    const onSelect = vi.fn();
    render(
      <TimelineLanes
        view={view}
        selectedClipId={null}
        playheadMs={0}
        onSelect={onSelect}
        onCommit={() => {}}
      />,
    );

    fireEvent.click(bar());
    expect(onSelect).toHaveBeenCalledWith("clp_1");
  });
});
