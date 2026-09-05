import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "@deckastra/presentation-schema/fixtures";

import { buildDocumentScene } from "../src/index";
import { SlideView } from "../src/react/index";

/**
 * The eyeball harness.
 *
 * Not an assertion — a way to *look* at what the renderer produces. Every
 * renderer bug found in this project so far (invisible groups, ignored container
 * padding, an unselectable canvas) was found by opening the output, not by a
 * test, because a test only checks what someone already thought to check.
 *
 *   PREVIEW_OUT=some/path.html npx vitest run tests/preview.test.tsx
 *   PREVIEW_ONLY=repository PREVIEW_OUT=… npx vitest run tests/preview.test.tsx
 *
 * Skipped without `PREVIEW_OUT`, so it costs the normal suite nothing.
 */

const FIXTURES = ["technical", "repository", "animation"] as const;
const OUT = process.env.PREVIEW_OUT;

it.skipIf(!OUT)("writes an HTML contact sheet of every fixture slide", () => {
  const only = process.env.PREVIEW_ONLY as (typeof FIXTURES)[number] | undefined;
  const names = only ? [only] : [...FIXTURES];
  const width = Number(process.env.PREVIEW_WIDTH ?? 720);

  const figures: string[] = [];

  for (const name of names) {
    const scene = buildDocumentScene(loadFixture(name));
    const scale = width / scene.viewport.width;

    for (const slide of scene.slides) {
      figures.push(
        `<figure style="margin:0">` +
          `<figcaption style="font:600 12px system-ui;color:#8ab;padding:6px 0">${name} / ${slide.index} ${slide.name ?? ""}</figcaption>` +
          `<div style="width:${width}px;height:${scene.viewport.height * scale}px;overflow:hidden;border:1px solid #333">` +
          `<div style="transform:scale(${scale});transform-origin:0 0">` +
          renderToStaticMarkup(<SlideView scene={slide} mode="present" />) +
          `</div></div></figure>`,
      );
    }
  }

  writeFileSync(
    OUT!,
    `<meta charset="utf-8"><body style="background:#0b0f14;margin:16px;display:grid;` +
      `grid-template-columns:repeat(auto-fill,${width}px);gap:16px;align-items:start">` +
      figures.join("") +
      `</body>`,
  );
});
