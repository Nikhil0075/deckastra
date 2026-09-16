/**
 * Both slides on screen while one arrives (D4.1 wiring).
 *
 * The engine's own tests prove what a transition *is*; these prove the thing
 * only a mounted component can be wrong about — that the outgoing slide is
 * actually present while it runs and actually gone afterwards, and that a cut
 * never mounts a second stage or starts a frame loop.
 *
 * That matters because it is the whole reason this component exists. A morph
 * animates an element from where it was to where it now is, and where it was is
 * on the slide the previous implementation had already unmounted.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileTransition, type TransitionSlide } from "@deckastra/animation-engine";

import { SlideTransition } from "../src/components/SlideTransition";

afterEach(cleanup);

/**
 * Frames, driven by hand.
 *
 * jsdom registers `requestAnimationFrame` and never calls anything back, so a
 * test that waited for a real frame would wait for ever. Driving them is better
 * than fixing that: the component samples from the timestamp it is handed, so
 * supplying one is how a test asks "what does this look like 200ms in" without
 * waiting 200ms — the same property that makes seeking and playing agree.
 */
function frameDriver() {
  const pending = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = next++;
    pending.set(handle, callback);
    return handle;
  });
  // Actually cancels. A stub that ignores this is lying about the platform, and
  // a test written against it reports a late callback the browser would never
  // have delivered.
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    pending.delete(handle);
  });
  return {
    advance(to: number) {
      const [handle, callback] = [...pending][0] ?? [];
      if (handle === undefined || !callback) return;
      pending.delete(handle);
      act(() => callback(to));
    },
    get queued() {
      return pending.size;
    },
  };
}

vi.mock("@deckastra/renderer/react", () => ({
  SlideView: ({ scene }: { scene: { slideId: string } }) => <div data-testid={scene.slideId} />,
}));

function scene(slideId: string, transition?: Record<string, unknown>) {
  return {
    slideId,
    index: 0,
    width: 1920,
    height: 1080,
    nodes: [],
    paintOrder: [],
    theme: {},
    transition,
  } as never;
}

const empty: TransitionSlide = { id: "x", nodes: [] };

function compiled(spec: Record<string, unknown> | undefined, options = {}) {
  return compileTransition(spec, empty, empty, options);
}

describe("mounting both slides", () => {
  it("keeps the outgoing slide up while the transition runs", async () => {
    render(
      <SlideTransition
        compiled={compiled({ type: "fade", durationMs: 400 })}
        to={scene("s2")}
        from={scene("s1")}
        width={960}
        height={540}
        scale={0.5}
      />,
    );

    // The one thing the previous implementation could never do.
    expect(screen.getByTestId("s1")).toBeTruthy();
    expect(screen.getByTestId("s2")).toBeTruthy();
  });

  it("drops the outgoing slide when it finishes, and says so once", async () => {
    const frames = frameDriver();
    const onDone = vi.fn();
    render(
      <SlideTransition
        compiled={compiled({ type: "fade", durationMs: 400 })}
        to={scene("s2")}
        from={scene("s1")}
        width={960}
        height={540}
        scale={0.5}
        onDone={onDone}
      />,
    );

    // Partway: both slides still up, and it has asked for another frame.
    frames.advance(performance.now() + 200);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId("s1")).toBeTruthy();
    expect(frames.queued).toBe(1);

    // Past the end: finished, and asking for nothing further.
    frames.advance(performance.now() + 5_000);
    await waitFor(() => expect(screen.queryByTestId("s1")).toBeNull());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(frames.queued).toBe(0);
    expect(screen.getByTestId("s2")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("mounts one stage for a cut and never starts a loop", async () => {
    const frames = frameDriver();
    const onDone = vi.fn();

    render(
      <SlideTransition
        compiled={compiled({ type: "fade" }, { motion: "reduced" })}
        to={scene("s2")}
        from={scene("s1")}
        width={960}
        height={540}
        scale={0.5}
        onDone={onDone}
      />,
    );

    // Reduced motion, the first slide and a zero duration all land here, and
    // none of them should pay for a frame loop.
    expect(screen.queryByTestId("s1")).toBeNull();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(frames.queued).toBe(0);
    vi.unstubAllGlobals();
  });

  it("stops cleanly when a presenter advances mid-transition", () => {
    // Two presses of the right arrow in quick succession. The first transition
    // is torn down partway through, and its callback must not fire afterwards:
    // `onDone` is what tells the caller to drop the outgoing slide, and a late
    // one would drop the slide the *new* transition is animating out of.
    const frames = frameDriver();
    const onDone = vi.fn();
    const { unmount } = render(
      <SlideTransition
        compiled={compiled({ type: "morph", durationMs: 600 })}
        to={scene("s2")}
        from={scene("s1")}
        width={960}
        height={540}
        scale={0.5}
        onDone={onDone}
      />,
    );

    frames.advance(performance.now() + 100);
    unmount();
    // Whatever frames were in flight when the presenter pressed again.
    frames.advance(performance.now() + 5_000);

    expect(onDone).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("marks only the arriving slide as the live stage", () => {
    // The motion adapter looks elements up inside this attribute. With both
    // slides mounted and sharing element ids, marking both would let the
    // outgoing copy be styled by the incoming slide's entrance.
    const { container } = render(
      <SlideTransition
        compiled={compiled({ type: "fade", durationMs: 400 })}
        to={scene("s2")}
        from={scene("s1")}
        width={960}
        height={540}
        scale={0.5}
      />,
    );

    expect(container.querySelectorAll("[data-present-stage]")).toHaveLength(1);
  });
});
