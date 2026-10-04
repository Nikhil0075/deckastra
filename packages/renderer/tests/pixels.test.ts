import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";
import { createElement } from "react";
import { compileTimeline, finalSample, toStyle } from "@deckastra/animation-engine";
import type { AnimationTrack } from "@deckastra/presentation-schema";
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
 * file is named for the platform that produced it, and a developer's run on a
 * platform with no baseline reports that rather than failing — a gate that fails
 * for a reason nobody can act on gets disabled within a week.
 *
 * `REQUIRE_PIXEL_BASELINE=1` turns that report into a failure, and CI sets it.
 * Without it the gate was worth nothing anywhere: CI runs on Linux, no Linux
 * baseline was committed, and a missing baseline passed silently — so the job
 * was green while comparing against nothing. A missing baseline in CI is a
 * finding, not a shrug; the run writes the hashes it computed so the first one
 * can be committed from the artifact.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, "..", "baselines", "pixels");
const ARTIFACTS = join(BASELINES, "artifacts", `${process.platform}-${process.arch}`);

const ENABLED = process.env.PIXELS === "1";
const UPDATE = process.env.UPDATE_PIXELS === "1";
//: A missing baseline is a failure where one is expected to exist — CI.
const REQUIRED = process.env.REQUIRE_PIXEL_BASELINE === "1";

const FIXTURES = ["technical", "repository", "animation"] as const;

/** 2× device pixel ratio, as doc 04 §39 specifies for the reload test. */
const SCALE = 2;

