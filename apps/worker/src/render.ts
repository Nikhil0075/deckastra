/**
 * The headless render service (doc 04 §41).
 *
 * The prerequisite for everything in Part II: render a slide without a human's
 * browser tab. The Critic's preview images, export jobs, thumbnails and every
 * future MCP preview tool all need the same thing, and building it once is the
 * difference between one deterministic renderer and four that disagree.
 *
 * Doc 04 §41.1 makes the argument this file is the proof of: the renderer
 * *claims* to be a deterministic interpreter, and running it with no editor, no
 * session and no user is what turns that claim into something checkable. The
 * markup here comes from the same `SlideView` the editor mounts, in
 * `mode="export"` — so editor chrome is structurally absent rather than hidden.
 *
 * Three requirements from §41.3 that shape the implementation:
 *
 * - **A browser pool with a hard timeout.** A render that hangs holds a Chromium
 *   process; one per request would exhaust the machine before anyone noticed.
 * - **No network at render time.** Every request is aborted except the page's own
 *   `setContent`, so a deck cannot make the render server fetch a URL — which is
 *   both a determinism property and an SSRF boundary.
 * - **Reduced motion set explicitly, animations resolved to a chosen frame.**
 *   Otherwise a render catches whatever frame the entrance happened to be on.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AnimationTrack, PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene, type SlideScene } from "@deckastra/renderer";
import { SlideView } from "@deckastra/renderer/react";
import { compileTimeline, sampleAt, toStyle } from "@deckastra/animation-engine";
import type { ExportWarning, FontSpec } from "@deckastra/export-core";
import { fontManifest } from "@deckastra/export-core";

export type RenderFormat = "png" | "jpeg";

export interface RenderRequest {
  document: PresentationDocument;
  slideIds?: string[];
  format: RenderFormat;
  /** 1 | 2 | 3. */
  scale?: number;
  atTimeMs?: number | "final" | "initial";
  includeNotes?: boolean;
}

export interface RenderArtifact {
  slideId: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface RenderResponse {
  artifacts: RenderArtifact[];
  warnings: ExportWarning[];
  renderMs: number;
  fontsUsed: FontSpec[];
  /** True when any text fell back to the estimator rather than a real measurement. */
  metricsEstimated: boolean;
}

/** Doc 04 §41.3. A render that has not finished by here is a render that hung. */
export const RENDER_TIMEOUT_MS = 20_000;

/** Doc 04 §41.4. */
export const PREVIEW_SIZES = {
  thumbnail: { width: 320, height: 180 },
  critic: { width: 1280, height: 720 },
  mcp: { width: 1024, height: 576 },
} as const;

// ------------------------------------------------------------------ the pool

interface PoolEntry {
  browser: import("playwright").Browser;
  page: import("playwright").Page;
}

/**
 * One warm Chromium with one warm page.
 *
 * A pool of one, deliberately. Doc 04 §41.3 asks for a pool; the number that
 * matters for a single-track build is "not one per request", and a second page
 * buys nothing until there is a queue in front of it. What the class exists for
 * is the lifecycle — the page is reused, the browser is closed once, and a
 * caller cannot leak one by forgetting.
 */
export class RenderPool {
  private entry: PoolEntry | undefined;
  private opening: Promise<PoolEntry> | undefined;

  async acquire(scale: number): Promise<PoolEntry> {
    if (this.entry) {
      // Device scale is a page property, so a different scale needs a new page
      // rather than a resize. Cheap: the browser stays warm.
      await this.entry.page.close();
      this.entry.page = await newPage(this.entry.browser, scale);
      return this.entry;
    }

    this.opening ??= this.open(scale);
    this.entry = await this.opening;
    return this.entry;
  }

  private async open(scale: number): Promise<PoolEntry> {
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
    return { browser, page: await newPage(browser, scale) };
  }

  async close(): Promise<void> {
    await this.entry?.page.close().catch(() => undefined);
    await this.entry?.browser.close().catch(() => undefined);
    this.entry = undefined;
    this.opening = undefined;
  }
}

async function newPage(
  browser: import("playwright").Browser,
  scale: number,
): Promise<import("playwright").Page> {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: scale,
    // Set explicitly rather than inherited (doc 04 §41.3). A render that picked
    // up the *server's* preference would bake one machine's accessibility
    // setting into every user's export.
    reducedMotion: "reduce",
    colorScheme: "dark",
  });

  // No network at render time. A document that could make the render server
  // fetch a URL is an SSRF primitive as well as a source of nondeterminism;
  // assets arrive inline, from our own storage, before the page is set.
  await page.route("**/*", (route) =>
    route.request().url().startsWith("data:") ? route.continue() : route.abort(),
  );

  return page;
}

