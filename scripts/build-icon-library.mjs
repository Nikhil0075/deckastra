#!/usr/bin/env node
/**
 * Build the extended icon library from Lucide (design review, 2026-09-27).
 *
 *   node scripts/build-icon-library.mjs
 *
 * Reads `lucide-static` (a development dependency, ISC with some MIT icons from
 * Feather) and writes `packages/renderer/src/icon-library.ts`: the chosen icons
 * as stroked paths and circles on the same 24×24 grid as the curated set, with
 * their categories and Lucide's own search tags. Every shape Lucide uses —
 * rect, line, polyline, polygon, ellipse — is converted to path data here, so
 * the renderer and the PowerPoint exporter only ever meet `paths` and
 * `circles`, as they do for the curated icons.
 *
 * The output is committed (the renderer runs offline and in the headless
 * exporter, with no package to read at runtime) and deterministic: the same
 * Lucide version writes the same bytes. Re-run it after changing the list.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lucideDir = dirname(require.resolve("lucide-static/package.json"));
const nodes = JSON.parse(readFileSync(join(lucideDir, "icon-nodes.json"), "utf8"));
const tags = JSON.parse(readFileSync(join(lucideDir, "tags.json"), "utf8"));
const version = JSON.parse(readFileSync(join(lucideDir, "package.json"), "utf8")).version;
const license = readFileSync(join(lucideDir, "LICENSE"), "utf8").trim();

/** Chosen by category, for the decks people actually make. */
const CATEGORIES = {
  Science: ["flask-conical", "flask-round", "atom", "dna", "microscope", "telescope", "test-tube", "test-tubes", "beaker", "magnet", "orbit", "radiation", "rocket", "satellite", "thermometer", "leaf", "sprout", "globe"],
  Healthcare: ["stethoscope", "heart-pulse", "activity", "pill", "syringe", "hospital", "ambulance", "brain", "bone", "cross", "bandage", "thermometer-sun", "hand-heart", "accessibility", "baby", "dumbbell"],
  Finance: ["banknote", "coins", "wallet", "credit-card", "landmark", "piggy-bank", "receipt", "calculator", "trending-up", "trending-down", "badge-dollar-sign", "hand-coins", "chart-candlestick", "scale", "percent", "briefcase"],
  Manufacturing: ["factory", "wrench", "hammer", "cog", "settings", "package", "boxes", "truck", "forklift", "container", "hard-hat", "drill", "plug", "battery-charging", "fuel", "recycle"],
  Product: ["smartphone", "laptop", "monitor", "tablet", "mouse-pointer-click", "layout-dashboard", "app-window", "puzzle", "layers", "component", "palette", "pen-tool", "sparkles", "wand", "bell"],
  Data: ["chart-column", "chart-bar", "chart-line", "chart-pie", "chart-scatter", "chart-area", "chart-network", "table", "sheet", "funnel", "sigma", "binary", "hard-drive", "server-cog", "cloud-upload", "cloud-download", "workflow", "network"],
  People: ["user", "users", "user-plus", "user-check", "contact", "handshake", "message-circle", "messages-square", "mail", "phone", "video", "megaphone", "graduation-cap", "school", "presentation", "award"],
  Places: ["map", "map-pin", "navigation", "building", "hotel", "house", "store", "warehouse", "plane", "train-front", "car", "ship", "compass", "mountain", "sun", "moon"],
  Arrows: ["arrow-right", "arrow-left", "arrow-up", "arrow-down", "arrow-up-right", "arrow-down-right", "arrow-right-left", "repeat", "refresh-cw", "rotate-ccw", "move", "chevrons-right", "corner-down-right", "git-branch", "git-merge", "shuffle"],
  General: ["check", "circle-check", "x", "circle-x", "plus", "minus", "info", "circle-question-mark", "triangle-alert", "star", "heart", "thumbs-up", "flag", "bookmark", "tag", "calendar", "clock", "timer", "search", "eye", "lock", "key-round", "shield-check", "link", "paperclip", "file-text", "folder", "image", "camera", "mic", "music", "gift", "target", "zap", "lightbulb", "trophy", "rocket"],
};

// ------------------------------------------------------------- conversion

const num = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
};

