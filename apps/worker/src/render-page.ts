import { electronHostFromEnvironment, openElectronBrowser } from "./electron-backend";

/**
 * The page a render runs on, whichever browser is behind it.
 *
 * The exporter used to be written against Playwright's `Page` directly, which
 * tied every export to Playwright's Chromium — a browser a packaged desktop app
 * does not carry, so packaged exports could not render at all. This is the
 * handful of operations the exporter actually performs, and nothing more: two
 * backends implement it, and neither can grow a dependency the other lacks.
 *
 * - **Playwright** — the default, and what CI and a checkout use. Unchanged in
 *   behaviour; the page setup that lived in `render.ts` moved here verbatim.
 * - **Electron** — the desktop app's own Chromium, driven over IPC
 *   (`electron-backend.ts`). Selected with `DECKASTRA_RENDER_BACKEND=electron`,
 *   which the desktop sets for the exporter it starts.
 *
 * Both give the same environment, because the determinism rules do not care
 * which binary is drawing: a 1920×1080 viewport at the requested scale, reduced
 * motion and dark scheme set explicitly rather than inherited (doc 04 §41.3), and
 * no network except `data:` URLs.
 */

export interface RenderClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  type: "png" | "jpeg";
  clip: RenderClip;
  /** Finish finite animations and cancel infinite ones before capture. */
  animations?: "disabled";
}

/** The subset of Playwright's PDF options the exporter uses. */
export interface PdfOptions {
  printBackground?: boolean;
  width?: string;
  height?: string;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  scale?: number;
  preferCSSPageSize?: boolean;
}

export interface RenderPage {
  setContent(html: string, options?: { waitUntil?: "load" }): Promise<void>;
  addScriptTag(options: { content: string }): Promise<void>;
  /**
   * Run a function in the page. It is sent as source, so it must be
   * self-contained: no closures over worker variables, only its argument, which
   * must survive JSON.
   */
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  screenshot(options: ScreenshotOptions): Promise<Uint8Array>;
  pdf(options: PdfOptions): Promise<Uint8Array>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface RenderBrowser {
  newPage(scale: number): Promise<RenderPage>;
  close(): Promise<void>;
}

/** Pick the backend from the environment. Playwright unless told otherwise. */
export async function openRenderBrowser(env: NodeJS.ProcessEnv = process.env): Promise<RenderBrowser> {
  const backend = (env.DECKASTRA_RENDER_BACKEND ?? "").trim();
  if (backend === "electron") {
    const command = electronHostFromEnvironment(env);
    if (!command) {
      // A half-configured backend is a packaging mistake. Falling back to
      // Playwright would fail anyway in a packaged app, and more confusingly.
      throw new Error("DECKASTRA_RENDER_BACKEND=electron needs DECKASTRA_RENDER_ELECTRON to name the binary.");
    }
    return openElectronBrowser(command);
  }
  if (backend && backend !== "playwright") {
    throw new Error(`Unknown render backend "${backend}". Use "playwright" or "electron".`);
  }
  return openPlaywrightBrowser();
}

export async function openPlaywrightBrowser(): Promise<RenderBrowser> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    args: [
      // Fonts and rasterisation should not depend on the host's GPU: doc 04
      // §32.3 wants the same input to produce the same bytes, and a GPU path
      // makes that machine-dependent.
      "--disable-gpu",
      "--font-render-hinting=none",
      "--disable-lcd-text",
    ],
  });

  return {
    async newPage(scale) {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: scale,
        // Set explicitly rather than inherited (doc 04 §41.3). A render that
        // picked up the *server's* preference would bake one machine's
        // accessibility setting into every user's export.
        reducedMotion: "reduce",
        colorScheme: "dark",
      });

      // No network at render time. A document that could make the render
      // server fetch a URL is an SSRF primitive as well as a source of
      // nondeterminism; assets arrive inline, from our own storage.
      await page.route("**/*", (route) =>
        route.request().url().startsWith("data:") ? route.continue() : route.abort(),
      );

      return playwrightPage(page);
    },
    close: () => browser.close(),
  };
}

function playwrightPage(page: import("playwright").Page): RenderPage {
  return {
    setContent: (html, options) => page.setContent(html, { waitUntil: options?.waitUntil ?? "load" }),
    addScriptTag: async (options) => {
      await page.addScriptTag(options);
    },
    evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg?: A) =>
      page.evaluate(fn as never, arg as never) as Promise<R>,
    screenshot: async (options) =>
      new Uint8Array(
        await page.screenshot({
          type: options.type,
          clip: options.clip,
          ...(options.animations ? { animations: options.animations } : {}),
        }),
      ),
    pdf: async (options) => new Uint8Array(await page.pdf(options)),
    close: () => page.close(),
    isClosed: () => page.isClosed(),
  };
}
