import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { RenderHostMessage, RenderHostRequest } from "@deckastra/workspace-contracts";

import {
  ElectronPage,
  HostConnection,
  electronHostFromEnvironment,
  inches,
  openElectronBrowser,
} from "../src/electron-backend";
import { openRenderBrowser } from "../src/render-page";

/**
 * The exporter's side of the render host, against a fake child process.
 *
 * The real host is Electron and is exercised by the desktop acceptance run; these
 * cases pin the parts that are this module's alone — what it starts, what it
 * refuses, and how it fails — because each of them was the difference between an
 * export that works and one that hangs with nothing saying why.
 */

class FakeChild extends EventEmitter {
  sent: RenderHostRequest[] = [];
  connected = true;
  exitCode: number | null = null;
  stderr = new EventEmitter();
  /** Answer each request with this, or leave it hanging when it returns undefined. */
  answer: (request: RenderHostRequest) => RenderHostMessage | undefined = (request) => ({
    type: "reply",
    id: request.id,
    ok: true,
    value: null,
  });

  send(message: RenderHostRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    const reply = this.answer(message);
    if (reply) queueMicrotask(() => this.emit("message", reply));
    return true;
  }

  ready(profile = "D:/tmp/profile") {
    this.emit("message", { type: "ready", profile } satisfies RenderHostMessage);
  }

  disconnect() {
    this.connected = false;
    this.exit(0);
  }

  kill() {
    this.exit(null, "SIGTERM");
    return true;
  }

  exit(code: number | null, signal: string | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit("exit", code, signal);
  }
}

const asChild = (fake: FakeChild) => fake as unknown as ChildProcess;

describe("configuration", () => {
  it("reads the binary and its arguments from the environment", () => {
    expect(
      electronHostFromEnvironment({
        DECKASTRA_RENDER_ELECTRON: "C:/Deckastra/Deckastra.exe",
        DECKASTRA_RENDER_ELECTRON_ARGS: '["D:/app"]',
      }),
    ).toEqual({ executable: "C:/Deckastra/Deckastra.exe", args: ["D:/app"] });
    // A packaged binary always runs its own bundle, so it needs no arguments.
    expect(electronHostFromEnvironment({ DECKASTRA_RENDER_ELECTRON: "Deckastra.exe" })).toEqual({
      executable: "Deckastra.exe",
      args: [],
    });
    expect(electronHostFromEnvironment({})).toBeUndefined();
  });

  it("refuses arguments that are not a list of strings", () => {
    expect(() =>
      electronHostFromEnvironment({ DECKASTRA_RENDER_ELECTRON: "x", DECKASTRA_RENDER_ELECTRON_ARGS: "--flag" }),
    ).toThrow(/JSON array of strings/);
    expect(() =>
      electronHostFromEnvironment({ DECKASTRA_RENDER_ELECTRON: "x", DECKASTRA_RENDER_ELECTRON_ARGS: "[1]" }),
    ).toThrow(/JSON array of strings/);
  });

  it("will not fall back to Playwright when the Electron backend is half-configured", async () => {
    // In a packaged app Playwright is not there either, so a fallback would
    // replace a clear packaging error with a confusing one.
    await expect(openRenderBrowser({ DECKASTRA_RENDER_BACKEND: "electron" })).rejects.toThrow(
      /needs DECKASTRA_RENDER_ELECTRON/,
    );
    await expect(openRenderBrowser({ DECKASTRA_RENDER_BACKEND: "firefox" })).rejects.toThrow(
      /Unknown render backend/,
    );
  });

  it("reads the lengths the exporter writes", () => {
    expect(inches("20in", 1)).toBe(20);
    expect(inches("11.25in", 1)).toBe(11.25);
    expect(inches("1920px", 1)).toBe(20);
    expect(inches(undefined, 7)).toBe(7);
    expect(() => inches("50%", 1)).toThrow(/Unsupported PDF length/);
  });
});

