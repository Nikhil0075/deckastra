import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ModeSwitch } from "../src/components/shell/AppBar";
import { modeForCommand } from "../src/lib/host-commands";

/**
 * The bar's modes (2026-10-12): Design and Motion on the bar, Narration &
 * sound, Code and Import & generate one menu after them, and the menu button
 * naming whichever of those is in use.
 */

afterEach(cleanup);

it("puts Design and Motion on the bar and the other modes in one menu", () => {
  const onMode = vi.fn();
  render(<ModeSwitch mode="design" onMode={onMode} />);
  expect(screen.getByTestId("mode-design")).toBeTruthy();
  expect(screen.getByTestId("mode-motion")).toBeTruthy();
  expect(screen.queryByTestId("mode-code")).toBeNull();
  expect(screen.getByTestId("mode-more").textContent).toContain("More");

  fireEvent.click(screen.getByTestId("mode-more"));
  expect(screen.getByTestId("mode-narration").textContent).toContain("Narration & sound");
  expect(screen.getByTestId("mode-media").textContent).toContain("Import & generate");
  fireEvent.click(screen.getByTestId("mode-code"));
  expect(onMode).toHaveBeenCalledWith("code");
});

it("names the mode in use on the menu button, so the bar always says where you are", () => {
  render(<ModeSwitch mode="narration" onMode={() => undefined} />);
  const more = screen.getByTestId("mode-more");
  expect(more.textContent).toContain("Narration & sound");
  expect(more.dataset.mode).toBe("narration");
  expect(more.getAttribute("aria-label")).toBe("Narration & sound. More modes");
  // Neither bar button reads as selected while a menu mode is on.
  expect(screen.getByTestId("mode-design").getAttribute("aria-checked")).not.toBe("true");
});

it("reaches the new modes from the desktop menu and the palette", () => {
  expect(modeForCommand("mode-narration")).toBe("narration");
  expect(modeForCommand("mode-media")).toBe("media");
});
