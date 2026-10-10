import type { MotionStyleId } from "./schema";

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
} as const satisfies Record<string, DesignLanguage>;

export type DesignLanguageId = keyof typeof DESIGN_LANGUAGES;

export const DESIGN_LANGUAGE_IDS = Object.keys(DESIGN_LANGUAGES) as DesignLanguageId[];

export function isDesignLanguage(value: string): value is DesignLanguageId {
  return Object.prototype.hasOwnProperty.call(DESIGN_LANGUAGES, value);
}