describe("starting the host", () => {
  it("starts the binary as an app, not as Node, with an IPC channel and no stdout", async () => {
    const fake = new FakeChild();
    const spawnStub = vi.fn(() => {
      queueMicrotask(() => fake.ready());
      return asChild(fake);
    });

    const previous = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      await openElectronBrowser({ executable: "Deckastra.exe", args: [] }, spawnStub as never);
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previous;
    }

    const [, , options] = spawnStub.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; stdio: unknown[] }];
    // The exporter inherited this; a child that kept it would start as plain
    // Node again, with no browser in it.
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env.DECKASTRA_RENDER_HOST).toBe("1");
    // IPC, because an Electron main process never receives piped stdin on
    // Windows — and stdout ignored, because ours is the export's JSON answer.
    expect(options.stdio).toEqual(["ignore", "ignore", "pipe", "ipc"]);
  });

  it("reports a host that dies before it is ready, with what it last said", async () => {
    const fake = new FakeChild();
    const connection = new HostConnection(asChild(fake));
    fake.stderr.emit("data", Buffer.from("[ERROR] the GPU process could not start\n"));
    fake.exit(3);
    await expect(connection.ready).rejects.toThrow(/exited \(3\).*GPU process could not start/s);
  });
});

describe("talking to the host", () => {
  it("matches replies to requests, and surfaces a host's refusal as an error", async () => {
    const fake = new FakeChild();
    fake.answer = (request) =>
      request.method === "newPage"
        ? { type: "reply", id: request.id, ok: true, value: 7 }
        : { type: "reply", id: request.id, ok: false, error: "No render page 99." };
    const connection = new HostConnection(asChild(fake));
    fake.ready();
    await connection.ready;

    await expect(connection.call("newPage", { scale: 2 })).resolves.toBe(7);
    await expect(connection.call("closePage", { pageId: 99 })).rejects.toThrow("No render page 99.");
  });

  it("fails every request still in flight when the host dies, instead of hanging", async () => {
    const fake = new FakeChild();
    fake.answer = () => undefined; // never answers
    const connection = new HostConnection(asChild(fake));
    fake.ready();
    await connection.ready;

    const inFlight = connection.call("setContent", { pageId: 1, html: "<p>" });
    fake.exit(null, "SIGKILL");
    // A hang here would sit until the export's overall timeout, and the job
    // would report "rendering" the whole time.
    await expect(inFlight).rejects.toThrow(/render host exited \(SIGKILL\)/);
    await expect(connection.call("closePage", { pageId: 1 })).rejects.toThrow(/exited/);
  });

  it("sends a function as source with its argument, and decodes binary answers", async () => {
    const fake = new FakeChild();
    fake.answer = (request) => ({
      type: "reply",
      id: request.id,
      ok: true,
      value: request.method === "screenshot" ? Buffer.from("PNGBYTES").toString("base64") : 42,
    });
    const connection = new HostConnection(asChild(fake));
    fake.ready();
    await connection.ready;
    const page = new ElectronPage(connection, 1);

    await expect(page.evaluate((arg: { a: number }) => arg.a * 2, { a: 21 })).resolves.toBe(42);
    const evaluate = fake.sent.find((request) => request.method === "evaluate")!;
    expect(evaluate.params).toMatchObject({ pageId: 1, arg: { a: 21 } });
    expect((evaluate.params as { source: string }).source).toContain("arg.a * 2");

    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 10, height: 10 } });
    expect(Buffer.from(png).toString()).toBe("PNGBYTES");
  });

  it("refuses PDF options it would otherwise silently ignore", async () => {
    const fake = new FakeChild();
    fake.answer = (request) => ({
      type: "reply",
      id: request.id,
      ok: true,
      value: request.method === "pdf" ? Buffer.from("%PDF-1.4").toString("base64") : null,
    });
    const connection = new HostConnection(asChild(fake));
    fake.ready();
    await connection.ready;
    const page = new ElectronPage(connection, 1);

    // A dropped option would produce a PDF that differs from the Playwright one
    // with nothing saying why.
    await expect(page.pdf({ margin: { top: "1in" } })).rejects.toThrow(/without margins/);
    await expect(page.pdf({ scale: 0.5 })).rejects.toThrow(/scale 1/);
    expect(fake.sent.filter((request) => request.method === "pdf")).toEqual([]);

    // The exporter's real options pass, converted to inches.
      await page.pdf({
        tagged: true,
        printBackground: true,
      width: "20in",
      height: "11.25in",
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      scale: 1,
      preferCSSPageSize: true,
    });
    expect(Buffer.from(await page.pdf({ width: "1920px" })).toString()).toBe("%PDF-1.4");
    expect(fake.sent.find((request) => request.method === "pdf")!.params).toMatchObject({
      widthIn: 20,
      heightIn: 11.25,
        printBackground: true,
        tagged: true,
    });
  });
});
