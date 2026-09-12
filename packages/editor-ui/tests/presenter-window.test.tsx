import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { buildDocumentScene } from "@deckastra/renderer";
import type { OpenPresenterWindow } from "@deckastra/workspace-contracts";

import { PresentMode } from "../src/components/PresentMode";
import { browserPresenterWindow } from "../src/lib/presenter-window";

/**
 * The one browser assumption present mode still makes, and the seam that lets a
 * packaged app replace it.
 *
 * `window.open` is right in a tab and wrong in a desktop shell, which opens a
 * real second window it can place on a second display. The point of these cases
 * is that `PresentMode` never learns which it is mounted in.
 */

beforeEach(() => {
  // jsdom has no media queries and no layout. Present mode asks for both on
  // mount; neither is what these cases are about.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function scene() {
  return buildDocumentScene(loadFixture("technical"));
}

it("opens the presenter view through the injected host, not through window.open", () => {
  const open = vi.fn<OpenPresenterWindow>(() => ({ closed: false, close: () => {} }));
  const windowOpen = vi.fn();
  vi.stubGlobal("open", windowOpen);

  render(
    <PresentMode
      scene={scene()}
      onExit={() => {}}
      channelName="deckastra-present-test"
      openPresenter={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Second screen" }));

  // The channel name is the whole payload: the shell decides the route, but it
  // must not decide the bus, or the two halves never find each other.
  expect(open).toHaveBeenCalledWith({ channelName: "deckastra-present-test" });
  expect(windowOpen).not.toHaveBeenCalled();
});

it("keeps presenting when the host cannot open a window", () => {
  // A blocked pop-up is something the user did, not an error. The audience view
  // has to carry on regardless — a presenter mid-room does not get a second try.
  render(
    <PresentMode
      scene={scene()}
      onExit={() => {}}
      channelName="deckastra-present-test"
      openPresenter={() => null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Second screen" }));

  expect(screen.getByRole("button", { name: "Second screen" })).toBeTruthy();
  expect(screen.getByText(/^\s*1 \/ \d+\s*$/)).toBeTruthy();
});

it("the browser default asks for the presenter route on the current path", () => {
  const opened = { closed: false, close: vi.fn() };
  const windowOpen = vi.fn(() => opened as unknown as Window);
  vi.stubGlobal("open", windowOpen);

  const handle = browserPresenterWindow({ channelName: "chan nel" });

  const [url, target] = windowOpen.mock.calls[0]! as unknown as [string, string];
  // The presenter surface loads the deck itself rather than being handed one, so
  // it survives a reload and does not depend on the audience window staying open.
  expect(url).toBe("/?present=1&presenter=1&channel=chan%20nel");
  expect(target).toBe("deckastra-presenter");

  // A live view of the window, not a snapshot: the caller asks whether it is
  // still there, and a copied boolean would say yes forever.
  expect(handle!.closed).toBe(false);
  opened.closed = true;
  expect(handle!.closed).toBe(true);
  handle!.close();
  expect(opened.close).toHaveBeenCalled();
});

it("reports a blocked pop-up as null rather than throwing", () => {
  vi.stubGlobal("open", () => null);
  expect(browserPresenterWindow({ channelName: "c" })).toBeNull();
});