/**
 * Wait until the page is actually ready to be captured.
 *
 * Doc 04 §34.3's first two failure modes, and both produce a file that looks
 * fine until someone reads it closely: text shifted because the fonts had not
 * settled when the capture fired, and blank images because it fired before
 * decode. Neither throws, neither is visible in a log, and both are fixed by
 * waiting for the two things the browser can tell us about.
 */
async function settle(page: import("playwright").Page): Promise<void> {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all(
      [...globalThis.document.images].map((image) =>
        image.complete ? undefined : image.decode().catch(() => undefined),
      ),
    );
  });
}

// ---------------------------------------------------------------- rendering

export async function render(
  request: RenderRequest,
  pool: RenderPool,
): Promise<RenderResponse> {
  const startedAt = Date.now();
  const scale = request.scale ?? 1;
  const { page } = await pool.acquire(scale);

  const scene = buildDocumentScene(request.document);
  const wanted = request.slideIds ? new Set(request.slideIds) : undefined;
  const slides = scene.slides.filter((slide) => !wanted || wanted.has(slide.slideId));

  const artifacts: RenderArtifact[] = [];
  const warnings: ExportWarning[] = [];
  let metricsEstimated = false;

  for (const slide of slides) {
    if (usedEstimatedMetrics(slide)) metricsEstimated = true;

    const html = slideHtml(slide, request.atTimeMs ?? "final", warnings);

    await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });

    await settle(page);

    const bytes = await page.screenshot({
      type: request.format === "jpeg" ? "jpeg" : "png",
      clip: { x: 0, y: 0, width: slide.width, height: slide.height },
      animations: "disabled",
    });

    artifacts.push({
      slideId: slide.slideId,
      bytes: new Uint8Array(bytes),
      width: slide.width,
      height: slide.height,
    });
  }

  return {
    artifacts,
    warnings,
    renderMs: Date.now() - startedAt,
    fontsUsed: fontManifest(slides),
    metricsEstimated,
  };
}

/**
 * A slide as a standalone HTML document.
 *
 * Exported because the PDF adapter builds a multi-page document out of these,
 * and because it is the piece worth testing without a browser: the markup is
 * deterministic, so a test can assert what is in it rather than what it looks
 * like.
 */
export function slideHtml(
  slide: SlideScene,
  atTime: number | "final" | "initial",
  warnings: ExportWarning[],
): string {
  const markup = renderToStaticMarkup(
    // `mode="export"` excludes editor chrome structurally — the subtree is never
    // mounted, so no CSS override can put a selection handle in a customer's PDF.
    createElement(SlideView, { scene: slide, mode: "export" as const }),
  );

  return (
    "<!doctype html><meta charset=\"utf-8\">" +
    `<style>${pageStyles(slide)}</style>` +
    `<body>${markup}${motionStyles(slide, atTime, warnings)}</body>`
  );
}

function pageStyles(slide: SlideScene): string {
  return (
    "html,body{margin:0;padding:0;background:transparent}" +
    // Doc 04 §34.3: content one pixel over the page height produces an extra
    // blank page, and an exact size plus overflow:hidden is the fix.
    `@page{size:${slide.width / 96}in ${slide.height / 96}in;margin:0}` +
    "body>*{overflow:hidden}" +
    // No web fonts. They load asynchronously and would make two renders of the
    // same slide differ; the curated families are installed on the render host.
    "*{font-family:Inter,ui-sans-serif,system-ui,sans-serif}"
  );
}

/**
 * Animations resolved to one frame (doc 04 §32.3, §41.3).
 *
 * Written as a stylesheet rather than inline attributes so it cannot be confused
 * with the scene's own geometry when someone reads the markup. `"final"` is the
 * default and is right for a deck someone will read; `"initial"` exists for a
 * handout of a click-reveal deck, where the final state gives every answer away
 * at once.
 */
