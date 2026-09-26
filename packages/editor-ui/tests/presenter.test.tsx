/**
 * The presenter view and its protocol (Phase 3).
 *
 * Three things a presenter depends on in front of a room:
 *
 * 1. "Step 3 of 4" is counted from the same compiled timeline the audience
 *    window plays, so the laptop and the projector cannot disagree.
 * 2. Next on the laptop is an *advance* — it reveals the next bullet on the
 *    projector before it changes slide — carried to the audience window as a
 *    command, because only that window plays the motion.
 * 3. Time left against a target reads as time *over* once past it, since
 *    that is the number a presenter needs.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";

import { clickSteps, formatDuration, formatTimer, remaining, stepLabel } from "../src/lib/presenter";
import { PresentChannel, type SyncMessage } from "../src/lib/presentSync";
import { PresenterView } from "../src/components/PresenterView";

vi.mock("@deckastra/renderer/react", () => ({
  ScaledSlide: ({ scene }: { scene: { slideId: string } }) => <div data-preview={scene.slideId} />,
}));

const scene = buildDocumentScene(loadFixture("animation"));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("click steps", () => {
  it("counts the reveals a slide is clicked through, and none for a slide without", () => {
    const counts = scene.slides.map((slide) => clickSteps(slide, false));
    // The fixture's second slide is its click-reveal slide.
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts.some((count) => count === 0)).toBe(true);
  });

  it("labels states, not clicks, and says nothing for a slide with no reveals", () => {
    expect(stepLabel({ step: 2, steps: 3 })).toBe("Step 3 of 4");
    expect(stepLabel({ step: 0, steps: 3 })).toBe("Step 1 of 4");
    expect(stepLabel({ step: 9, steps: 3 })).toBe("Step 4 of 4");
    expect(stepLabel({ step: 0, steps: 0 })).toBeNull();
  });
});

describe("time", () => {
  it("formats the elapsed timer with hours, as the Figma frame draws it", () => {
    expect(formatTimer(252_000)).toBe("00:04:12");
    expect(formatTimer(3_723_000)).toBe("01:02:03");
    expect(formatDuration(348_000)).toBe("05:48");
  });

  it("counts down to the target, then counts time over", () => {
    expect(remaining(600_000, 251_500)).toEqual({ text: "05:49", over: false });
    expect(remaining(600_000, 600_000)).toEqual({ text: "00:00", over: false });
    expect(remaining(600_000, 672_000)).toEqual({ text: "+01:12", over: true });
  });
});

describe("the sync protocol", () => {
  class FakeChannel {
    readonly posted: SyncMessage[] = [];
    onmessage: ((event: MessageEvent<SyncMessage>) => void) | null = null;
    postMessage(message: SyncMessage) {
      this.posted.push(message);
    }
    close() {}
    deliver(message: SyncMessage) {
      this.onmessage?.({ data: message } as MessageEvent<SyncMessage>);
    }
  }

  function open(handlers: Partial<ConstructorParameters<typeof PresentChannel>[1]>) {
    const fake = new FakeChannel();
    const channel = new PresentChannel(
      "test",
      { onIndex: vi.fn(), currentIndex: () => 0, slideCount: () => 4, ...handlers },
      () => fake as unknown as BroadcastChannel,
    );
    channel.open();
    return { channel, fake };
  }

  it("carries the audience window's step and blackout to the presenter, clamping the index", () => {
    const onState = vi.fn();
    const { fake } = open({ onState });
    fake.deliver({ type: "state", index: 99, step: 2, blacked: true });
    expect(onState).toHaveBeenCalledWith({ index: 3, step: 2, blacked: true });
  });

  it("carries only the two commands there are, and ignores anything else", () => {
    const onCommand = vi.fn();
    const { fake } = open({ onCommand });
    fake.deliver({ type: "command", action: "advance", delta: 1 });
    fake.deliver({ type: "command", action: "black" });
    fake.deliver({ type: "command", action: "advance", delta: 5 as never });
    fake.deliver({ type: "command", action: "delete" as never });
    expect(onCommand.mock.calls).toEqual([[{ action: "advance", delta: 1 }], [{ action: "black" }]]);
  });

  it("answers a late presenter window with the full state, not just the slide", () => {
    const { fake } = open({ currentState: () => ({ index: 2, step: 1, blacked: false }), currentIndex: () => 2 });
    fake.posted.length = 0;
    fake.deliver({ type: "hello" });
    expect(fake.posted).toEqual([
      { type: "index", index: 2 },
      { type: "state", index: 2, step: 1, blacked: false },
    ]);
  });
});

describe("PresenterView", () => {
  function renderView(overrides: Partial<Parameters<typeof PresenterView>[0]> = {}) {
    const mocks = { onAdvance: vi.fn(), onJump: vi.fn(), onBlack: vi.fn(), onExit: vi.fn() };
    render(
      <PresenterView
        scene={scene}
        index={1}
        step={1}
        steps={3}
        blacked={false}
        startedAt={Date.now()}
        {...mocks}
        {...overrides}
      />,
    );
    return mocks;
  }

  it("shows where the talk is within the slide", () => {
    renderView();
    expect(screen.getByTestId("presenter-step").textContent).toContain("Step 2 of 4");
  });

  it("says a slide has no reveals rather than 'Step 1 of 1'", () => {
    renderView({ step: 0, steps: 0 });
    expect(screen.queryByTestId("presenter-step")).toBeNull();
    expect(screen.getByText("No click reveals on this slide")).toBeTruthy();
  });

  it("advances rather than jumps, and jumps from the numbered squares", () => {
    const props = renderView();
    fireEvent.click(screen.getByTestId("presenter-next"));
    fireEvent.click(screen.getByTestId("presenter-prev"));
    expect(props.onAdvance.mock.calls).toEqual([[1], [-1]]);
    fireEvent.click(screen.getByRole("button", { name: "Go to slide 4" }));
    expect(props.onJump).toHaveBeenCalledWith(3);
  });

  it("cannot go back from the first state or forward from the last", () => {
    renderView({ index: 0, step: 0 });
    expect((screen.getByTestId("presenter-prev") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderView({ index: scene.slides.length - 1, step: 3, steps: 3 });
    expect((screen.getByTestId("presenter-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("blacks the screen out, and says so on the preview", () => {
    const props = renderView({ blacked: true });
    expect(screen.getByText("Screen is black")).toBeTruthy();
    fireEvent.click(screen.getByTestId("presenter-black"));
    expect(props.onBlack).toHaveBeenCalledOnce();
    expect(screen.getByTestId("presenter-black").textContent).toBe("Show slide");
  });

  it("counts down only once a target is set, and says 'over' past it", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
    const startedAt = Date.now() - 21 * 60_000;
    renderView({ startedAt });
    // No target yet: no countdown pretending to know the slot.
    expect(screen.queryByText(/over/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set 20 min" }));
    expect(screen.getByText("+01:00")).toBeTruthy();
    expect(screen.getByText("over")).toBeTruthy();
  });
});
