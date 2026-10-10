/**
 * The theme gallery (Design tab review, 2026-09-26).
 *
 * A deck had one built-in theme and no way to look like anything else without
 * someone building a palette by hand. These are the looks people ask for by
 * name: flat, neumorphic, glass, neo-brutalist, bento, skeuomorphic, and a set
 * of ordinary well-made ones.
 *
 * **One definition.** The TypeScript here is normative; `npm run schema:emit`
 * writes `generated/theme-presets.json` for Python, and the drift gate fails if
 * the two disagree. The fixtures' theme is the Neo Technical preset from this
 * file, so the gallery and the test decks cannot drift either.
 *
 * A preset is a complete `ThemeDefinition` plus a **style kit**: how a card and
 * a slide background look in that style. The theme alone cannot carry a look
 * like glass or neumorphism, because those live on the objects (a blur behind a
 * card, a pair of shadows), so applying a preset can optionally restyle the
 * cards and backgrounds in the same undoable change.
 *
 * Every declared contrast pair meets WCAG AA; the renderer's tests check each
 * preset with the same `checkContrastPairs` the semantic pass uses.
 */

import type {
  BackgroundDefinition,
  CommonStyle,
  ObjectStyle,
  ThemeDefinition,
} from "./index";

export interface StyleKit {
  /** Applied to shapes and styled groups that act as cards. */
  card: Pick<CommonStyle, "fill" | "stroke" | "cornerRadius" | "shadow" | "backdropFilters">;
  /** The slide background in this style; absent means the theme's colour. */
  background?: BackgroundDefinition;
}

export interface ThemePreset {
  key: string;
  name: string;
  /** One line for the gallery card. */
  summary: string;
  /** Where it sits in the gallery. */
  category: "Styles" | "Classic";
  theme: ThemeDefinition;
  kit: StyleKit;
}

/** Deterministic ids, so regenerating the gallery changes nothing. */
function presetId(index: number): string {
  return `thm_01JB8Z9K2QW4RN7F3XP00000${String(index).padStart(2, "0")}`;
}

// ----------------------------------------------------------- Neo Technical

/** The fixtures' theme, and the product's original one. `id` is the caller's, so a fixture keeps its own. */
export function technicalTheme(id: string): ThemeDefinition {
  const mono = "JetBrains Mono";
  const sans = "Inter";
  return {
    id,
    name: "Neo Technical",
    description: "Dark editorial layout with luminous technical accents.",
    mode: "dark",
    colors: {
      background: "#0B0F14",
      surface: "#121821",
      surfaceAlt: "#1A222E",
      overlay: "#000000B3",
      foreground: "#E8EEF5",
      foregroundMuted: "#9FB0C3",
      foregroundSubtle: "#6B7C90",
      accent: "#4CC2FF",
      accentForeground: "#04121C",
      accentMuted: "#1E5F80",
      secondary: "#A78BFA",
      secondaryForeground: "#150C2E",
      border: "#243141",
      borderStrong: "#35485D",
      divider: "#1C2530",
      success: "#3DDC97",
      warning: "#F2C14E",
      danger: "#FF6B6B",
      info: "#4CC2FF",
      chartSeries: ["#4CC2FF", "#A78BFA", "#3DDC97", "#F2C14E", "#FF6B6B", "#7DD3FC"],
      chartPositive: "#3DDC97",
      chartNegative: "#FF6B6B",
      chartNeutral: "#6B7C90",
    },
    typography: {
      display: { fontFamily: sans, fontSize: 96, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 },
      h1: { fontFamily: sans, fontSize: 64, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 },
      h2: { fontFamily: sans, fontSize: 44, fontWeight: 600, lineHeight: 1.15 },
      h3: { fontFamily: sans, fontSize: 32, fontWeight: 600, lineHeight: 1.2 },
      body: { fontFamily: sans, fontSize: 24, fontWeight: 400, lineHeight: 1.45 },
      bodySmall: { fontFamily: sans, fontSize: 20, fontWeight: 400, lineHeight: 1.45 },
      caption: { fontFamily: sans, fontSize: 16, fontWeight: 400, lineHeight: 1.4 },
      quote: { fontFamily: sans, fontSize: 32, fontWeight: 400, fontStyle: "italic", lineHeight: 1.35 },
      code: { fontFamily: mono, fontSize: 20, fontWeight: 400, lineHeight: 1.5 },
      // tabular numerals: without them a numberCount animation makes the slide jitter
      metric: { fontFamily: sans, fontSize: 88, fontWeight: 700, lineHeight: 1, fontFeatures: ["tnum"] },
      scaleRatio: 1.25,
    },
    spacing: {
      base: 8,
      xs: 4,
      sm: 8,
      md: 16,
      lg: 32,
      xl: 64,
      xxl: 96,
      slideMargin: { top: 80, right: 120, bottom: 80, left: 120 },
    },
    radii: { none: 0, sm: 4, md: 12, lg: 24, full: 9999 },
    shadows: {
      none: [],
      sm: [{ type: "drop", offsetX: 0, offsetY: 1, blur: 3, color: "#00000059" }],
      md: [{ type: "drop", offsetX: 0, offsetY: 6, blur: 18, color: "#00000073" }],
      lg: [{ type: "drop", offsetX: 0, offsetY: 18, blur: 48, color: "#00000099" }],
    },
    grid: { columns: 12, gutter: 24, margin: 120, baseUnit: 8, baselineGrid: 8 },
    chart: {
      series: ["#4CC2FF", "#A78BFA", "#3DDC97", "#F2C14E", "#FF6B6B", "#7DD3FC"],
      gridlineColor: "#1C2530",
      axisColor: "#6B7C90",
      showGridlines: true,
      barCornerRadius: 4,
      lineWidth: 3,
      pointSize: 6,
    },
    diagram: {
      nodeFill: { type: "solid", color: "token:colors.surface" },
      nodeStroke: { paint: { type: "solid", color: "token:colors.border" }, width: 1 },
      nodeRadius: 12,
      nodePadding: { top: 16, right: 20, bottom: 16, left: 20 },
      roleStyles: {
        service: { fill: { type: "solid", color: "token:colors.surface" } },
        datastore: { fill: { type: "solid", color: "token:colors.surfaceAlt" } },
        external: {
          fill: { type: "none" },
          stroke: {
            paint: { type: "solid", color: "token:colors.borderStrong" },
            width: 1,
            dash: [6, 4],
          },
        },
      },
    },
    imagery: { treatment: "none", defaultCornerRadius: 12 },
    motion: {
      personality: "technical",
      defaultEntrance: "fadeUp",
      defaultDurationMs: 400,
      defaultEasing: "emphasized",
      staggerMs: 70,
      reducedMotionFallback: "fade",
      maxSlideDurationMs: 2500,
    },
    contrastPairs: [
      { foreground: "colors.foreground", background: "colors.background", minimumRatio: 4.5 },
      { foreground: "colors.accentForeground", background: "colors.accent", minimumRatio: 4.5 },
      { foreground: "colors.foregroundMuted", background: "colors.background", minimumRatio: 3 },
    ],
    brandRules: [
      {
        id: "type-sizes",
        kind: "must-not",
        scope: "typography",
        statement: "Use no more than three type sizes on a single slide.",
        check: { type: "maxFontSizesPerSlide", value: 3 },
      },
      {
        id: "no-literals",
        kind: "should",
        scope: "color",
        statement: "Reference theme tokens rather than literal hex values so the deck re-themes cleanly.",
        check: { type: "forbiddenColorLiterals", value: true },
      },
      {
        id: "whitespace",
        kind: "should",
        scope: "layout",
        statement: "Use whitespace aggressively. A crowded technical slide reads as an unconsidered one.",
      },
    ],
  };
}


