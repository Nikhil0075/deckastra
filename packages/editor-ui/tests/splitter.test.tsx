/**
 * The splitter between panes (UI audit 2026-10-10, unit 3): a drag is one
 * change, a cancelled drag is none, and everything a drag can do the keyboard
 * can do too.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Splitter, SPLITTER_BIG_STEP, SPLITTER_STEP } from "../src/ui/Splitter";

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = () => {
  const due = frames;
  frames = [];
  for (const frame of due) frame(0);
};

function setup(props: Partial<React.ComponentProps<typeof Splitter>> = {}) {
  const onChange = vi.fn();
  const onPreview = vi.fn();
  render(
    <Splitter
      label="Slides width"
      orientation="vertical"
      value={200}
      min={144}
      max={320}
      defaultValue={176}
      grows={1}
      onChange={onChange}
      onPreview={onPreview}
      {...props}
    />,
  );
  return { onChange, onPreview, line: screen.getByRole("separator", { name: props.label ?? "Slides width" }) };
}

describe("Splitter", () => {
  it("is a focusable, named window splitter that says where it is", () => {
    const { line } = setup();
    expect(line.getAttribute("aria-orientation")).toBe("vertical");
    expect(line.getAttribute("aria-valuenow")).toBe("200");
    expect(line.getAttribute("aria-valuemin")).toBe("144");
    expect(line.getAttribute("aria-valuemax")).toBe("320");
    expect(line.tabIndex).toBe(0);
  });

  it("shows a drag every frame and commits it once, on release", () => {
    const { line, onChange, onPreview } = setup();
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 340, pointerId: 1 });
    // Two moves in one frame are one preview, of the latest position.
    flush();
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith(240);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(line, { clientX: 340, pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(240);
  });

  it("commits a drag whose release reaches only the window", () => {
    const { line, onChange } = setup();
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 340, pointerId: 1 });
    // Released over the canvas, without the capture delivering it to the line.
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(240);
    // And only once: the line's own release afterwards finds no drag.
    fireEvent.pointerUp(line, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stops listening to the window once a drag ends", () => {
    const { line, onChange } = setup();
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(line, { clientX: 300, pointerId: 1 });
    fireEvent.mouseUp(window);
    fireEvent.pointerUp(window);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("grows toward its pane: a pane on its right gets wider as it moves left", () => {
    const { line, onChange } = setup({ grows: -1, value: 288, min: 280, max: 520, defaultValue: 288 });
    fireEvent.pointerDown(line, { button: 0, clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(line, { clientX: 900, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(388);
  });

  it("keeps a drag inside its limits", () => {
    const { line, onChange } = setup();
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(line, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(320);
  });

  it("puts a cancelled drag back and commits nothing", () => {
    const { line, onChange, onPreview } = setup();
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 340, pointerId: 1 });
    flush();
    fireEvent.pointerCancel(line, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(200);
  });

  it("commits nothing for a press that did not move", () => {
    const { line, onChange } = setup();
    fireEvent.pointerDown(line, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(line, { clientX: 300, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys, further with Shift, and to its ends with Home and End", () => {
    const { line, onChange } = setup({ value: 240 });
    fireEvent.keyDown(line, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(240 + SPLITTER_STEP);
    fireEvent.keyDown(line, { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(240 - SPLITTER_BIG_STEP);
    fireEvent.keyDown(line, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(144);
    fireEvent.keyDown(line, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(320);
  });

  it("reverses the arrows for a pane on its far side, and for a dock below it", () => {
    const right = setup({ grows: -1, label: "Side" });
    fireEvent.keyDown(right.line, { key: "ArrowLeft" });
    expect(right.onChange).toHaveBeenLastCalledWith(200 + SPLITTER_STEP);
    cleanup();
    const dock = setup({ grows: -1, orientation: "horizontal", label: "Dock" });
    fireEvent.keyDown(dock.line, { key: "ArrowUp" });
    expect(dock.onChange).toHaveBeenLastCalledWith(200 + SPLITTER_STEP);
    fireEvent.keyDown(dock.line, { key: "ArrowLeft" });
    expect(dock.onChange).toHaveBeenCalledTimes(1);
  });

  it("resets on Enter and on a double-click", () => {
    const { line, onChange } = setup();
    fireEvent.keyDown(line, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(176);
    fireEvent.doubleClick(line);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does not report a key that changes nothing", () => {
    const { line, onChange } = setup({ value: 320 });
    fireEvent.keyDown(line, { key: "End" });
    fireEvent.keyDown(line, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
