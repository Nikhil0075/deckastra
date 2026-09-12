"use client";

import type { OpenPresenterWindow, PresenterWindow } from "@deckastra/workspace-contracts";

/**
 * Open the presenter view in a second browser window.
 *
 * The default, and the only implementation that belongs in this package: it is
 * what a browser tab does. A desktop shell passes its own, which opens a real
 * second window on a second display and does not depend on `window.open`
 * surviving a pop-up blocker.
 *
 * The presenter route is this same URL with `presenter=1`, because the presenter
 * surface loads the deck itself rather than being handed one — so it survives a
 * reload and does not depend on the audience window staying open.
 */
export const browserPresenterWindow: OpenPresenterWindow = ({ channelName }) => {
  const url = `${window.location.pathname}?present=1&presenter=1&channel=${encodeURIComponent(channelName)}`;
  const opened = window.open(url, "deckastra-presenter", "width=1200,height=800");
  return opened ? wrap(opened) : null;
};

function wrap(target: Window): PresenterWindow {
  return {
    get closed() {
      return target.closed;
    },
    close: () => target.close(),
  };
}
