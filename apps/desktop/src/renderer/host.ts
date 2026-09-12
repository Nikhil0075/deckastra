import type { HostBridge, OpenPresenterWindow, PresenterWindow } from "@deckastra/workspace-contracts";

import type { DesktopBridge } from "../shared/ipc";

/**
 * `HostBridge`, implemented on the preload channel.
 *
 * The editor is written against `HostBridge` and knows nothing about Electron;
 * this is the fifteen lines that connect the two. Its only real work is turning
 * an asynchronous, message-passing world into the synchronous handle
 * `openPresenterWindow` promises — see below for why that promise is worth
 * keeping.
 */
export function desktopHost(bridge: DesktopBridge): HostBridge {
  /**
   * Presenter windows this renderer opened, and whether each is still there.
   *
   * `PresenterWindow.closed` has to answer immediately, so it cannot ask the main
   * process. Instead main pushes closures and this set remembers them — which
   * also means a window the *user* closed is reported correctly, not just one the
   * app closed.
   */
  const closed = new Set<string>();
  bridge.onPresenterClosed((id) => closed.add(id));

  const openPresenterWindow: OpenPresenterWindow = ({ channelName }) => {
    // Allocated here rather than awaited from main: the contract is synchronous
    // because a window-opening gesture only counts inside the task that handled
    // the click, and the browser shell has to obey that. Keeping the same
    // contract on the desktop is what lets one component serve both.
    const id = crypto.randomUUID();
    bridge.openPresenter({ id, channelName });
    return handle(id);
  };

  function handle(id: string): PresenterWindow {
    return {
      get closed() {
        return closed.has(id);
      },
      close: () => bridge.closePresenter(id),
    };
  }

  return {
    kind: "desktop",

    async saveFile(file) {
      // Bytes across the bridge, then a native dialog. A packaged renderer cannot
      // start a download and a blob URL is inert there, so the main process is
      // the only thing that can actually put a file where the user asked.
      const bytes = new Uint8Array(await file.bytes.arrayBuffer());
      await bridge.saveFile({
        bytes,
        suggestedName: file.suggestedName,
        contentType: file.contentType,
      });
      // A cancelled dialog is a decision, not a failure. Nothing is thrown.
    },

    openPresenterWindow,
  };
}
