import type { MotionStyleId } from "./schema";

/** The composer's seven base layouts, which every slide pattern composes as. */
export type ComposerLayout = "title" | "statement" | "bullets" | "metrics" | "quote" | "code" | "split";
const SIX = ["title", "statement", "bullets", "metrics", "quote", "split"] as const;

/**
 * Design languages: what makes one template family look unlike another (UI
 * audit 2026-10-10, unit 5).
 *
 * Rendering every template for real (unit 2) showed the catalog honestly: 24
 * templates, one title layout, different colours. A theme changes colour and
 * type; a language changes the grammar: the grid, where the headline sits, how
 * large it is against the body, what draws the eye, what a data slide looks
 * like, what is never allowed. Research behind the pilots is in
 * `docs/design-audit/research/2026-10-10-design-languages.md`.
 *
 * The contract is data, for three readers: the gallery (axes and names), an
 * agent (`rules`, prose it can follow), and the composer, which owns the
 * geometry. A language names layouts and rules; it never carries coordinates,
 * because that would let a caller place pixels (CLAUDE.md, "callers provide
 * intent, code composes geometry"). `apps/api/deckastra_api/languages.py`
 * holds the geometry each language composes with.
 *
 * `defaults` is the single source of a template's theme, motion, transition
 * and voice. A template names its language and overrides only what it must;
 * an override equal to the default is refused, because it is the duplicate
 * that drifts when the language changes.
 */

export interface LanguageDefaults {
  themeKey: string;
  motionStyle: MotionStyleId;
  transitionStyle: string;
  voiceStyle: string;
}

/** Five art-direction axes the gallery filters on. Descriptions, not dials: nothing generates from them. */
export interface LanguageAxes {
  expression: "editorial" | "expressive";
  density: "dense" | "spacious";
  imagery: "photographic" | "graphic";
  motion: "calm" | "kinetic";
  tone: "formal" | "playful";
}

export interface DesignLanguage {
  id: string;
  name: string;
  /** Bumped when the language's composition changes, and recorded on every deck it composes. */
  version: number;
  summary: string;
  axes: LanguageAxes;
  typography: {
    /** How much larger each step is than the one below it. */
    scaleRatio: number;
    /** Display type set in capitals, as Swiss and noir title cards often were. */
    displayCase: "as-written" | "uppercase";
    /** Negative tightens large display type; it is set in hundredths of an em by the composer. */
    displayTracking: "tight" | "normal" | "wide";
    alignment: "flush-left" | "centred" | "mixed";
  };
  grid: {
    columns: number;
    /** Strong asymmetry puts text in a narrow column and leaves the rest as space or a motif. */
    asymmetry: "none" | "strong";
  };
  density: { maxBullets: number; maxHeadlineWords: number };
  imagery: {
    kind: "none" | "graphic" | "photographic";
    frame: "none" | "full-bleed" | "framed";
  };
  data: { emphasis: "one-accent" | "all-equal"; gridlines: boolean };
  shapes: { radius: number; motifs: readonly string[] };
  /**
   * The composer layouts this language draws itself; any other falls back to
   * the neutral one. Held to the composer's registry
   * (`languages.LANGUAGE_LAYOUTS`) by a Python test, so an agent reading this
   * is told what will actually happen.
   */
  layouts: readonly ComposerLayout[];
  /** Combinations a deck in this language must not contain, in words an agent can check. */
  forbid: readonly string[];
  /** The language's own rules, as prose an agent follows before it writes slot text. */
  rules: readonly string[];
  defaults: LanguageDefaults;
}

