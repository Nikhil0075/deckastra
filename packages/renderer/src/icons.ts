/**
 * The curated icon set (doc 02 §15, doc 04 §19).
 *
 * Icons are inlined as path data rather than fetched from an icon CDN or bundled
 * as a font. Three reasons, all of which the alternative fails:
 *
 * 1. A `.mydeck` must render offline and in the headless export service, which
 *    have no network.
 * 2. Determinism. A remotely fetched icon that 404s once produces a different
 *    render, and byte-identical output is the contract the export pipeline is
 *    built on.
 * 3. Tinting. An icon is a theme-coloured object, so it has to be a path the
 *    renderer strokes with a resolved token, not an opaque image.
 *
 * The set is deliberately small and generic. An agent asks for "a database icon"
 * and gets one; it cannot ask for a brand logo, which is what `set: "custom"`
 * with a sanitised asset is for.
 *
 * All geometry is on a 24×24 grid, drawn as strokes with round caps and joins so
 * one `strokeWidth` scales the whole set coherently.
 */

import { ICON_LIBRARY, LIBRARY_CATEGORIES, type LibraryCategory } from "./icon-library";

export interface IconDefinition {
  /** Path `d` values, stroked in order. */
  paths: string[];
  /** Where the Add library files it. */
  category?: LibraryCategory;
  /** Circles drawn after the paths, as [cx, cy, r]. */
  circles?: [number, number, number][];
  /** Search terms an agent or the editor's picker can match on. */
  keywords: string[];
}

export const ICON_VIEWBOX = 24;

