import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DECK_PRESETS,
  DESIGN_LANGUAGES,
  PILOT_SOURCES,
  validatePresetSources,
  MOTION_STYLES,
  PATTERN_DEFINITIONS,
  PURPOSE_GROUPS,
  SLIDE_PATTERNS,
  renderContactSheet,
  runNegativeControls,
  validateDeckPresets,
  type ContactTheme,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../generated/deck-presets.json");
const contactSheetOutput = resolve(here, "../generated/contact-sheet.html");
const themesInput = resolve(here, "../../presentation-schema/generated/theme-presets.json");
const themeCatalog = JSON.parse(await readFile(themesInput, "utf8")) as {
  presets: Array<{ key: string; name: string; theme: { colors?: Record<string, string> } }>;
};
const themeKeys = new Set(themeCatalog.presets.map((theme) => theme.key));
const issues = [...validateDeckPresets(DECK_PRESETS, { themeKeys }), ...validatePresetSources(PILOT_SOURCES)];
if (issues.length > 0) {
  for (const issue of issues) console.error(`${issue.code} ${issue.path}: ${issue.message}`);
  process.exit(1);
}

const controls = runNegativeControls(DECK_PRESETS, themeKeys);
const missedControls = controls.filter((control) => !control.actual.includes(control.expected));
if (missedControls.length > 0) {
  for (const control of missedControls) {
    console.error(`NEGATIVE CONTROL FAILED ${control.name}: expected ${control.expected}; got ${control.actual.join(", ") || "no issues"}`);
  }
  process.exit(1);
}

const body = `${JSON.stringify({
  description: "Generated from @deckastra/deck-presets src/index.ts. Do not edit by hand: run npm run presets:emit.",
  purposeGroups: PURPOSE_GROUPS,
  slidePatterns: SLIDE_PATTERNS,
  patternDefinitions: PATTERN_DEFINITIONS,
  motionStyles: MOTION_STYLES,
  designLanguages: DESIGN_LANGUAGES,
  presets: DECK_PRESETS,
}, null, 2)}\n`;

const reviewThemeKeys = ["minimal-light", "neo-technical", "playful-pastel"];
const reviewThemes: ContactTheme[] = reviewThemeKeys.map((key) => {
  const found = themeCatalog.presets.find((theme) => theme.key === key);
  if (!found) throw new Error(`Contact-sheet theme ${key} is missing.`);
  return { key: found.key, name: found.name, colors: found.theme.colors ?? {} };
});
const contactSheet = renderContactSheet(reviewThemes);

if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  const currentContactSheet = await readFile(contactSheetOutput, "utf8").catch(() => "");
  let drifted = false;
  if (current !== body) {
    console.error("DRIFT deck-presets.json is out of date; run npm run presets:emit.");
    drifted = true;
  }
  if (currentContactSheet !== contactSheet) {
    console.error("DRIFT contact-sheet.html is out of date; run npm run presets:emit.");
    drifted = true;
  }
  if (drifted) process.exitCode = 1;
  else console.log(`ok ${DECK_PRESETS.length} presets, ${SLIDE_PATTERNS.length} slot schemas, ${controls.length} negative controls, and contact-sheet.html`);
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, body, "utf8");
  await writeFile(contactSheetOutput, contactSheet, "utf8");
  console.log("wrote generated/deck-presets.json and generated/contact-sheet.html");
}