export const DESIGN_LANGUAGES = {
  neutral: {
    id: "neutral",
    name: "Neutral",
    version: 1,
    summary: "The composer's own grammar: a clear headline, a measured column, nothing that competes with the content.",
    axes: { expression: "editorial", density: "dense", imagery: "graphic", motion: "calm", tone: "formal" },
    typography: { scaleRatio: 1.25, displayCase: "as-written", displayTracking: "normal", alignment: "mixed" },
    grid: { columns: 1, asymmetry: "none" },
    density: { maxBullets: 6, maxHeadlineWords: 12 },
    imagery: { kind: "none", frame: "none" },
    data: { emphasis: "all-equal", gridlines: true },
    shapes: { radius: 12, motifs: [] },
    layouts: [],
    forbid: [],
    rules: ["Write one idea per slide.", "Keep headlines under twelve words."],
    defaults: { themeKey: "neo-technical", motionStyle: "restrained", transitionStyle: "fade", voiceStyle: "confident" },
  },
  "swiss-signal": {
    id: "swiss-signal",
    name: "Swiss Signal",
    version: 1,
    summary: "International Typographic Style: an asymmetric grid, oversized grotesque type set flush left, black and white with one red signal.",
    axes: { expression: "expressive", density: "spacious", imagery: "graphic", motion: "calm", tone: "formal" },
    typography: { scaleRatio: 1.618, displayCase: "uppercase", displayTracking: "tight", alignment: "flush-left" },
    grid: { columns: 12, asymmetry: "strong" },
    density: { maxBullets: 4, maxHeadlineWords: 5 },
    imagery: { kind: "graphic", frame: "none" },
    data: { emphasis: "one-accent", gridlines: false },
    shapes: { radius: 0, motifs: ["red-rule", "signal-disc", "index-number"] },
    layouts: SIX,
    forbid: [
      "centred text",
      "more than one accent colour",
      "rounded corners",
      "decorative photography",
      "more than four bullets on a slide",
    ],
    rules: [
      "Headlines are short statements of five words or fewer; the type is the image.",
      "Everything is flush left on the grid; never centre a line.",
      "Red marks the one thing that matters on a slide: one number, one rule, one disc.",
      "Number the sections: the index is part of the layout.",
      "Prefer a single large figure to a row of small ones.",
    ],
    defaults: { themeKey: "swiss-signal", motionStyle: "restrained", transitionStyle: "cut", voiceStyle: "direct" },
  },
  "cinema-noir": {
    id: "cinema-noir",
    name: "Cinema Noir",
    version: 1,
    summary: "Film-noir title cards: near-black frames with letterbox bars, a high-contrast serif in cream, one warm light, and slow fades.",
    axes: { expression: "expressive", density: "spacious", imagery: "photographic", motion: "calm", tone: "formal" },
    typography: { scaleRatio: 1.5, displayCase: "as-written", displayTracking: "wide", alignment: "centred" },
    grid: { columns: 1, asymmetry: "none" },
    density: { maxBullets: 3, maxHeadlineWords: 8 },
    imagery: { kind: "photographic", frame: "full-bleed" },
    data: { emphasis: "one-accent", gridlines: false },
    shapes: { radius: 0, motifs: ["letterbox", "spotlight", "hairline"] },
    layouts: SIX,
    forbid: [
      "light backgrounds",
      "bright saturated colour",
      "more than three bullets on a slide",
      "dense tables",
      "playful or rounded type",
    ],
    rules: [
      "Every slide is a scene: one line of dialogue, one figure, one quotation.",
      "Write headlines as a film title or a line said aloud, not a label.",
      "Light comes from one place: the warm accent is a lamp, used once per slide.",
      "Let silence work: few words, slow fades, nothing that hurries.",
      "A number is evidence in a case file: state it, then say what it means.",
    ],
    defaults: { themeKey: "cinema-noir", motionStyle: "cinematic", transitionStyle: "fade", voiceStyle: "measured" },
  },
  "play-lab": {
    id: "play-lab",
    name: "Play Lab",
    version: 1,
    summary: "A playground: soft bubbles, a tilted sticker for the label, rounded cards that each hold one idea, and a heavy friendly display.",
    axes: { expression: "expressive", density: "spacious", imagery: "graphic", motion: "kinetic", tone: "playful" },
    typography: { scaleRatio: 1.414, displayCase: "as-written", displayTracking: "tight", alignment: "flush-left" },
    grid: { columns: 2, asymmetry: "none" },
    density: { maxBullets: 4, maxHeadlineWords: 9 },
    imagery: { kind: "graphic", frame: "framed" },
    data: { emphasis: "all-equal", gridlines: false },
    shapes: { radius: 36, motifs: ["bubble", "sticker", "idea-card", "speech-bubble"] },
    layouts: SIX,
    forbid: ["square corners", "hairline rules", "more than four ideas on a slide", "small print as the main text", "grey-on-grey colour"],
    rules: [
      "One idea per card, written as a short sentence someone would say out loud.",
      "The label is a sticker: two or three words, never a sentence.",
      "Use both theme colours; a slide that uses only one feels unfinished here.",
      "Numbers are big and celebrated, each on its own coloured tile.",
      "Keep headlines warm and direct: address the audience as you.",
    ],
    defaults: { themeKey: "playful-pastel", motionStyle: "playful", transitionStyle: "push", voiceStyle: "bright" },
  },
  "system-terminal": {
    id: "system-terminal",
    name: "System Terminal",
    version: 1,
    summary: "A terminal session: a window bar, monospace everything, a prompt before each label, line numbers, a block cursor, and one green.",
    axes: { expression: "editorial", density: "dense", imagery: "graphic", motion: "calm", tone: "formal" },
    typography: { scaleRatio: 1.25, displayCase: "as-written", displayTracking: "tight", alignment: "flush-left" },
    grid: { columns: 1, asymmetry: "strong" },
    density: { maxBullets: 6, maxHeadlineWords: 10 },
    imagery: { kind: "none", frame: "none" },
    data: { emphasis: "one-accent", gridlines: true },
    shapes: { radius: 0, motifs: ["window-bar", "prompt", "line-numbers", "cursor", "block-comment"] },
    layouts: [...SIX, "code"],
    forbid: ["proportional display type", "rounded corners", "photography", "decorative gradients", "centred text"],
    rules: [
      "Write labels as commands: lower case, a verb first.",
      "Every list item is a numbered line, short enough to fit on one.",
      "A figure sits in a table cell with its label above it, like output.",
      "Supporting lines are comments: they explain, they do not sell.",
      "Green marks what succeeded or what matters; nothing else is coloured.",
    ],
    defaults: { themeKey: "system-terminal", motionStyle: "technical", transitionStyle: "cut", voiceStyle: "precise" },
  },
  "quiet-luxe": {
    id: "quiet-luxe",
    name: "Quiet Luxe",
    version: 1,
    summary: "A lookbook: wide margins, a light serif display, small tracked capitals, hairlines instead of boxes, and a tall portrait frame.",
    axes: { expression: "editorial", density: "spacious", imagery: "photographic", motion: "calm", tone: "formal" },
    typography: { scaleRatio: 1.5, displayCase: "as-written", displayTracking: "normal", alignment: "mixed" },
    grid: { columns: 2, asymmetry: "strong" },
    density: { maxBullets: 4, maxHeadlineWords: 9 },
    imagery: { kind: "photographic", frame: "framed" },
    data: { emphasis: "all-equal", gridlines: false },
    shapes: { radius: 0, motifs: ["hairline", "portrait-frame", "tracked-capitals"] },
    layouts: SIX,
    forbid: ["bold display type", "filled cards", "more than one accent colour", "busy charts", "exclamation marks"],
    rules: [
      "Say less than you could; the space around the words is the luxury.",
      "Labels are two or three words in tracked capitals.",
      "A list is a short set of considered lines, divided by hairlines.",
      "Figures are set large and light, never bold.",
      "Every slide leaves at least a third of its area empty.",
    ],
    defaults: { themeKey: "quiet-luxury", motionStyle: "editorial", transitionStyle: "fade", voiceStyle: "assured" },
  },
  "data-desk": {
    id: "data-desk",
    name: "Data Desk",
    version: 1,
    summary: "An operations dashboard: a header strip with a status dot, bordered tiles, figures larger than anything else, and spark bars.",
    axes: { expression: "editorial", density: "dense", imagery: "graphic", motion: "calm", tone: "formal" },
    typography: { scaleRatio: 1.333, displayCase: "as-written", displayTracking: "tight", alignment: "flush-left" },
    grid: { columns: 4, asymmetry: "none" },
    density: { maxBullets: 5, maxHeadlineWords: 10 },
    imagery: { kind: "graphic", frame: "none" },
    data: { emphasis: "all-equal", gridlines: true },
    shapes: { radius: 12, motifs: ["header-strip", "status-dot", "kpi-tile", "spark-bars", "trend-bar"] },
    layouts: SIX,
    forbid: ["decorative photography", "centred headlines", "more than four figures on a slide", "figures without a label", "script or display serif type"],
    rules: [
      "Headlines state the finding, not the topic: say what the numbers mean.",
      "Every figure has a label that names its unit and period.",
      "Lists are rows in a table, each one line, ranked by importance.",
      "The section label sits in the header strip, in capitals.",
      "Put the most important figure first, on the left.",
    ],
    defaults: { themeKey: "civic", motionStyle: "restrained", transitionStyle: "fade", voiceStyle: "analytical" },
  },
  "earth-story": {
    id: "earth-story",
    name: "Earth Story",
    version: 1,
    summary: "A field journal: a block of earth colour, arched frames for photographs, a low hill along the foot, a serif voice, lists walked as stepping stones.",
    axes: { expression: "expressive", density: "spacious", imagery: "photographic", motion: "calm", tone: "playful" },
    typography: { scaleRatio: 1.414, displayCase: "as-written", displayTracking: "normal", alignment: "flush-left" },
    grid: { columns: 2, asymmetry: "strong" },
    density: { maxBullets: 4, maxHeadlineWords: 10 },
    imagery: { kind: "photographic", frame: "framed" },
    data: { emphasis: "all-equal", gridlines: false },
    shapes: { radius: 0, motifs: ["earth-block", "arch-frame", "hill", "stepping-stones", "leaf"] },
    layouts: SIX,
    forbid: ["neon or electric colour", "hard grid tables", "monospace type", "more than four steps on a slide", "dense jargon"],
    rules: [
      "Tell it as a journey: where it began, what changed, where it leads.",
      "Lists are steps along a path, in the order they happened.",
      "Figures are grown things: one number in each seed, with what it means beneath.",
      "Write as a person to a person; avoid acronyms in headlines.",
      "Each section opens on the earth block or an arch, never a bare heading.",
    ],
    defaults: { themeKey: "forest", motionStyle: "editorial", transitionStyle: "fade", voiceStyle: "warm" },
  },
  "spatial-future": {
    id: "spatial-future",
    name: "Spatial Future",
    version: 1,
    summary: "A view into a space: glowing orbs, an orbit ring, glass panels the light passes through, and a light geometric display set centred.",
    axes: { expression: "expressive", density: "spacious", imagery: "graphic", motion: "kinetic", tone: "formal" },
    typography: { scaleRatio: 1.5, displayCase: "as-written", displayTracking: "tight", alignment: "centred" },
    grid: { columns: 4, asymmetry: "none" },
    density: { maxBullets: 4, maxHeadlineWords: 8 },
    imagery: { kind: "graphic", frame: "framed" },
    data: { emphasis: "one-accent", gridlines: false },
    shapes: { radius: 32, motifs: ["glow", "orbit-ring", "glass-panel", "hologram-frame"] },
    layouts: SIX,
    forbid: ["light backgrounds", "serif type", "heavy borders", "more than four cards on a slide", "flat clip-art"],
    rules: [
      "Headlines name a future state, in eight words or fewer.",
      "Labels are spaced capitals in the accent colour.",
      "Each card is one capability, numbered, with one sentence.",
      "Glow is light, not decoration: one or two sources per slide.",
      "Figures glow in the accent; their labels stay quiet.",
    ],
    defaults: { themeKey: "glassmorphism", motionStyle: "dynamic", transitionStyle: "zoom", voiceStyle: "optimistic" },
  },
} as const satisfies Record<string, DesignLanguage>;

export type DesignLanguageId = keyof typeof DESIGN_LANGUAGES;

export const DESIGN_LANGUAGE_IDS = Object.keys(DESIGN_LANGUAGES) as DesignLanguageId[];

export function isDesignLanguage(value: string): value is DesignLanguageId {
  return Object.prototype.hasOwnProperty.call(DESIGN_LANGUAGES, value);
}
