import { describe, expect, it, vi } from "vitest";

/**
 * Who may ask, and what they may say (final package review, item 34).
 *
 * Electron's own objects are stood in for: what these check is ours — that a
 * request is answered only for the main frame of a window this app created, on
 * its own origin, and that what arrives is checked before it becomes a file
 * name, a buffer or a permission.
 */

const windows = new Map<object, { destroyed: boolean; known: boolean }>();
// One window object per web contents, as Electron does: the registry of app
// windows is identity-based, so a fake that minted a new object each call would
// make the positive case impossible and every refusal meaningless.
const byContents = new Map<object, { isDestroyed: () => boolean }>();

class FakeBrowserWindow {
  static fromWebContents(contents: object) {
    if (!windows.has(contents)) return null;
    if (!byContents.has(contents)) {
      byContents.set(contents, { isDestroyed: () => windows.get(contents)!.destroyed });
    }
    return byContents.get(contents) as never;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { handle: () => {}, on: () => {} },
}));

const { asBoolean, asBytes, asFileName, asId, asRecord, asText, registerAppWindow, senderWindow } = await import(
  "../src/main/ipc-guard"
);
const { APP_ORIGIN } = await import("../src/main/protocol");

/** An event as Electron delivers it, with whatever frame the test wants. */
function request({
  url = `${APP_ORIGIN}/index.html`,
  parent = null,
  known = true,
  destroyed = false,
  frame = true,
}: { url?: string; parent?: unknown; known?: boolean; destroyed?: boolean; frame?: boolean } = {}) {
  const contents = {};
  windows.set(contents, { destroyed, known });
  const window = FakeBrowserWindow.fromWebContents(contents)!;
  if (known) registerAppWindow(window as never);
  return { sender: contents, senderFrame: frame ? { url, parent } : null } as never;
}

describe("who may ask", () => {
  it("answers the main frame of a window this app opened", () => {
    expect(senderWindow(request())).not.toBeNull();
  });

  it.each([
    ["a page on another origin", { url: "https://example.com/" }],
    ["a page loaded from the file system", { url: "file:///C:/anything.html" }],
    // Our own origin as a *prefix* of someone else's is not our origin.
    ["an origin that merely starts the same", { url: `${APP_ORIGIN}.evil.example/index.html` }],
    ["a sub-frame, even on our origin", { parent: {} }],
    ["a window this app did not open", { known: false }],
    ["a window that has gone", { destroyed: true }],
    ["a sender with no frame at all", { frame: false }],
  ])("refuses %s", (_name, options) => {
    expect(senderWindow(request(options))).toBeNull();
  });
});

describe("what they may say", () => {
  it("takes an id this product minted, and nothing shaped like a path", () => {
    expect(asId("doc_01M2XB4S7AGP09CR288A7E6T50", "doc")).toBe("doc_01M2XB4S7AGP09CR288A7E6T50");
    for (const bad of ["../../etc/passwd", "doc_short", "prs_01M2XB4S7AGP09CR288A7E6T50", "", 42, null]) {
      expect(() => asId(bad, "doc")).toThrow();
    }
  });

  it("takes a file name, never a path", () => {
    expect(asFileName("deck.pdf", "name")).toBe("deck.pdf");
    for (const bad of ["../deck.pdf", "C:\\Windows\\System32\\drivers\\etc\\hosts", "a/b.pdf", "..", "."]) {
      expect(() => asFileName(bad, "name")).toThrow();
    }
  });

  it("refuses text with a null character, which truncates a path wherever it lands", () => {
    expect(() => asText("deck\0.pdf", "name", 100)).toThrow();
  });

  it("bounds what one save may write", () => {
    expect(asBytes(new Uint8Array([1, 2, 3]), "file", 10).byteLength).toBe(3);
    expect(() => asBytes(new Uint8Array(20), "file", 10)).toThrow(/larger/);
    expect(() => asBytes("not bytes", "file", 10)).toThrow();
  });

  it("refuses a permission that is not a yes or a no", () => {
    expect(asBoolean(true, "allow")).toBe(true);
    for (const bad of ["true", 1, null, undefined]) expect(() => asBoolean(bad, "allow")).toThrow();
  });

  it("refuses a payload that is not an object", () => {
    expect(() => asRecord("allow=true")).toThrow();
    expect(() => asRecord(null)).toThrow();
    expect(asRecord({ allow: true })).toEqual({ allow: true });
  });
});
