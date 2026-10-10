/**
 * The renderer's own judgement of composed template documents (UI audit unit 2).
 *
 * `packages/deck-presets/scripts/preview-sheet.py` composes every template
 * through the API's composer and writes each document to a directory. This
 * reads them back and runs the scene build and semantic pass the editor runs
 * (`validateScene`), so clipped text (W103) and the other render-time findings
 * are reported by the code that decides them, not a second copy of the rules.
 *
 * It lives in the renderer rather than beside the report because
 * `deck-presets` is data only and takes no renderer dependency.
 *
 * Node has no browser, so text is measured by the estimator, exactly as a plain
 * scene build is everywhere else. Usage: tsx scene-check.ts <dir>
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PresentationDocument } from "@deckastra/presentation-schema";

import { checkLayout } from "../src/layout-check";
import { buildDocumentScene } from "../src/scene";
import { validateScene } from "../src/semantic";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: tsx scene-check.ts <directory of composed .json documents>");
  process.exit(2);
}

const report: Record<string, Array<{ code: string; slideId?: string; elementId?: string; message: string }>> = {};
for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
  const document = JSON.parse(readFileSync(join(dir, name), "utf8")) as PresentationDocument;
  const scene = buildDocumentScene(document);
  const issues = validateScene(scene);
  // Collisions (W110) from Design Check's layout pass, which validateScene does
  // not run: the design-language gate (unit 7b) refuses words on words.
  const collisions = scene.slides.flatMap((slide) => checkLayout(slide).filter((issue) => issue.code === "W110"));
  report[name.replace(/\.json$/, "")] = [...issues, ...collisions]
    .filter((issue) => issue.severity !== "info")
    .map((issue) => ({ code: issue.code, slideId: issue.slideId, elementId: issue.elementId, message: issue.message }));
}
process.stdout.write(JSON.stringify(report));
