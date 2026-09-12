import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import type { RenderHostMessage, RenderHostRequest } from "@deckastra/workspace-contracts";

/**
 * The desktop app's Chromium, lent to the exporter.
 *
 * A packaged Deckastra ships one browser — the one it runs in — and the exporter
 * needs one to measure text and print. Rather than ship a second (~290MB of
 * Playwright's Chromium), the exporter starts this same binary again with
 * `DECKASTRA_RENDER_HOST=1` and drives it over Node's IPC channel
 * (`apps/worker/src/electron-backend.ts`).
 *
 * It has to live in the main bundle, entered by a flag. An installed Electron
 * app ignores a script path on its command line and always runs its own bundle,
 * so "run this other file" is not something the packaged binary can be asked.
 *
 * Every setting here was checked by a probe against this Electron version, and
 * three were not what the obvious code does:
 *
 * - **Offscreen windows.** A hidden ordinary window never produces a frame, and a
 *   CDP screenshot of one waits forever. `capturePage({ stayHidden })` does
 *   return pixels, but at the *monitor's* scale — 2400×1350 on a 125% display —
 *   which would bake one machine's settings into every export.
 * - **Emulate after navigating.** `Emulation.setDeviceMetricsOverride` sent to a
 *   window that has not yet loaded a page kills the browser process outright.
 * - **Its own profile.** Two Chromiums on one profile directory fight over the
 *   cache ("Unable to move the cache: Access is denied"), and the user's app is
 *   running on the default one.
 *
 * The page gets nothing it does not need: no network except `data:` URLs, no
 * permissions, no pop-ups, no navigation, no preload and no Node — the same
 * rules the Playwright path enforces (doc 04 §41.1).
 */

export function isRenderHost(): boolean {
  return process.env.DECKASTRA_RENDER_HOST === "1";
}

interface HostPage {
  window: BrowserWindow;
}

const VIEWPORT = { width: 1920, height: 1080 };

export function runRenderHost(): void {
  if (typeof process.send !== "function") {
    // Started by hand, or by something that is not the exporter. Without a
    // channel there is nobody to render for.
    process.stderr.write("The render host needs an IPC channel; it is started by the exporter.\n");
    app.exit(2);
    return;
  }
  const send = (message: RenderHostMessage) => process.send?.(message);

  // Before `ready`, or Chromium has already opened the default profile.
  const profile = mkdtempSync(join(tmpdir(), "deckastra-render-"));
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);

  // Same switches as the Playwright path: rasterisation should not depend on
  // the host's GPU or its subpixel settings (doc 04 §32.3).
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("font-render-hinting", "none");
  app.commandLine.appendSwitch("disable-lcd-text");

  // Closing the last page must not end the host; the exporter decides that.
  app.on("window-all-closed", () => undefined);
  // The exporter closing the channel — or dying — ends the host. Nothing is left
  // behind holding a browser open after the export it served.
  process.on("disconnect", () => app.exit(0));

  const pages = new Map<number, HostPage>();
  let nextPage = 1;

  const page = (pageId: number): HostPage => {
    const found = pages.get(pageId);
    if (!found || found.window.isDestroyed()) throw new Error(`No render page ${pageId}.`);
    return found;
  };

  async function dispatch(request: RenderHostRequest): Promise<unknown> {
    switch (request.method) {
      case "newPage": {
        const pageId = nextPage++;
        // In-memory partition per page: nothing from one export's page — a
        // cached font, a stored value — reaches the next.
        const ses = session.fromPartition(`render-${pageId}`);
        ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        ses.webRequest.onBeforeRequest((details, callback) => {
          const allowed = details.url.startsWith("data:") || details.url === "about:blank";
          callback(allowed ? {} : { cancel: true });
        });

        const window = new BrowserWindow({
          show: false,
          ...VIEWPORT,
          useContentSize: true,
          webPreferences: {
            offscreen: true,
            session: ses,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            spellcheck: false,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) => event.preventDefault());

        await window.loadURL("about:blank");
        const debug = window.webContents.debugger;
        debug.attach("1.3");
        await debug.sendCommand("Emulation.setDeviceMetricsOverride", {
          ...VIEWPORT,
          deviceScaleFactor: request.params.scale,
          mobile: false,
        });
        // Set explicitly rather than inherited (doc 04 §41.3): the render must
        // not pick up this machine's accessibility or theme preference.
        await debug.sendCommand("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-motion", value: "reduce" },
            { name: "prefers-color-scheme", value: "dark" },
          ],
        });

        pages.set(pageId, { window });
        return pageId;
      }

      case "setContent": {
        const { webContents } = page(request.params.pageId).window;
        // What Playwright's `setContent` does: write into the blank document
        // rather than navigate, so no URL is involved and nothing can be fetched
        // by one.
        await webContents.executeJavaScript(
          `document.open(); document.write(${JSON.stringify(request.params.html)}); document.close();`,
        );
        await webContents.executeJavaScript(
          `new Promise((done) => document.readyState === "complete" ? done() : addEventListener("load", () => done(), { once: true }))`,
        );
        return null;
      }

      case "addScriptTag": {
        const { webContents } = page(request.params.pageId).window;
        await webContents.executeJavaScript(
          `(() => { const tag = document.createElement("script"); tag.textContent = ${JSON.stringify(request.params.content)}; document.head.appendChild(tag); })()`,
        );
        return null;
      }

      case "evaluate": {
        const { webContents } = page(request.params.pageId).window;
        const arg = "arg" in request.params ? JSON.stringify(request.params.arg) : "";
        return webContents.executeJavaScript(`(${request.params.source})(${arg})`);
      }

      case "screenshot": {
        const { window } = page(request.params.pageId);
        // Playwright's `animations: "disabled"`: finish what can finish and
        // cancel what cannot, so a capture never lands mid-transition.
        await window.webContents.executeJavaScript(
          `document.getAnimations().forEach((animation) => { try { animation.finish(); } catch { animation.cancel(); } })`,
        );
        const shot = (await window.webContents.debugger.sendCommand("Page.captureScreenshot", {
          format: request.params.type,
          clip: { ...request.params.clip, scale: 1 },
        })) as { data: string };
        return shot.data;
      }

      case "pdf": {
        const { window } = page(request.params.pageId);
        const bytes = await window.webContents.printToPDF({
          printBackground: request.params.printBackground,
          pageSize: { width: request.params.widthIn, height: request.params.heightIn },
          margins: { marginType: "none" },
          preferCSSPageSize: request.params.preferCSSPageSize,
        });
        return bytes.toString("base64");
      }

      case "closePage": {
        const found = pages.get(request.params.pageId);
        pages.delete(request.params.pageId);
        if (found && !found.window.isDestroyed()) found.window.destroy();
        return null;
      }
    }
  }

  process.on("message", (request: RenderHostRequest) => {
    void (async () => {
      try {
        await app.whenReady();
        send({ type: "reply", id: request.id, ok: true, value: await dispatch(request) });
      } catch (error) {
        send({
          type: "reply",
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  void app.whenReady().then(() => send({ type: "ready", profile }));
}
