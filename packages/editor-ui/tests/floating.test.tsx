import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Menu, Popover, Select } from "../src/ui";
import { placePanel } from "../src/ui/floating";

/**
 * Pop-ups float above everything (design review, 2026-09-27). The colour,
 * shape and icon pickers were clipped by the scrolling inspector and looked as
 * though they had gone under the slide.
 */

afterEach(cleanup);

const viewport = { width: 1000, height: 800 };

it("places a panel below its trigger, aligned to the chosen edge", () => {
  const trigger = { left: 700, top: 100, width: 200, height: 30 };
  expect(placePanel(trigger, { width: 300, height: 200 }, viewport, { align: "end" })).toMatchObject({ left: 600, top: 134, side: "below" });
  expect(placePanel(trigger, { width: 250, height: 200 }, viewport, { align: "start" })).toMatchObject({ left: 700, side: "below" });
});

it("clamps inside the window instead of running off an edge", () => {
  const nearRight = { left: 900, top: 100, width: 80, height: 30 };
  expect(placePanel(nearRight, { width: 300, height: 100 }, viewport, { align: "start" }).left).toBe(1000 - 8 - 300);
  const nearLeft = { left: 10, top: 100, width: 40, height: 30 };
  expect(placePanel(nearLeft, { width: 300, height: 100 }, viewport, { align: "end" }).left).toBe(8);
});

it("opens upwards when there is more room above, and caps the height to the room it has", () => {
  const low = { left: 100, top: 700, width: 100, height: 30 };
  const placed = placePanel(low, { width: 200, height: 400 }, viewport, { align: "start" });
  expect(placed.side).toBe("above");
  expect(placed.top + Math.min(400, placed.maxHeight)).toBe(700 - 4);
  expect(placed.maxHeight).toBe(700 - 4 - 8);

  const middle = { left: 100, top: 380, width: 100, height: 30 };
  const tall = placePanel(middle, { width: 200, height: 1200 }, viewport, { align: "start" });
  expect(tall.side).toBe("below");
  expect(tall.maxHeight).toBe(800 - 410 - 4 - 8);
});

function Scroller({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="scroller" style={{ overflow: "auto", height: 40 }}>
      {children}
    </div>
  );
}

it("renders a popover's panel outside the scrolling panel that holds its trigger", () => {
  render(
    <Scroller>
      <Popover label="Colour" trigger={(props) => <button {...props}>Fill</button>}>
        <button>First</button>
        <button>Last</button>
      </Popover>
    </Scroller>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Fill" }));
  const panel = screen.getByRole("dialog", { name: "Colour" });
  expect(screen.getByTestId("scroller").contains(panel)).toBe(false);
  expect(panel.parentElement).toBe(document.body);

  // Outside presses and Escape still close it.
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog", { name: "Colour" })).toBeNull();
});

it("hands focus back to the trigger when Tab leaves the last control", () => {
  render(
    <Popover label="Colour" trigger={(props) => <button {...props}>Fill</button>}>
      <button>First</button>
      <button>Last</button>
    </Popover>,
  );
  const trigger = screen.getByRole("button", { name: "Fill" });
  fireEvent.click(trigger);
  const last = screen.getByRole("button", { name: "Last" });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(screen.queryByRole("dialog", { name: "Colour" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("portals menus and select lists too, and keeps choosing by click", () => {
  const chosen: string[] = [];
  render(
    <Scroller>
      <Menu label="Arrange" trigger={(props) => <button {...props}>More</button>} items={[{ id: "a", label: "Bring to front", onSelect: () => chosen.push("front") }]} />
      <Select label="Size" value="s" options={[{ value: "s", label: "Small" }, { value: "l", label: "Large" }]} onChange={(v) => chosen.push(v)} />
    </Scroller>,
  );
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  const menu = screen.getByRole("menu", { name: "Arrange" });
  expect(screen.getByTestId("scroller").contains(menu)).toBe(false);
  fireEvent.click(screen.getByRole("menuitem", { name: "Bring to front" }));

  fireEvent.click(screen.getByRole("button", { name: /Size/ }));
  const list = screen.getByRole("listbox");
  expect(screen.getByTestId("scroller").contains(list)).toBe(false);
  fireEvent.click(screen.getByRole("option", { name: "Large" }));
  expect(chosen).toEqual(["front", "l"]);
});
