import { Blob } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import type { DesktopBridge, OpenPresenterRequest } from "../src/shared/ipc";
import { desktopHost } from "../src/renderer/host";

/**
 * The host bridge, and the one thing it has to reconcile.
 *
 * `HostBridge.openPresenterWindow` is synchronous because a browser only honours
 * a window-opening gesture inside the task that handled the click. IPC is not.
 * These cases pin the resolution: the message is *sent* in the caller's task and
 * the handle is answered locally, so one component works in both shells.
 */

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    info: async () => ({
      appVersion: "0",
      electronVersion: "0",
      chromeVersion: "0",
      platform: "test",
      build: null,
      dataDir: "/tmp",
    }),
    currentPresentation: async () => ({ presentationId: "doc_test" }),
    openPresentation: async ({ presentationId }) => ({ presentationId }),
    saveFile: async () => ({ saved: false }),
    writeClipboardText: async () => {},
    openPresenter: () => {},
    closePresenter: () => {},
    onPresenterClosed: () => () => {},
    onServiceStatus: () => () => {},
    onCollectJournals: () => () => {},
    onRestoreJournals: () => () => {},
    restartService: async () => ({ state: "failed" as const, attempt: 1 }),
    agentAccess: async () => ({ allowed: false, scopes: [], expiresAt: null, decidedAt: null }),
    setAgentAccess: async ({ allow }) => ({
      allowed: allow,
      scopes: allow ? ["read", "write", "export"] : [],
      expiresAt: allow ? new Date(Date.now() + 3_600_000).toISOString() : null,
      decidedAt: new Date().toISOString(),
    }),
    onAgentAccess: () => () => {},
    onMenuCommand: () => () => {},
    onPrepareToClose: () => () => {},
    cloudKey: async () => ({ set: false, updatedAt: null, storable: true }),
    setCloudKey: async () => ({ set: false, updatedAt: null, storable: true }),
    ...overrides,
  };
}

describe("the desktop host", () => {
  it("sends the open message in the caller's own task", () => {
    const openPresenter = vi.fn<(request: OpenPresenterRequest) => void>();
    const host = desktopHost(bridge({ openPresenter }));

    const handle = host.openPresenterWindow({ channelName: "chan" });

    // No await anywhere above. If this were an `invoke`, the window would open a
    // microtask later and a browser would have called that a pop-up.
    expect(openPresenter).toHaveBeenCalledTimes(1);
    expect(openPresenter.mock.calls[0]![0]!.channelName).toBe("chan");
    expect(handle).not.toBeNull();
  });

  it("reports a window closed by anyone, not only by us", () => {
    let notify: ((id: string) => void) | undefined;
    const openPresenter = vi.fn<(request: OpenPresenterRequest) => void>();
    const host = desktopHost(
      bridge({
        openPresenter,
        onPresenterClosed: (listener) => {
          notify = listener;
          return () => {};
        },
      }),
    );

    const handle = host.openPresenterWindow({ channelName: "chan" })!;
    expect(handle.closed).toBe(false);

    // The user closing the window, a crash, the app quitting — main pushes the
    // same message, so a handle that only knew about polite closures would lie.
    notify!(openPresenter.mock.calls[0]![0]!.id);
    expect(handle.closed).toBe(true);
  });

  it("closes the window it opened, by its own id", () => {
    const openPresenter = vi.fn<(request: OpenPresenterRequest) => void>();
    const closePresenter = vi.fn<(id: string) => void>();
    const host = desktopHost(bridge({ openPresenter, closePresenter }));

    host.openPresenterWindow({ channelName: "chan" })!.close();

    expect(closePresenter).toHaveBeenCalledWith(openPresenter.mock.calls[0]![0]!.id);
  });

  it("hands bytes to the shell and treats a cancelled dialog as a decision", async () => {
    const saveFile = vi.fn<DesktopBridge["saveFile"]>(async () => ({ saved: false }));
    const host = desktopHost(bridge({ saveFile }));

    // Not a blob URL: a packaged renderer cannot start a download, so the main
    // process is the only thing that can put a file where the user asked.
    await expect(
      host.saveFile({
        // Node's Blob, because jsdom's has no `arrayBuffer()`. A real renderer's
        // does; this is a gap in the test environment, not in the bridge.
        bytes: new Blob([new Uint8Array([1, 2, 3])]) as unknown as globalThis.Blob,
        suggestedName: "deck.pdf",
        contentType: "application/pdf",
      }),
    ).resolves.toBeUndefined();

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect([...saveFile.mock.calls[0]![0]!.bytes]).toEqual([1, 2, 3]);
  });

  it("says which shell it is, without letting anything branch on features", () => {
    expect(desktopHost(bridge()).kind).toBe("desktop");
  });
});