const ICONS: Record<string, IconDefinition> = {
  // ---------------------------------------------------------------- systems
  database: {
    paths: [
      "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z",
      "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
      "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
    ],
    keywords: ["storage", "sql", "postgres", "table", "persistence"],
  },
  server: {
    paths: [
      "M3 4h18v6H3z",
      "M3 14h18v6H3z",
      "M7 7h.01",
      "M7 17h.01",
    ],
    keywords: ["host", "machine", "backend", "rack"],
  },
  cloud: {
    paths: ["M6.5 18a4.5 4.5 0 0 1 .3-9 6 6 0 0 1 11.4 2A3.5 3.5 0 0 1 17.5 18Z"],
    keywords: ["saas", "hosted", "aws", "infrastructure"],
  },
  cpu: {
    paths: ["M8 8h8v8H8z", "M4 9h4M4 15h4M16 9h4M16 15h4M9 4v4M15 4v4M9 16v4M15 16v4"],
    keywords: ["compute", "processor", "chip", "model"],
  },
  network: {
    paths: ["M12 7v4", "M6 21v-4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4", "M9 3h6v4H9z"],
    circles: [
      [6, 21, 0.01],
      [18, 21, 0.01],
    ],
    keywords: ["topology", "graph", "mesh", "nodes"],
  },
  api: {
    paths: ["M4 8 1 12l3 4", "M20 8l3 4-3 4", "M14 5l-4 14"],
    keywords: ["endpoint", "interface", "code", "contract"],
  },
  terminal: {
    paths: ["M3 4h18v16H3z", "M7 9l3 3-3 3", "M13 15h4"],
    keywords: ["cli", "shell", "console", "command"],
  },
  layers: {
    paths: ["M12 3 3 8l9 5 9-5-9-5Z", "M3 13l9 5 9-5", "M3 18l9 5"],
    keywords: ["stack", "architecture", "tiers"],
  },
  workflow: {
    paths: ["M4 4h6v6H4z", "M14 14h6v6h-6z", "M10 7h4a3 3 0 0 1 3 3v4"],
    keywords: ["pipeline", "process", "flow", "orchestration"],
  },
  git: {
    paths: ["M6 3v12", "M18 9v3a3 3 0 0 1-3 3H9"],
    circles: [
      [6, 18, 3],
      [18, 6, 3],
    ],
    keywords: ["branch", "version", "repository", "commit"],
  },

  // ---------------------------------------------------------------- meaning
  check: {
    paths: ["M4 13l5 5L20 6"],
    keywords: ["done", "success", "yes", "complete"],
  },
  "check-circle": {
    paths: ["M8 12.5l3 3 5.5-6"],
    circles: [[12, 12, 9]],
    keywords: ["approved", "passed", "verified"],
  },
  close: {
    paths: ["M5 5l14 14", "M19 5 5 19"],
    keywords: ["no", "remove", "cancel", "reject"],
  },
  alert: {
    paths: ["M12 3 2 21h20L12 3Z", "M12 10v5", "M12 18h.01"],
    keywords: ["warning", "caution", "risk", "attention"],
  },
  info: {
    paths: ["M12 11v6", "M12 8h.01"],
    circles: [[12, 12, 9]],
    keywords: ["note", "detail", "about"],
  },
  shield: {
    paths: ["M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6l8-3Z"],
    keywords: ["security", "safety", "protection", "trust"],
  },
  lock: {
    paths: ["M5 11h14v10H5z", "M8 11V8a4 4 0 0 1 8 0v3"],
    keywords: ["private", "auth", "permission", "secure"],
  },
  key: {
    paths: ["M14.5 9.5 21 3", "M18 6l2 2", "M16 8l2 2"],
    circles: [[9, 15, 5]],
    keywords: ["credential", "token", "access", "secret"],
  },
  eye: {
    paths: ["M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"],
    circles: [[12, 12, 3]],
    keywords: ["view", "visibility", "observe", "monitor"],
  },
  zap: {
    paths: ["M13 2 4 14h7l-1 8 9-12h-7l1-8Z"],
    keywords: ["fast", "performance", "speed", "instant"],
  },

  // ---------------------------------------------------------------- objects
  file: {
    paths: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z", "M14 3v5h5"],
    keywords: ["document", "page", "asset"],
  },
  folder: {
    paths: ["M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
    keywords: ["directory", "group", "project"],
  },
  code: {
    paths: ["M9 6 4 12l5 6", "M15 6l5 6-5 6"],
    keywords: ["source", "programming", "snippet"],
  },
  chart: {
    paths: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
    keywords: ["metrics", "analytics", "data", "graph"],
  },
  clock: {
    paths: ["M12 7v5l3 2"],
    circles: [[12, 12, 9]],
    keywords: ["time", "latency", "duration", "schedule"],
  },
  calendar: {
    paths: ["M4 6h16v15H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
    keywords: ["date", "timeline", "roadmap", "schedule"],
  },
  mail: {
    paths: ["M3 6h18v12H3z", "m3 7 9 6 9-6"],
    keywords: ["email", "message", "notify", "contact"],
  },
  search: {
    paths: ["m16 16 5 5"],
    circles: [[10.5, 10.5, 6.5]],
    keywords: ["find", "query", "lookup", "retrieval"],
  },
  settings: {
    paths: ["M12 2v3", "M12 19v3", "M4.2 4.2l2.1 2.1", "M17.7 17.7l2.1 2.1", "M2 12h3", "M19 12h3", "M4.2 19.8l2.1-2.1", "M17.7 6.3l2.1-2.1"],
    circles: [[12, 12, 4]],
    keywords: ["config", "options", "preferences", "control"],
  },
  link: {
    paths: ["M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1", "M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"],
    keywords: ["url", "reference", "connect", "chain"],
  },

  // ---------------------------------------------------------------- people
  user: {
    paths: ["M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"],
    circles: [[12, 7, 4]],
    keywords: ["person", "actor", "customer", "account"],
  },
  users: {
    paths: ["M2 21v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1", "M16 4.5a4 4 0 0 1 0 7", "M17 15h1a4 4 0 0 1 4 4v2"],
    circles: [[8.5, 7, 3.5]],
    keywords: ["team", "audience", "group", "stakeholders"],
  },
  building: {
    paths: ["M4 21V4h10v17", "M14 9h6v12", "M7 8h4M7 12h4M7 16h4M17 13h1M17 17h1"],
    keywords: ["company", "organization", "enterprise", "office"],
  },
  globe: {
    paths: ["M2.5 12h19", "M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"],
    circles: [[12, 12, 9]],
    keywords: ["world", "global", "region", "internet"],
  },

  // ---------------------------------------------------------------- motion
  "arrow-right": {
    paths: ["M4 12h15", "m13 6 6 6-6 6"],
    keywords: ["next", "forward", "then", "flow"],
  },
  "arrow-up-right": {
    paths: ["M7 17 17 7", "M9 7h8v8"],
    keywords: ["growth", "increase", "improve", "up"],
  },
  "arrow-down-right": {
    paths: ["M7 7l10 10", "M17 9v8H9"],
    keywords: ["decrease", "decline", "reduce", "down"],
  },
  refresh: {
    paths: ["M20 11a8 8 0 0 0-14-4L3 10", "M4 13a8 8 0 0 0 14 4l3-3", "M3 5v5h5", "M21 19v-5h-5"],
    keywords: ["retry", "sync", "reload", "loop"],
  },
  play: {
    paths: ["M7 4l13 8-13 8V4Z"],
    keywords: ["start", "run", "present", "execute"],
  },
  target: {
    paths: [],
    circles: [
      [12, 12, 9],
      [12, 12, 5],
      [12, 12, 1.5],
    ],
    keywords: ["goal", "objective", "aim", "focus"],
  },
  star: {
    paths: ["M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z"],
    keywords: ["favourite", "quality", "highlight", "rating"],
  },
  lightbulb: {
    paths: ["M9 18h6", "M10 21h4", "M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z"],
    keywords: ["idea", "insight", "innovation", "concept"],
  },
};

/**
 * Where each curated icon sits in the Add library. The extended library
 * (`icon-library.ts`, generated from Lucide) brings its own categories; a
 * curated icon keeps its name, its drawing and this category over any Lucide
 * icon of the same name.
 */
const CURATED_CATEGORY: Record<string, LibraryCategory> = {
  database: "Data", server: "Data", cloud: "Data", cpu: "Data", network: "Data", api: "Data", terminal: "Product",
  layers: "Product", workflow: "Data", git: "Arrows", check: "General", "check-circle": "General", close: "General",
  alert: "General", info: "General", shield: "General", lock: "General", key: "General", eye: "General", zap: "General",
  file: "General", folder: "General", code: "Product", chart: "Data", clock: "General", calendar: "General",
  mail: "People", search: "General", settings: "Manufacturing", link: "General", user: "People", users: "People",
  building: "Places", globe: "Places", "arrow-right": "Arrows", "arrow-up-right": "Arrows",
  "arrow-down-right": "Arrows", refresh: "Arrows", play: "Product", target: "General", star: "General", lightbulb: "General",
};

for (const [name, definition] of Object.entries(ICONS)) definition.category ??= CURATED_CATEGORY[name] ?? "General";
for (const [name, definition] of Object.entries(ICON_LIBRARY)) ICONS[name] ??= definition;

export const ICON_CATEGORIES = LIBRARY_CATEGORIES;

export const ICON_NAMES = Object.keys(ICONS).sort();

/**
 * Look up an icon.
 *
 * Returns `undefined` for anything not curated — including every `simple-icons`
 * brand glyph, which is a licensing question rather than a rendering one. The
 * caller draws a labelled placeholder, so a deck that asks for an icon this
 * build does not have still says which one it wanted.
 */
export function findIcon(name: string): IconDefinition | undefined {
  const normalised = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (ICONS[normalised]) return ICONS[normalised];

  // A near-miss on a keyword is worth honouring: an agent asking for "warning"
  // means `alert`, and a blank box helps nobody.
  for (const [key, definition] of Object.entries(ICONS)) {
    if (definition.keywords.includes(normalised)) return ICONS[key];
  }

  return undefined;
}