// ----------------------------------------------------------------- builder

interface Palette {
  background: string;
  surface: string;
  surfaceAlt: string;
  foreground: string;
  foregroundMuted: string;
  foregroundSubtle: string;
  accent: string;
  accentForeground: string;
  secondary: string;
  secondaryForeground: string;
  border: string;
  borderStrong: string;
  chartSeries: [string, string, string, string, string, string];
}

interface Spec {
  key: string;
  name: string;
  summary: string;
  category: ThemePreset["category"];
  mode: "light" | "dark";
  palette: Palette;
  heading: string;
  body: string;
  headingWeight?: number;
  radii?: { sm: number; md: number; lg: number };
  kit: StyleKit;
  motion?: "technical" | "subtle" | "cinematic" | "playful";
}

/**
 * A full theme from a palette and two faces. The structural parts (spacing,
 * grid, type scale, motion defaults, the brand rules) come from Neo Technical,
 * which is what every composer layout is tuned against; a preset changes how a
 * deck looks, not where things go.
 */
function build(index: number, spec: Spec): ThemePreset {
  const base = technicalTheme(presetId(index));
  const p = spec.palette;
  const heading = spec.heading;
  const body = spec.body;
  const weight = spec.headingWeight ?? 700;
  const radii = spec.radii ?? { sm: 4, md: 12, lg: 24 };
  const dark = spec.mode === "dark";
  const typography = base.typography as Record<string, Record<string, unknown>> & { scaleRatio: number };

  const theme: ThemeDefinition = {
    ...base,
    id: presetId(index),
    name: spec.name,
    description: spec.summary,
    mode: spec.mode,
    colors: {
      background: p.background,
      surface: p.surface,
      surfaceAlt: p.surfaceAlt,
      overlay: dark ? "#000000B3" : "#FFFFFFCC",
      foreground: p.foreground,
      foregroundMuted: p.foregroundMuted,
      foregroundSubtle: p.foregroundSubtle,
      accent: p.accent,
      accentForeground: p.accentForeground,
      accentMuted: p.surfaceAlt,
      secondary: p.secondary,
      secondaryForeground: p.secondaryForeground,
      border: p.border,
      borderStrong: p.borderStrong,
      divider: p.border,
      success: dark ? "#3DDC97" : "#15803D",
      warning: dark ? "#F2C14E" : "#B45309",
      danger: dark ? "#FF6B6B" : "#B91C1C",
      info: p.accent,
      chartSeries: [...p.chartSeries],
      chartPositive: dark ? "#3DDC97" : "#15803D",
      chartNegative: dark ? "#FF6B6B" : "#B91C1C",
      chartNeutral: p.foregroundSubtle,
    },
    typography: {
      ...base.typography,
      display: { ...typography.display, fontFamily: heading, fontWeight: weight },
      h1: { ...typography.h1, fontFamily: heading, fontWeight: weight },
      h2: { ...typography.h2, fontFamily: heading, fontWeight: Math.min(weight, 700) },
      h3: { ...typography.h3, fontFamily: heading, fontWeight: Math.min(weight, 600) },
      body: { ...typography.body, fontFamily: body },
      bodySmall: { ...typography.bodySmall, fontFamily: body },
      caption: { ...typography.caption, fontFamily: body },
      quote: { ...typography.quote, fontFamily: heading, fontWeight: 400 },
      metric: { ...typography.metric, fontFamily: heading, fontWeight: weight },
    } as ThemeDefinition["typography"],
    radii: { none: 0, sm: radii.sm, md: radii.md, lg: radii.lg, full: 9999 },
    shadows: dark
      ? base.shadows
      : {
          none: [],
          sm: [{ type: "drop", offsetX: 0, offsetY: 1, blur: 3, color: "#0000001F" }],
          md: [{ type: "drop", offsetX: 0, offsetY: 6, blur: 18, color: "#00000024" }],
          lg: [{ type: "drop", offsetX: 0, offsetY: 18, blur: 48, color: "#0000002E" }],
        },
    chart: {
      ...base.chart,
      series: [...p.chartSeries],
      gridlineColor: p.border,
      axisColor: p.foregroundSubtle,
      barCornerRadius: Math.min(radii.sm, 8),
    },
    diagram: {
      ...base.diagram,
      nodeRadius: radii.md,
    },
    imagery: { treatment: "none", defaultCornerRadius: radii.md },
    motion: { ...base.motion!, personality: spec.motion ?? "subtle" },
    contrastPairs: [
      { foreground: "colors.foreground", background: "colors.background", minimumRatio: 4.5 },
      { foreground: "colors.foreground", background: "colors.surface", minimumRatio: 4.5 },
      { foreground: "colors.accentForeground", background: "colors.accent", minimumRatio: 4.5 },
      { foreground: "colors.secondaryForeground", background: "colors.secondary", minimumRatio: 4.5 },
      { foreground: "colors.foregroundMuted", background: "colors.background", minimumRatio: 4.5 },
      { foreground: "colors.foregroundSubtle", background: "colors.background", minimumRatio: 3 },
    ],
  };

  theme.objectStyles = recommendedStyles(spec.kit);
  return { key: spec.key, name: spec.name, summary: spec.summary, category: spec.category, theme, kit: spec.kit };
}