/** Deterministic scene fallback; the CI image pins the actual browser fonts. */
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
  // Capture the same explicit final frame used by default headless exports.
  // Otherwise an entrance fixture can be entirely invisible and still pass.
  const timeline = compileTimeline(slide, (slide.animations ?? []) as AnimationTrack[], { userMotionPreference: "full" });
  const styles = [...finalSample(timeline).values()].map(target => ({
    id: target.targetId, style: toStyle(target.values),
  }));
  await page!.evaluate(items => {
    for (const item of items) {
      const element = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(item.id)}"]`);
      if (element) Object.assign(element.style, item.style);
    }
  }, styles);

  const png = await page!.screenshot({
    clip: { x: 0, y: 0, width: slide.width, height: slide.height },
    animations: "disabled",
  });
  // DPR changes density, not CSS clip coordinates. The old /2 clip captured
  // only a quarter of the slide and missed regressions on its right/bottom.
  expect(png.readUInt32BE(16)).toBe(slide.width * SCALE);
  expect(png.readUInt32BE(20)).toBe(slide.height * SCALE);
  return png;
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
      const count = loadFixture(fixture).slides.length;
      for (let i = 0; i < count; i++) {
        const first = await shoot(fixture, i);
        const second = await shoot(fixture, i);
        expect(hash(second), `${fixture}/${i} differed between two renders`).toBe(hash(first));
      }
    }
  }, 300_000);

  it("renders byte-identical PNGs after a full page reload", async () => {
    // A reload discards every cache the first render warmed: layout, font
    // shaping, the rasteriser's glyph atlas. A difference here is a real
    // nondeterminism that a same-page second shot would hide.
    for (const fixture of FIXTURES) {
      for (let i = 0; i < loadFixture(fixture).slides.length; i++) {
        const before = await shoot(fixture, i);
        await page!.reload();
        const after = await shoot(fixture, i);
        expect(hash(after), `${fixture}/${i} changed after reload`).toBe(hash(before));
      }
    }
  }, 300_000);

  it("matches the committed pixel baseline for this platform", async () => {
    const path = join(BASELINES, `${platformKey}.json`);

    const current: Record<string, string> = {};
    mkdirSync(ARTIFACTS, { recursive: true });
    for (const fixture of FIXTURES) {
      const scene = buildDocumentScene(loadFixture(fixture), { fonts: FONTS });
      for (let i = 0; i < scene.slides.length; i += 1) {
        const png = await shoot(fixture, i);
        current[`${fixture}/${i}`] = hash(png);
        writeFileSync(join(ARTIFACTS, `${fixture}-${i}.png`), png);
      }
    }
    writeFileSync(`${path}.computed`, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    writeFileSync(join(ARTIFACTS, "runtime.json"), JSON.stringify({
      chromium: browser!.version(), node: process.version, platform: platformKey, deviceScaleFactor: SCALE,
      animationFrame: "final",
      logicalSize: { width: 1920, height: 1080 }, captureSize: { width: 3840, height: 2160 },
    }, null, 2));

    if (UPDATE) {
      mkdirSync(BASELINES, { recursive: true });
      writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      return;
    }

    if (!existsSync(path)) {
      // Written either way, so the first baseline for a platform can be taken
      // from a CI artifact rather than needing that machine in front of you.
      mkdirSync(BASELINES, { recursive: true });
      writeFileSync(`${path}.computed`, `${JSON.stringify(current, null, 2)}
`, "utf8");

      if (REQUIRED) {
        // Where a baseline is expected, its absence is the finding. Passing here
        // is what let this gate run green against nothing for a whole phase.
        throw new Error(
          `No pixel baseline for ${platformKey}. The hashes this run computed are ` +
            `in ${path}.computed — review them and commit them as ${platformKey}.json.`,
        );
      }

      // Font rasterisation is platform-specific, so a hash from another machine
      // proves nothing here. Saying so beats failing for a reason nobody can act
      // on — that is how a gate gets disabled.
      console.log(
        `[pixels] no baseline for ${platformKey}; run with UPDATE_PIXELS=1 to record one.`,
      );
      return;
    }

    const expected = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;

    // Three findings, not one. `toEqual` over a dozen sha256 strings prints an
    // unreadable blob and collapses cases that need different actions — which is
    // the same argument the scene digest is readable for ("a hash says something
    // changed, these lines say which node moved and how"), never applied here.
    //
    // It matters right now: `animation/3` was added to the fixture by D4.1 and
    // the Linux baseline has never been re-recorded, so CI's pixel job fails with
    // a diff that does not say "this slide is new, take its hash from the
    // artifact" — it just says two objects differ.
    const unrecorded = Object.keys(current).filter((key) => !(key in expected));
    const vanished = Object.keys(expected).filter((key) => !(key in current));
    const changed = Object.keys(current).filter(
      (key) => key in expected && current[key] !== expected[key],
    );

    const findings: string[] = [];
    if (unrecorded.length) {
      // New slides. Not a visual regression — nothing to compare against — and
      // the fix is to commit the hashes this run just wrote.
      findings.push(
        `No baseline on ${platformKey} for: ${unrecorded.join(", ")}. ` +
          `Their hashes are in ${platformKey}.json.computed; review and commit them.`,
      );
    }
    if (vanished.length) {
      // The fixture stopped producing a slide the baseline still names, which is
      // a fixture change rather than a rendering one.
      findings.push(
        `The baseline names slides this run did not produce: ${vanished.join(", ")}. ` +
          `If the fixture lost them deliberately, drop them from ${platformKey}.json.`,
      );
    }
    if (changed.length) {
      // The only one of the three that is a visual regression, and the only one
      // where regenerating the baseline is the wrong first move.
      findings.push(
        `Pixels changed on ${platformKey} for: ${changed.join(", ")}. ` +
          `Read the PNGs in baselines/pixels/artifacts before regenerating anything — ` +
          `a baseline updated reflexively is a gate that has been switched off while ` +
          `still looking on.`,
      );
    }

    const report = findings.join(" | ");
    expect(report, report).toBe("");
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
          clip: { x: 0, y: 0, width: slide.width, height: slide.height },
        }),
      );
    };

    const plain = await shootMarkup("");
    // A change outside the old top-left crop must fail the gate.
    const nudged = await shootMarkup("[data-deckastra-slide]::after{content:'';position:absolute;right:0;bottom:0;width:40px;height:40px;background:#ff00ff;z-index:2147483647}");
    expect(nudged).not.toBe(plain);
  }, 120_000);
});