function motionStyles(
  slide: SlideScene,
  atTime: number | "final" | "initial",
  warnings: ExportWarning[],
): string {
  const tracks = (slide.animations ?? []) as AnimationTrack[];
  if (tracks.length === 0) return "";

  const timeline = compileTimeline(slide, tracks, { userMotionPreference: "full" });
  const at =
    atTime === "final"
      ? timeline.durationMs + 1
      : atTime === "initial"
        ? 0
        : Math.max(0, Math.min(atTime, timeline.durationMs));

  const sample = sampleAt(timeline, at);
  if (sample.size === 0) return "";

  if (atTime !== "final") {
    warnings.push({
      severity: "info",
      slideId: slide.slideId,
      feature: "animation",
      action: "flattened",
      message:
        atTime === "initial"
          ? "Animations were frozen at their first frame, so revealed content is hidden."
          : `Animations were frozen at ${at}ms.`,
    });
  }

  const rules: string[] = [];
  for (const [, target] of sample) {
    const style = toStyle(target.values);
    const declarations = Object.entries(style)
      .map(([property, value]) => `${cssName(property)}:${value} !important`)
      .join(";");
    if (!declarations) continue;
    rules.push(`[data-element-id="${cssEscape(target.targetId)}"]{${declarations}}`);
  }

  return rules.length > 0 ? `<style>${rules.join("")}</style>` : "";
}

function cssName(property: string): string {
  return property === "clipPath" ? "clip-path" : property;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function usedEstimatedMetrics(slide: SlideScene): boolean {
  const walk = (nodes: SlideScene["nodes"]): boolean =>
    nodes.some(
      (node) =>
        (node.renderPayload.kind === "text" && node.renderPayload.metrics.estimated) ||
        (node.children ? walk(node.children) : false),
    );
  return walk(slide.nodes);
}


// ------------------------------------------------------------------- to PDF

/**
 * The whole deck as one PDF, in one `printToPDF` call.
 *
 * Chromium paginates a single page with CSS page breaks, so N slides become N
 * pages of one document — no merging, no cross-reference tables to rewrite. It
 * is also what keeps §34.1's promise: printing preserves text as *vector text*,
 * selectable and searchable, where a screenshot pipeline would produce pictures
 * of slides.
 */
export async function renderPdf(
  deck: PresentationDocument,
  slideIds: string[],
  atTime: number | "final" | "initial",
  pool: RenderPool,
): Promise<{ bytes: Uint8Array; warnings: ExportWarning[]; fontsUsed: FontSpec[] }> {
  const { page } = await pool.acquire(1);

  const scene = buildDocumentScene(deck);
  const wanted = new Set(slideIds);
  const slides = scene.slides.filter((slide) => wanted.has(slide.slideId));
  const warnings: ExportWarning[] = [];

  await page.setContent(deckHtml(slides, atTime, warnings), {
    waitUntil: "load",
    timeout: RENDER_TIMEOUT_MS,
  });

  await settle(page);

  const first = slides[0];
  const bytes = await page.pdf({
    // Doc 04 §34.3: without this the background is missing and the deck arrives
    // as dark text on white.
    printBackground: true,
    // 1920×1080 logical px at 96dpi is exactly 20in × 11.25in (doc 04 §34.1).
    // Derived rather than written, so a deck authored at another size is right.
    width: `${(first?.width ?? 1920) / 96}in`,
    height: `${(first?.height ?? 1080) / 96}in`,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    scale: 1,
    preferCSSPageSize: true,
  });

  return { bytes: new Uint8Array(bytes), warnings, fontsUsed: fontManifest(slides) };
}

/** Every slide as one paginated document. */
export function deckHtml(
  slides: SlideScene[],
  atTime: number | "final" | "initial",
  warnings: ExportWarning[],
): string {
  const pages = slides
    .map((slide) => {
      const markup = renderToStaticMarkup(
        createElement(SlideView, { scene: slide, mode: "export" as const }),
      );
      return (
        `<section class="deckastra-page" style="width:${slide.width}px;height:${slide.height}px">` +
        `${markup}${motionStyles(slide, atTime, warnings)}</section>`
      );
    })
    .join("");

  const first = slides[0];

  return (
    '<!doctype html><meta charset="utf-8">' +
    `<style>${pageStyles(first ?? ({ width: 1920, height: 1080 } as SlideScene))}` +
    // `break-after: page` on every section but the last. A trailing break is
    // doc 04 §34.3's "extra blank page" — one empty sheet at the end of every
    // export, which looks like a mistake because it is one.
    ".deckastra-page{position:relative;overflow:hidden;break-after:page}" +
    ".deckastra-page:last-child{break-after:auto}" +
    `</style><body>${pages}</body>`
  );
}