/**
 * The styles a preset starts a deck with (design review, 2026-09-27): its own
 * card, plus a callout, a big number and a caption, all in the theme's own
 * tokens so they follow its colours and faces. Only the gallery's presets carry
 * them; the fixtures' theme is left as it was, so no fixture changes.
 */
function recommendedStyles(kit: StyleKit): NonNullable<ThemeDefinition["objectStyles"]> {
  const card = Object.fromEntries(
    Object.entries(kit.card as Record<string, unknown>).filter(([, value]) => !(value === undefined || (Array.isArray(value) && value.length === 0))),
  );
  return {
    Card: { appliesTo: "shape", style: card as ObjectStyle["style"] },
    Callout: {
      appliesTo: "shape",
      style: { fill: solid("token:colors.accent"), cornerRadius: (card.cornerRadius as number | undefined) ?? 12 },
      typography: { color: "token:colors.accentForeground", fontWeight: 600 },
    },
    "Big number": {
      appliesTo: "text",
      typography: { fontFamily: "token:typography.metric.fontFamily", fontSize: 72, fontWeight: 700, color: "token:colors.foreground", letterSpacing: -1 },
    },
    Caption: {
      appliesTo: "text",
      typography: { fontFamily: "token:typography.caption.fontFamily", fontSize: 18, color: "token:colors.foregroundMuted" },
    },
  };
}

const solid = (color: string) => ({ type: "solid" as const, color });
const line = (color: string, width: number) => ({ paint: solid(color), width });

// ----------------------------------------------------------------- presets

const NEO_TECHNICAL_KIT: StyleKit = {
  card: {
    fill: solid("token:colors.surface"),
    stroke: line("token:colors.border", 1),
    cornerRadius: 12,
    shadow: [],
    backdropFilters: [],
  },
};

const NEO_TECHNICAL: ThemePreset = {
  key: "neo-technical",
  name: "Neo Technical",
  summary: "Dark editorial layout with luminous technical accents.",
  category: "Classic",
  theme: { ...technicalTheme(presetId(0)), objectStyles: recommendedStyles(NEO_TECHNICAL_KIT) },
  kit: NEO_TECHNICAL_KIT,
};

