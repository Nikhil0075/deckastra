import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type {
  RenderHostMessage,
  RenderHostMethod,
  RenderHostRequest,
} from "@deckastra/workspace-contracts";

import type { PdfOptions, RenderBrowser, RenderPage, ScreenshotOptions } from "./render-page";

/**
 * Rendering with the desktop app's own Chromium.
 *
 * The exporter runs as Electron in Node mode (`ELECTRON_RUN_AS_NODE=1`), which
 * has no browser in it. So it starts a second copy of the same binary *as an
 * app*, in render-host mode (`DECKASTRA_RENDER_HOST=1`, `main/render-host.ts`),
 * and drives it over Node's IPC channel.
 *
 * Three things here were each learned by a probe, not assumed:
 *
 * - **IPC, not stdin.** On Windows an Electron main process never receives piped
 *   stdin — the request arrives as an immediate end-of-file. Node's IPC channel
 *   does work, and it has no port for anything else on the machine to find.
 * - **`ELECTRON_RUN_AS_NODE` must be removed.** This process inherited it, and
 *   a child that kept it would start as plain Node again, with no browser.
 * - **The host's stdout is discarded**, and its stderr is kept only as a tail
 *   for error messages. This process's stdout is the export's one JSON answer
 *   and its stderr is progress, one object per line; Chromium's logging in
 *   either would corrupt the contract the API parses.
 */

export interface ElectronHostCommand {
  executable: string;
  args: string[];
}

/** How long a host gets to start before the export gives up on it. */
const START_TIMEOUT_MS = 30_000;
/** How long a clean shutdown gets before the host is killed. */
const STOP_TIMEOUT_MS = 3_000;
/** Enough stderr to explain a crash, not enough to hold a whole log. */
const STDERR_TAIL = 4_000;

export function electronHostFromEnvironment(env: NodeJS.ProcessEnv = process.env): ElectronHostCommand | undefined {
  const executable = env.DECKASTRA_RENDER_ELECTRON?.trim();
  if (!executable) return undefined;

  const raw = env.DECKASTRA_RENDER_ELECTRON_ARGS?.trim();
  if (!raw) return { executable, args: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DECKASTRA_RENDER_ELECTRON_ARGS must be a JSON array of strings.");
  }
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
    throw new Error("DECKASTRA_RENDER_ELECTRON_ARGS must be a JSON array of strings.");
  }
  return { executable, args: parsed };
}

type ParamsOf<M extends RenderHostMethod> = Extract<RenderHostRequest, { method: M }>["params"];

/** One request/reply conversation with a running host. */
export class HostConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private exited: Error | undefined;
  private stderrTail = "";
  readonly ready: Promise<{ profile: string }>;

  constructor(private readonly child: ChildProcess) {
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`The render host did not start within ${START_TIMEOUT_MS / 1000}s.${this.tail()}`));
        child.kill();
      }, START_TIMEOUT_MS);

      child.on("message", (message: RenderHostMessage) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          resolve({ profile: message.profile });
          return;
        }
        if (message?.type !== "reply") return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.ok) waiter.resolve(message.value);
        else waiter.reject(new Error(message.error));
      });

      const fail = (error: Error) => {
        clearTimeout(timer);
        this.exited ??= error;
        reject(error);
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
      };
      child.once("error", (error) => fail(new Error(`The render host could not start: ${error.message}`)));
      child.once("exit", (code, signal) =>
        fail(new Error(`The render host exited (${signal ?? code}).${this.tail()}`)),
      );
    });
    // Observed so an early failure is not an unhandled rejection before anyone
    // awaits it; `openElectronBrowser` awaits and reports it.
    this.ready.catch(() => undefined);
  }

  call<M extends RenderHostMethod>(method: M, params: ParamsOf<M>): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, method, params } as RenderHostRequest, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new Error(`Could not reach the render host: ${error.message}`));
      });
    });
  }

  async stop(): Promise<void> {
    if (this.exited || this.child.exitCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.child.kill();
        done();
      }, STOP_TIMEOUT_MS);
      this.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      // The host exits when its channel closes, which is also what happens if
      // this process dies — so an export that crashes cannot orphan a browser.
      if (this.child.connected) this.child.disconnect();
      else this.child.kill();
    });
  }

  private tail(): string {
    const text = this.stderrTail.trim();
    return text ? ` Last output: ${text.slice(-600)}` : "";
  }
}

export async function openElectronBrowser(
  command: ElectronHostCommand,
  spawnImpl: typeof spawn = spawn,
): Promise<RenderBrowser> {
  const env: NodeJS.ProcessEnv = { ...process.env, DECKASTRA_RENDER_HOST: "1" };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawnImpl(command.executable, command.args, {
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
    shell: false,
  });
  const connection = new HostConnection(child);
  const { profile } = await connection.ready;

  return {
    async newPage(scale) {
      const pageId = (await connection.call("newPage", { scale })) as number;
      return new ElectronPage(connection, pageId);
    },
    async close() {
      await connection.stop();
      // The host's Chromium held this directory open until it exited, which is
      // why the host reports it rather than deleting it itself.
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Inches from the "20in" / "1920px" strings the exporter already writes. */
export function inches(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(in|px)\s*$/.exec(value);
  if (!match) throw new Error(`Unsupported PDF length "${value}"; use inches or px.`);
  const amount = Number(match[1]);
  return match[2] === "px" ? amount / 96 : amount;
}

const ZERO = /^\s*0(\.0+)?\s*(in|px|mm|cm)?\s*$/;

export class ElectronPage implements RenderPage {
  private closed = false;

  constructor(private readonly connection: HostConnection, private readonly pageId: number) {}

  async setContent(html: string): Promise<void> {
    await this.connection.call("setContent", { pageId: this.pageId, html });
  }

  async addScriptTag(options: { content: string }): Promise<void> {
    await this.connection.call("addScriptTag", { pageId: this.pageId, content: options.content });
  }

  async evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return (await this.connection.call("evaluate", {
      pageId: this.pageId,
      source: fn.toString(),
      ...(arg === undefined ? {} : { arg }),
    })) as R;
  }

  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    const base64 = (await this.connection.call("screenshot", {
      pageId: this.pageId,
      type: options.type,
      clip: options.clip,
      ...(options.omitBackground ? { omitBackground: true } : {}),
    })) as string;
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  async pdf(options: PdfOptions): Promise<Uint8Array> {
    // Refused rather than ignored. The exporter prints edge to edge at scale 1;
    // an option this backend quietly dropped would produce a PDF that differs
    // from the Playwright one with nothing saying why.
    const margins = Object.values(options.margin ?? {});
    if (margins.some((margin) => margin !== undefined && !ZERO.test(margin))) {
      throw new Error("The Electron renderer prints without margins; non-zero PDF margins are not supported.");
    }
    if (options.scale !== undefined && options.scale !== 1) {
      throw new Error("The Electron renderer prints at scale 1; other PDF scales are not supported.");
    }

    const base64 = (await this.connection.call("pdf", {
      pageId: this.pageId,
      widthIn: inches(options.width, 20),
      heightIn: inches(options.height, 11.25),
      printBackground: options.printBackground ?? false,
      preferCSSPageSize: options.preferCSSPageSize ?? false,
    })) as string;
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection.call("closePage", { pageId: this.pageId }).catch(() => undefined);
  }

  isClosed(): boolean {
    return this.closed;
  }
}
