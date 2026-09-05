import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { createElement } from "react";
import type { Browser, Page } from "playwright";

import { buildDocumentScene } from "../src/scene";
import { SlideView } from "../src/react/SlideView";

/**
 * Pixel regression — the other half of the visual gate (doc 04 §34, §39).
 *
 * `baseline.test.ts` digests the *scene*: everything the pipeline resolved. This
 * renders the markup in real Chromium and hashes the PNG, which is the only way
 * to catch a bug that lives entirely in the emit step or in the browser's
 * painting of it — a wrong `mix-blend-mode`, an SVG marker that does not
 * resolve, a stacking context that puts a group's fill over its children. The
 * scene digest cannot see any of those, because the scene is identical either
 * way.
 *
 * It is the slower gate, and it needs a browser download, so it is opt-in:
 *
 *   PIXELS=1 npx vitest run tests/pixels.test.ts
 *   PIXELS=1 UPDATE_PIXELS=1 npx vitest run tests/pixels.test.ts   # after a deliberate change
 *
 * **The baseline is per-platform.** Font rasterisation differs between Windows,
 * macOS and Linux, so a hash taken on one does not hold on another. The baseline
 * file is named for the platform that produced it, and a run on a platform with
 * no baseline reports that rather than failing — a gate that fails for a reason
 * nobody can act on gets disabled within a week. CI pins one platform, which is
 * where the gate has teeth.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, "..", "baselines", "pixels");

const ENABLED = process.env.PIXELS === "1";
const UPDATE = process.env.UPDATE_PIXELS === "1";

const FIXTURES = ["technical", "repository", "animation"] as const;

/** 2× device pixel ratio, as doc 04 §39 specifies for the reload test. */
const SCALE = 2;

/** Fonts are pinned so the render does not depend on what the machine has. */
const FONTS = { available: new Set<string>(), unknown: true };

let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
  if (!ENABLED) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: SCALE,
    // A stable rendering environment: no animations to catch mid-flight, no
    // system theme to leak in.
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
}, 120_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
});

async function shoot(fixture: (typeof FIXTURES)[number], slideIndex: number): Promise<Buffer> {
  const scene = buildDocumentScene(loadFixture(fixture), { fonts: FONTS });
  const slide = scene.slides[slideIndex]!;

  const markup = renderToStaticMarkup(
    createElement(SlideView, { scene: slide, mode: "export" as const }),
  );

  await page!.setContent(
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:#000}` +
      // No web fonts: they load asynchronously and would make the first shot
      // differ from the second. The point of the test is that two renders of the
      // same input agree.
      `*{font-family:ui-sans-serif,system-ui,sans-serif}</style>` +
      `<body>${markup}</body>`,
    { waitUntil: "load" },
  );

  await page!.evaluate(() => document.fonts.ready);

  return page!.screenshot({
    clip: { x: 0, y: 0, width: slide.width / 2, height: slide.height / 2 },
    animations: "disabled",
  });
}

function hash(png: Buffer): string {
  return createHash("sha256").update(png).digest("hex").slice(0, 16);
}

const platformKey = `${process.platform}-${process.arch}`;

describe.skipIf(!ENABLED)("pixel regression", () => {
  it("renders byte-identical PNGs twice in a row", async () => {
    // The property doc 04 §39 actually asks for, and the one that makes every
    // other pixel comparison meaningful. If this fails, nothing below is signal.
    for (const fixture of FIXTURES) {
      const first = await shoot(fixture, 0);
      const second = await shoot(fixture, 0);
      expect(hash(second), `${fixture} slide 0 differed between two renders`).toBe(hash(first));
    }
  }, 120_000);

  it("renders byte-identical PNGs after a full page reload", async () => {
    // A reload discards every cache the first render warmed: layout, font
    // shaping, the rasteriser's glyph atlas. A difference here is a real
    // nondeterminism that a same-page second shot would hide.
    const before = await shoot("technical", 1);
    await page!.reload();
    const after = await shoot("technical", 1);
    expect(hash(after)).toBe(hash(before));
  }, 120_000);

  it("matches the committed pixel baseline for this platform", async () => {
    const path = join(BASELINES, `${platformKey}.json`);

    const current: Record<string, string> = {};
    for (const fixture of FIXTURES) {
      const scene = buildDocumentScene(loadFixture(fixture), { fonts: FONTS });
      for (let i = 0; i < scene.slides.length; i += 1) {
        current[`${fixture}/${i}`] = hash(await shoot(fixture, i));
      }
    }

    if (UPDATE) {
      mkdirSync(BASELINES, { recursive: true });
      writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      return;
    }

    if (!existsSync(path)) {
      // Font rasterisation is platform-specific, so a hash from another machine
      // proves nothing here. Saying so beats failing for a reason nobody can act
      // on — that is how a gate gets disabled.
      console.log(
        `[pixels] no baseline for ${platformKey}; run with UPDATE_PIXELS=1 to record one.`,
      );
      return;
    }

    const expected = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(current).toEqual(expected);
  }, 300_000);

  it("sees a change the scene digest cannot", async () => {
    // The reason this suite exists. A change confined to the emit step leaves the
    // scene byte-identical, so the scene digest passes and only pixels notice.
    const scene = buildDocumentScene(loadFixture("technical"), { fonts: FONTS });
    const slide = scene.slides[0]!;
    const markup = renderToStaticMarkup(
      createElement(SlideView, { scene: slide, mode: "export" as const }),
    );

    const shootMarkup = async (extraCss: string): Promise<string> => {
      await page!.setContent(
        `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}` +
          `*{font-family:ui-sans-serif,system-ui,sans-serif}${extraCss}</style>` +
          `<body>${markup}</body>`,
        { waitUntil: "load" },
      );
      await page!.evaluate(() => document.fonts.ready);
      return hash(
        await page!.screenshot({
          clip: { x: 0, y: 0, width: slide.width / 2, height: slide.height / 2 },
        }),
      );
    };

    const plain = await shootMarkup("");
    const nudged = await shootMarkup("[data-element-id]{transform:translateX(1px)!important}");
    expect(nudged).not.toBe(plain);
  }, 120_000);
});