export const THEME_PRESETS: readonly ThemePreset[] = [
  build(1, {
    key: "flat",
    name: "Flat",
    summary: "Solid colour blocks and crisp shapes. Loads fast, scales cleanly, reads at a glance.",
    category: "Styles",
    mode: "light",
    heading: "Inter",
    body: "Inter",
    palette: {
      background: "#FFFFFF",
      surface: "#F2F4F7",
      surfaceAlt: "#E4E8EE",
      foreground: "#1D2433",
      foregroundMuted: "#475467",
      foregroundSubtle: "#667085",
      accent: "#2563EB",
      accentForeground: "#FFFFFF",
      secondary: "#F97316",
      secondaryForeground: "#1D2433",
      border: "#D0D5DD",
      borderStrong: "#98A2B3",
      chartSeries: ["#2563EB", "#F97316", "#10B981", "#8B5CF6", "#EF4444", "#0EA5E9"],
    },
    radii: { sm: 4, md: 8, lg: 12 },
    kit: { card: { fill: solid("token:colors.surface"), cornerRadius: 8, shadow: [], backdropFilters: [] } },
  }),
  build(2, {
    key: "neumorphism",
    name: "Neumorphism",
    summary: "Soft extruded surfaces lit from one corner, on a single calm colour.",
    category: "Styles",
    mode: "light",
    heading: "Nunito",
    body: "Nunito",
    palette: {
      background: "#E6EBF1",
      surface: "#E6EBF1",
      surfaceAlt: "#DAE1EA",
      foreground: "#27313F",
      foregroundMuted: "#46505F",
      foregroundSubtle: "#5C6776",
      accent: "#3D4ED8",
      accentForeground: "#FFFFFF",
      secondary: "#0B7A7A",
      secondaryForeground: "#FFFFFF",
      border: "#CBD3DE",
      borderStrong: "#A7B2C2",
      chartSeries: ["#3D4ED8", "#0B7A7A", "#C2410C", "#7C3AED", "#BE123C", "#0369A1"],
    },
    radii: { sm: 12, md: 24, lg: 32 },
    kit: {
      card: {
        fill: solid("token:colors.surface"),
        cornerRadius: 24,
        shadow: [
          { type: "drop", offsetX: 12, offsetY: 12, blur: 24, spread: 0, color: "#A3B1C699" },
          { type: "drop", offsetX: -12, offsetY: -12, blur: 24, spread: 0, color: "#FFFFFFE6" },
        ],
        backdropFilters: [],
      },
    },
  }),
  build(3, {
    key: "glassmorphism",
    name: "Glassmorphism",
    summary: "Frosted translucent panels over a vivid gradient. Clear layers, heavier to render.",
    category: "Styles",
    mode: "dark",
    heading: "Space Grotesk",
    body: "Inter",
    palette: {
      background: "#1E1B4B",
      surface: "#2E2A6B",
      surfaceAlt: "#3B3585",
      foreground: "#FFFFFF",
      foregroundMuted: "#E4E1FA",
      foregroundSubtle: "#B8B2E6",
      accent: "#7DD3FC",
      accentForeground: "#0B1026",
      secondary: "#F0ABFC",
      secondaryForeground: "#2A0B2F",
      border: "#FFFFFF40",
      borderStrong: "#FFFFFF66",
      chartSeries: ["#7DD3FC", "#F0ABFC", "#86EFAC", "#FDE68A", "#FCA5A5", "#C4B5FD"],
    },
    radii: { sm: 10, md: 20, lg: 28 },
    motion: "playful",
    kit: {
      card: {
        fill: solid("#FFFFFF1F"),
        stroke: line("#FFFFFF4D", 1),
        cornerRadius: 20,
        shadow: [{ type: "drop", offsetX: 0, offsetY: 16, blur: 40, spread: -8, color: "#0000004D" }],
        backdropFilters: [{ type: "blur", radius: 18 }],
      },
      background: {
        paint: {
          type: "linearGradient",
          angle: 135,
          stops: [
            { offset: 0, color: "#1E1B4B" },
            { offset: 0.55, color: "#4C1D95" },
            { offset: 1, color: "#831843" },
          ],
        },
      },
    },
  }),
  build(4, {
    key: "neo-brutalism",
    name: "Neo-Brutalism",
    summary: "Raw grid, heavy black borders, hard shadows and loud colour. Unmistakable.",
    category: "Styles",
    mode: "light",
    heading: "Archivo Black",
    body: "Space Grotesk",
    headingWeight: 400,
    palette: {
      background: "#FFFBEB",
      surface: "#FFFFFF",
      surfaceAlt: "#FDE68A",
      foreground: "#0A0A0A",
      foregroundMuted: "#262626",
      foregroundSubtle: "#404040",
      accent: "#FF5A1F",
      accentForeground: "#0A0A0A",
      secondary: "#4F8BFF",
      secondaryForeground: "#0A0A0A",
      border: "#0A0A0A",
      borderStrong: "#0A0A0A",
      chartSeries: ["#FF5A1F", "#4F8BFF", "#22C55E", "#FACC15", "#EC4899", "#0A0A0A"],
    },
    radii: { sm: 0, md: 0, lg: 0 },
    motion: "playful",
    kit: {
      card: {
        fill: solid("token:colors.surface"),
        stroke: line("#0A0A0A", 4),
        cornerRadius: 0,
        shadow: [{ type: "drop", offsetX: 8, offsetY: 8, blur: 0, spread: 0, color: "#0A0A0A" }],
        backdropFilters: [],
      },
    },
  }),
  build(5, {
    key: "bento",
    name: "Bento",
    summary: "Modular cards of different sizes on a quiet grid. Made for dense information.",
    category: "Styles",
    mode: "light",
    heading: "DM Sans",
    body: "DM Sans",
    palette: {
      background: "#F5F5F4",
      surface: "#FFFFFF",
      surfaceAlt: "#E7E5E4",
      foreground: "#1C1917",
      foregroundMuted: "#44403C",
      foregroundSubtle: "#6B6560",
      accent: "#0369A1",
      accentForeground: "#FFFFFF",
      secondary: "#A3E635",
      secondaryForeground: "#1C1917",
      border: "#E7E5E4",
      borderStrong: "#A8A29E",
      chartSeries: ["#0369A1", "#65A30D", "#EA580C", "#7C3AED", "#DB2777", "#0891B2"],
    },
    radii: { sm: 8, md: 20, lg: 28 },
    kit: {
      card: {
        fill: solid("token:colors.surface"),
        stroke: line("token:colors.border", 1),
        cornerRadius: 24,
        shadow: [{ type: "drop", offsetX: 0, offsetY: 4, blur: 16, spread: 0, color: "#1C19170F" }],
        backdropFilters: [],
      },
    },
  }),
  build(6, {
    key: "skeuomorphic",
    name: "Skeuomorphic",
    summary: "Paper, ink and bevelled cards with real-feeling light and depth.",
    category: "Styles",
    mode: "light",
    heading: "Lora",
    body: "Source Serif 4",
    palette: {
      background: "#EDE3D1",
      surface: "#F7F1E5",
      surfaceAlt: "#E4D6BC",
      foreground: "#3B2A1A",
      foregroundMuted: "#54402C",
      foregroundSubtle: "#6F5840",
      accent: "#8B3A1E",
      accentForeground: "#FFF8EE",
      secondary: "#2F5D50",
      secondaryForeground: "#FFF8EE",
      border: "#C9B89A",
      borderStrong: "#9C8664",
      chartSeries: ["#8B3A1E", "#2F5D50", "#B7791F", "#5B4A8B", "#9B2C2C", "#2C5282"],
    },
    radii: { sm: 4, md: 10, lg: 16 },
    motion: "subtle",
    kit: {
      card: {
        fill: {
          type: "linearGradient",
          angle: 180,
          stops: [
            { offset: 0, color: "#FFFDF8" },
            { offset: 1, color: "#EFE6D4" },
          ],
        },
        stroke: line("token:colors.border", 1),
        cornerRadius: 10,
        shadow: [
          { type: "drop", offsetX: 0, offsetY: 6, blur: 14, spread: 0, color: "#5C46312E" },
          { type: "inner", offsetX: 0, offsetY: 1, blur: 0, spread: 0, color: "#FFFFFFCC" },
        ],
        backdropFilters: [],
      },
      background: {
        paint: {
          type: "linearGradient",
          angle: 180,
          stops: [
            { offset: 0, color: "#F3EAD8" },
            { offset: 1, color: "#E4D6BC" },
          ],
        },
      },
    },
  }),
  NEO_TECHNICAL,
  build(7, {
    key: "quiet-luxury",
    name: "Quiet Luxury",
    summary: "Warm ivory, a serif headline and a single bronze accent. Restraint as the point.",
    category: "Classic",
    mode: "light",
    heading: "Playfair Display",
    body: "Inter",
    palette: {
      background: "#F6F1EA",
      surface: "#FFFFFF",
      surfaceAlt: "#EDE4D8",
      foreground: "#1F1A14",
      foregroundMuted: "#4A4036",
      foregroundSubtle: "#6B5F52",
      accent: "#7A5A32",
      accentForeground: "#FFFFFF",
      secondary: "#1F3A34",
      secondaryForeground: "#F6F1EA",
      border: "#E5DCCF",
      borderStrong: "#B9AB97",
      chartSeries: ["#7A5A32", "#1F3A34", "#A0764A", "#5B6B63", "#8C4A3C", "#3E4F6B"],
    },
    radii: { sm: 2, md: 2, lg: 4 },
    motion: "subtle",
    kit: {
      card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 2, shadow: [], backdropFilters: [] },
    },
  }),
  build(8, {
    key: "minimal-light",
    name: "Minimal Light",
    summary: "Black on white with one red. Nothing on the slide that is not the message.",
    category: "Classic",
    mode: "light",
    heading: "Inter",
    body: "Inter",
    palette: {
      background: "#FFFFFF",
      surface: "#FAFAFA",
      surfaceAlt: "#F0F0F0",
      foreground: "#111111",
      foregroundMuted: "#444444",
      foregroundSubtle: "#6A6A6A",
      accent: "#111111",
      accentForeground: "#FFFFFF",
      secondary: "#D0243B",
      secondaryForeground: "#FFFFFF",
      border: "#E5E5E5",
      borderStrong: "#A3A3A3",
      chartSeries: ["#111111", "#D0243B", "#737373", "#2563EB", "#A3A3A3", "#15803D"],
    },
    radii: { sm: 2, md: 6, lg: 10 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 6, shadow: [], backdropFilters: [] } },
  }),
  build(9, {
    key: "midnight",
    name: "Midnight",
    summary: "Deep navy with a warm gold accent. Dramatic without shouting.",
    category: "Classic",
    mode: "dark",
    heading: "Manrope",
    body: "Inter",
    headingWeight: 800,
    palette: {
      background: "#0B1020",
      surface: "#141B31",
      surfaceAlt: "#1D2644",
      foreground: "#E7ECF7",
      foregroundMuted: "#B4BED6",
      foregroundSubtle: "#8B97B3",
      accent: "#F5B942",
      accentForeground: "#1A1300",
      secondary: "#7C9CFF",
      secondaryForeground: "#0B1020",
      border: "#26304D",
      borderStrong: "#3A4670",
      chartSeries: ["#F5B942", "#7C9CFF", "#4ADE80", "#F472B6", "#38BDF8", "#FB923C"],
    },
    radii: { sm: 6, md: 16, lg: 24 },
    kit: {
      card: {
        fill: solid("token:colors.surface"),
        stroke: line("token:colors.border", 1),
        cornerRadius: 16,
        shadow: [{ type: "drop", offsetX: 0, offsetY: 18, blur: 40, spread: -8, color: "#00000080" }],
        backdropFilters: [],
      },
    },
  }),
  build(10, {
    key: "editorial-serif",
    name: "Editorial Serif",
    summary: "Magazine typography: a high-contrast serif, generous margins, a single red.",
    category: "Classic",
    mode: "light",
    heading: "Fraunces",
    body: "Source Serif 4",
    headingWeight: 600,
    palette: {
      background: "#FBF8F3",
      surface: "#FFFFFF",
      surfaceAlt: "#F1EBE1",
      foreground: "#1A1A1A",
      foregroundMuted: "#3F3F3F",
      foregroundSubtle: "#636363",
      accent: "#B42318",
      accentForeground: "#FFFFFF",
      secondary: "#1D4E89",
      secondaryForeground: "#FFFFFF",
      border: "#E3DCCF",
      borderStrong: "#A69C8C",
      chartSeries: ["#B42318", "#1D4E89", "#B7791F", "#2F6B4F", "#6B3FA0", "#4A4A4A"],
    },
    radii: { sm: 0, md: 2, lg: 4 },
    motion: "subtle",
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 0, shadow: [], backdropFilters: [] } },
  }),
  build(11, {
    key: "playful-pastel",
    name: "Playful Pastel",
    summary: "Soft candy colours, round shapes and friendly type for workshops and kickoffs.",
    category: "Classic",
    mode: "light",
    heading: "Nunito",
    body: "Nunito",
    headingWeight: 800,
    palette: {
      background: "#FFF7F0",
      surface: "#FFFFFF",
      surfaceAlt: "#FFE4E6",
      foreground: "#2D1B3D",
      foregroundMuted: "#4F3D5F",
      foregroundSubtle: "#6E5C80",
      accent: "#6D28D9",
      accentForeground: "#FFFFFF",
      secondary: "#F472B6",
      secondaryForeground: "#2D1B3D",
      border: "#F5D0E0",
      borderStrong: "#D8A7C4",
      chartSeries: ["#6D28D9", "#F472B6", "#22C55E", "#F59E0B", "#0EA5E9", "#EF4444"],
    },
    radii: { sm: 12, md: 24, lg: 32 },
    motion: "playful",
    kit: {
      card: {
        fill: solid("token:colors.surface"),
        cornerRadius: 28,
        shadow: [{ type: "drop", offsetX: 0, offsetY: 10, blur: 24, spread: 0, color: "#F472B633" }],
        backdropFilters: [],
      },
    },
  }),
  build(12, {
    key: "oceanic",
    name: "Oceanic",
    summary: "Deep teal, sea-glass surfaces and a bright aqua signal for calm product stories.",
    category: "Classic",
    mode: "dark",
    heading: "Manrope",
    body: "Inter",
    palette: {
      background: "#062A30", surface: "#0B3940", surfaceAlt: "#124A52",
      foreground: "#F2FCFC", foregroundMuted: "#C0DDDF", foregroundSubtle: "#91BEC1",
      accent: "#67E8F9", accentForeground: "#062A30", secondary: "#FBBF24", secondaryForeground: "#2B1900",
      border: "#285A60", borderStrong: "#4B7E83",
      chartSeries: ["#67E8F9", "#FBBF24", "#86EFAC", "#C4B5FD", "#FDA4AF", "#93C5FD"],
    },
    radii: { sm: 8, md: 18, lg: 28 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 18, shadow: [], backdropFilters: [] } },
  }),
  build(13, {
    key: "forest",
    name: "Forest",
    summary: "Evergreen, parchment and moss accents for grounded strategy and sustainability work.",
    category: "Classic",
    mode: "light",
    heading: "Lora",
    body: "Inter",
    palette: {
      background: "#F3F5EC", surface: "#FFFFFF", surfaceAlt: "#E3E9D5",
      foreground: "#17251B", foregroundMuted: "#405044", foregroundSubtle: "#637067",
      accent: "#245C35", accentForeground: "#FFFFFF", secondary: "#9A5B13", secondaryForeground: "#FFFFFF",
      border: "#CBD4C2", borderStrong: "#95A58C",
      chartSeries: ["#245C35", "#9A5B13", "#4267A9", "#7A3E8E", "#B23A48", "#397A78"],
    },
    radii: { sm: 4, md: 12, lg: 20 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 12, shadow: [], backdropFilters: [] } },
  }),
  build(14, {
    key: "sunset",
    name: "Sunset",
    summary: "Ink-dark violet with coral and apricot highlights for launches and cultural stories.",
    category: "Styles",
    mode: "dark",
    heading: "Space Grotesk",
    body: "Inter",
    palette: {
      background: "#25152D", surface: "#34203D", surfaceAlt: "#482B50",
      foreground: "#FFF7F5", foregroundMuted: "#E8CFD9", foregroundSubtle: "#C4A4B3",
      accent: "#FFB38A", accentForeground: "#32170A", secondary: "#F472B6", secondaryForeground: "#321026",
      border: "#60405F", borderStrong: "#825B7E",
      chartSeries: ["#FFB38A", "#F472B6", "#FDE68A", "#93C5FD", "#86EFAC", "#C4B5FD"],
    },
    radii: { sm: 10, md: 20, lg: 30 },
    motion: "playful",
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 20, shadow: [{ type: "drop", offsetX: 0, offsetY: 12, blur: 28, spread: -6, color: "#00000066" }], backdropFilters: [] } },
  }),
  build(15, {
    key: "blueprint",
    name: "Blueprint",
    summary: "Cobalt drafting-paper contrast for architecture, systems and engineering reviews.",
    category: "Styles",
    mode: "dark",
    heading: "IBM Plex Mono",
    body: "Inter",
    palette: {
      background: "#0A2A52", surface: "#123968", surfaceAlt: "#1A477B",
      foreground: "#F4F9FF", foregroundMuted: "#C8DDF4", foregroundSubtle: "#99BBDE",
      accent: "#7DD3FC", accentForeground: "#082440", secondary: "#FDE047", secondaryForeground: "#292100",
      border: "#3A6190", borderStrong: "#6386AE",
      chartSeries: ["#7DD3FC", "#FDE047", "#86EFAC", "#FDA4AF", "#C4B5FD", "#FDBA74"],
    },
    radii: { sm: 0, md: 4, lg: 8 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("#7DD3FC66", 1), cornerRadius: 4, shadow: [], backdropFilters: [] } },
  }),
  build(16, {
    key: "paper-ink",
    name: "Paper & Ink",
    summary: "Warm paper, charcoal type and underlined blue for reports and teaching.",
    category: "Classic",
    mode: "light",
    heading: "Source Serif 4",
    body: "Source Serif 4",
    palette: {
      background: "#F8F3E8", surface: "#FFFDF8", surfaceAlt: "#ECE4D5",
      foreground: "#22201D", foregroundMuted: "#4A4640", foregroundSubtle: "#6D675E",
      accent: "#2457A6", accentForeground: "#FFFFFF", secondary: "#9B3A2B", secondaryForeground: "#FFFFFF",
      border: "#DED5C5", borderStrong: "#AFA493",
      chartSeries: ["#2457A6", "#9B3A2B", "#28705B", "#8A5A12", "#6C4AA1", "#4D6475"],
    },
    radii: { sm: 0, md: 2, lg: 4 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 2, shadow: [], backdropFilters: [] } },
  }),
  build(17, {
    key: "high-contrast",
    name: "High Contrast",
    summary: "Near-black and white with electric yellow for maximum room readability.",
    category: "Styles",
    mode: "dark",
    heading: "Archivo Black",
    body: "Inter",
    headingWeight: 400,
    palette: {
      background: "#080808", surface: "#171717", surfaceAlt: "#262626",
      foreground: "#FFFFFF", foregroundMuted: "#D4D4D4", foregroundSubtle: "#A3A3A3",
      accent: "#FDE047", accentForeground: "#171200", secondary: "#60A5FA", secondaryForeground: "#07192F",
      border: "#404040", borderStrong: "#737373",
      chartSeries: ["#FDE047", "#60A5FA", "#4ADE80", "#F472B6", "#FB923C", "#C4B5FD"],
    },
    radii: { sm: 0, md: 0, lg: 0 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.foreground", 2), cornerRadius: 0, shadow: [], backdropFilters: [] } },
  }),
  build(18, {
    key: "lavender",
    name: "Lavender",
    summary: "Airy lavender surfaces and plum type for workshops, portfolios and thoughtful teams.",
    category: "Classic",
    mode: "light",
    heading: "Jost",
    body: "Inter",
    palette: {
      background: "#F7F3FF", surface: "#FFFFFF", surfaceAlt: "#ECE3FA",
      foreground: "#2D1F3D", foregroundMuted: "#534362", foregroundSubtle: "#756681",
      accent: "#6736A5", accentForeground: "#FFFFFF", secondary: "#A83F73", secondaryForeground: "#FFFFFF",
      border: "#DCCFF0", borderStrong: "#B6A2D1",
      chartSeries: ["#6736A5", "#A83F73", "#287064", "#A45A16", "#3567A8", "#7A556D"],
    },
    radii: { sm: 10, md: 20, lg: 28 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 20, shadow: [{ type: "drop", offsetX: 0, offsetY: 8, blur: 22, spread: -8, color: "#6736A522" }], backdropFilters: [] } },
  }),
  build(19, {
    key: "civic",
    name: "Civic",
    summary: "Trustworthy navy, public-service blue and clear sans typography for formal briefings.",
    category: "Classic",
    mode: "light",
    heading: "DM Sans",
    body: "Inter",
    palette: {
      background: "#F4F7FA", surface: "#FFFFFF", surfaceAlt: "#E5EDF5",
      foreground: "#142331", foregroundMuted: "#3E5263", foregroundSubtle: "#63788A",
      accent: "#005EA8", accentForeground: "#FFFFFF", secondary: "#8A4B08", secondaryForeground: "#FFFFFF",
      border: "#C8D6E2", borderStrong: "#92A8BA",
      chartSeries: ["#005EA8", "#8A4B08", "#26734D", "#7A438F", "#B23A48", "#3B6C8E"],
    },
    radii: { sm: 4, md: 8, lg: 12 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.border", 1), cornerRadius: 8, shadow: [], backdropFilters: [] } },
  }),
  // The two pilot design languages' own themes (UI audit unit 5). A language is
  // more than its theme, but its theme is where its colour logic lives.
  build(20, {
    key: "swiss-signal",
    name: "Swiss Signal",
    summary: "White ground, black grotesque, one red signal and square corners: the International Typographic Style.",
    category: "Styles",
    mode: "light",
    heading: "Inter",
    body: "Inter",
    headingWeight: 800,
    palette: {
      background: "#FFFFFF", surface: "#F4F4F2", surfaceAlt: "#E8E8E5",
      foreground: "#0A0A0A", foregroundMuted: "#3A3A3A", foregroundSubtle: "#5E5E5E",
      accent: "#D0021B", accentForeground: "#FFFFFF", secondary: "#0A0A0A", secondaryForeground: "#FFFFFF",
      border: "#D9D9D6", borderStrong: "#0A0A0A",
      chartSeries: ["#D0021B", "#0A0A0A", "#6E6E6E", "#A8A8A4", "#7A0010", "#3A3A3A"],
    },
    radii: { sm: 0, md: 0, lg: 0 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.borderStrong", 2), cornerRadius: 0, shadow: [], backdropFilters: [] } },
  }),
  build(21, {
    key: "cinema-noir",
    name: "Cinema Noir",
    summary: "Near-black frames, a cream high-contrast serif and one warm lamplight accent: a film-noir title card.",
    category: "Styles",
    mode: "dark",
    heading: "Playfair Display",
    body: "Source Serif 4",
    palette: {
      background: "#0A0A0B", surface: "#141416", surfaceAlt: "#1E1E21",
      foreground: "#EFE9DE", foregroundMuted: "#C4BDB1", foregroundSubtle: "#9C9588",
      accent: "#D9B26B", accentForeground: "#0A0A0B", secondary: "#8E2A24", secondaryForeground: "#EFE9DE",
      border: "#2A2A2E", borderStrong: "#5A564F",
      chartSeries: ["#D9B26B", "#EFE9DE", "#8A8478", "#B4504A", "#6B7A82", "#C4BDB1"],
    },
    radii: { sm: 0, md: 0, lg: 0 },
    motion: "subtle",
    kit: { card: { fill: solid("token:colors.surfaceAlt"), stroke: line("token:colors.border", 1), cornerRadius: 0, shadow: [], backdropFilters: [] } },
  }),
  // System Terminal's theme (UI audit unit 7a). The other five later languages
  // follow existing presets (playful-pastel, quiet-luxury, civic, forest,
  // glassmorphism); a terminal needs monospace everywhere, which none of them is.
  build(22, {
    key: "system-terminal",
    name: "System Terminal",
    summary: "A dark terminal: monospace everywhere, phosphor-green output and an amber warning.",
    category: "Styles",
    mode: "dark",
    heading: "IBM Plex Mono",
    body: "IBM Plex Mono",
    headingWeight: 600,
    palette: {
      background: "#0B0E0C", surface: "#141915", surfaceAlt: "#1C231E",
      foreground: "#D7F2D3", foregroundMuted: "#A3C29E", foregroundSubtle: "#7E9A7A",
      accent: "#4ADE80", accentForeground: "#0B0E0C", secondary: "#F5B33D", secondaryForeground: "#0B0E0C",
      border: "#26302A", borderStrong: "#4A5C4F",
      chartSeries: ["#4ADE80", "#F5B33D", "#7DD3FC", "#D7F2D3", "#F87171", "#A3C29E"],
    },
    radii: { sm: 0, md: 0, lg: 0 },
    kit: { card: { fill: solid("token:colors.surface"), stroke: line("token:colors.borderStrong", 1), cornerRadius: 0, shadow: [], backdropFilters: [] } },
  }),
];

export function findPreset(key: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.key === key);
}