function rectPath({ x = 0, y = 0, width, height, rx, ry }) {
  const w = Number(width);
  const h = Number(height);
  let r = Number(rx ?? ry ?? 0);
  let s = Number(ry ?? rx ?? 0);
  r = Math.min(r, w / 2);
  s = Math.min(s, h / 2);
  const X = Number(x);
  const Y = Number(y);
  if (!r && !s) return `M${num(X)} ${num(Y)}h${num(w)}v${num(h)}h${num(-w)}Z`;
  return (
    `M${num(X + r)} ${num(Y)}h${num(w - 2 * r)}a${num(r)} ${num(s)} 0 0 1 ${num(r)} ${num(s)}` +
    `v${num(h - 2 * s)}a${num(r)} ${num(s)} 0 0 1 ${num(-r)} ${num(s)}` +
    `h${num(-(w - 2 * r))}a${num(r)} ${num(s)} 0 0 1 ${num(-r)} ${num(-s)}` +
    `v${num(-(h - 2 * s))}a${num(r)} ${num(s)} 0 0 1 ${num(r)} ${num(-s)}Z`
  );
}

function pointsPath(points, close) {
  const values = String(points).trim().split(/[\s,]+/).map(Number);
  const pairs = [];
  for (let i = 0; i + 1 < values.length; i += 2) pairs.push(`${num(values[i])} ${num(values[i + 1])}`);
  return `M${pairs.join("L")}${close ? "Z" : ""}`;
}

function convert(name) {
  const paths = [];
  const circles = [];
  for (const [tag, attributes] of nodes[name]) {
    switch (tag) {
      case "path":
        paths.push(attributes.d);
        break;
      case "circle":
        circles.push([Number(attributes.cx), Number(attributes.cy), Number(attributes.r)]);
        break;
      case "rect":
        paths.push(rectPath(attributes));
        break;
      case "line":
        paths.push(`M${num(attributes.x1)} ${num(attributes.y1)}L${num(attributes.x2)} ${num(attributes.y2)}`);
        break;
      case "polyline":
        paths.push(pointsPath(attributes.points, false));
        break;
      case "polygon":
        paths.push(pointsPath(attributes.points, true));
        break;
      case "ellipse": {
        const cx = Number(attributes.cx);
        const cy = Number(attributes.cy);
        const rx = Number(attributes.rx);
        const ry = Number(attributes.ry);
        paths.push(`M${num(cx - rx)} ${num(cy)}a${num(rx)} ${num(ry)} 0 1 0 ${num(2 * rx)} 0a${num(rx)} ${num(ry)} 0 1 0 ${num(-2 * rx)} 0`);
        break;
      }
      default:
        throw new Error(`${name}: a <${tag}> cannot be converted`);
    }
  }
  return { paths, circles };
}

// ------------------------------------------------------------------ write

const seen = new Set();
const missing = [];
const entries = [];
for (const [category, names] of Object.entries(CATEGORIES)) {
  for (const name of names) {
    if (seen.has(name)) continue;
    if (!nodes[name]) {
      missing.push(name);
      continue;
    }
    seen.add(name);
    const { paths, circles } = convert(name);
    const keywords = (tags[name] ?? []).filter((tag) => typeof tag === "string").slice(0, 8);
    entries.push({ name, category, paths, circles, keywords });
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const body = entries
  .map((entry) => {
    const circles = entry.circles.length ? `, circles: ${JSON.stringify(entry.circles)}` : "";
    return `  ${JSON.stringify(entry.name)}: { category: ${JSON.stringify(entry.category)}, paths: ${JSON.stringify(entry.paths)}${circles}, keywords: ${JSON.stringify(entry.keywords)} },`;
  })
  .join("\n");

const header = `/**
 * GENERATED by scripts/build-icon-library.mjs from lucide-static ${version}. Do not
 * edit by hand; change the list in the script and run it again.
 *
 * The extended icon library (design review, 2026-09-27): ${entries.length} icons in
 * ${Object.keys(CATEGORIES).length} categories, on the curated set's 24×24 grid, as stroked
 * paths and circles. Where a name is also in the curated set, the curated icon
 * wins.
 *
${license
  .split("\n")
  .map((line) => ` * ${line}`.trimEnd())
  .join("\n")}
 */

export const LIBRARY_CATEGORIES = ${JSON.stringify(Object.keys(CATEGORIES))} as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export interface LibraryIcon {
  category: LibraryCategory;
  paths: string[];
  circles?: [number, number, number][];
  keywords: string[];
}

export const ICON_LIBRARY: Record<string, LibraryIcon> = {
`;

writeFileSync(join(root, "packages/renderer/src/icon-library.ts"), `${header}${body}\n};\n`);
console.log(`icon-library: ${entries.length} icons written${missing.length ? `; not in Lucide ${version}: ${missing.join(", ")}` : ""}`);
