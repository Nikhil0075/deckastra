import { DESIGN_LANGUAGES, isDesignLanguage, type DesignLanguageId, type LanguageDefaults } from "./languages";
import { PATTERN_DEFINITIONS, type DeckPreset, type PurposeGroup, type SlidePattern, type SlotValue } from "./schema";

/**
 * The first templates written in a design language (UI audit unit 5): two in
 * Swiss Signal, two in Cinema Noir. Each has its own slide sequence, chosen for
 * what the language does well, rather than the one-sequence-per-purpose the
 * neutral catalog shares; and its copy follows the language's `rules`.
 *
 * A template here names its language and overrides only what it must. The
 * language's `defaults` fill the rest, so a change to Swiss Signal's theme
 * reaches every Swiss template without editing any of them.
 */

export interface PresetSource {
  id: string;
  name: string;
  summary: string;
  purpose: PurposeGroup;
  tags: string[];
  designLanguage: DesignLanguageId;
  /** Only what differs from the language's defaults; an equal value is refused. */
  overrides?: Partial<LanguageDefaults>;
  slides: Array<{ pattern: SlidePattern; purpose: string; eyebrow: string; headline: string; slots?: Record<string, SlotValue> }>;
}

export function resolvePreset(source: PresetSource): DeckPreset {
  const language = DESIGN_LANGUAGES[source.designLanguage];
  const style = { ...language.defaults, ...source.overrides };
  return {
    id: source.id,
    name: source.name,
    summary: source.summary,
    purpose: source.purpose,
    tags: source.tags,
    designLanguage: source.designLanguage,
    themeKey: style.themeKey,
    motionStyle: style.motionStyle,
    transitionStyle: style.transitionStyle,
    voiceStyle: style.voiceStyle,
    reviewed: true,
    slides: source.slides.map((slide, index) => ({
      key: `${slide.pattern}-${index + 1}`,
      pattern: slide.pattern,
      purpose: slide.purpose,
      slots: {
        ...PATTERN_DEFINITIONS[slide.pattern].exampleSlots,
        ...slide.slots,
        eyebrow: slide.eyebrow,
        headline: slide.headline,
      },
    })),
  };
}

export interface SourceIssue {
  code: string;
  path: string;
  message: string;
}

/** A source names a known language and makes no override equal to its default. */
export function validatePresetSources(sources: readonly PresetSource[]): SourceIssue[] {
  const issues: SourceIssue[] = [];
  for (const [index, source] of sources.entries()) {
    const base = `pilots/${index}`;
    if (!isDesignLanguage(source.designLanguage)) {
      issues.push({ code: "E_PRESET_LANGUAGE", path: `${base}/designLanguage`, message: `Unknown design language ${JSON.stringify(source.designLanguage)}.` });
      continue;
    }
    const defaults = DESIGN_LANGUAGES[source.designLanguage].defaults as LanguageDefaults;
    for (const [field, value] of Object.entries(source.overrides ?? {})) {
      if (defaults[field as keyof LanguageDefaults] === value) {
        issues.push({
          code: "E_PRESET_OVERRIDE_REDUNDANT",
          path: `${base}/overrides/${field}`,
          message: `${source.id} overrides ${field} with ${JSON.stringify(value)}, which is already ${source.designLanguage}'s default. Remove it, or it will drift when the language changes.`,
        });
      }
    }
    const limit = DESIGN_LANGUAGES[source.designLanguage].density.maxHeadlineWords;
    for (const [slideIndex, slide] of source.slides.entries()) {
      const words = slide.headline.trim().split(/\s+/).length;
      if (words > limit) {
        issues.push({
          code: "E_PRESET_HEADLINE_LONG",
          path: `${base}/slides/${slideIndex}/headline`,
          message: `${source.id}: "${slide.headline}" is ${words} words; ${source.designLanguage} allows ${limit}.`,
        });
      }
    }
  }
  return issues;
}

const index = (n: number) => String(n).padStart(2, "0");

export const PILOT_SOURCES: readonly PresetSource[] = [
  {
    id: "swiss-strategy-brief",
    name: "Strategy brief",
    summary: "A strategy told in short, numbered statements on an asymmetric grid, with one red signal per slide.",
    purpose: "business",
    tags: ["strategy", "swiss", "board", "brief"],
    designLanguage: "swiss-signal",
    slides: [
      { pattern: "title", purpose: "Name the strategy", eyebrow: index(1), headline: "Focus wins", slots: { subtitle: "Strategy brief for the next eighteen months" } },
      { pattern: "executive-summary", purpose: "State the plan in three lines", eyebrow: index(2), headline: "Three moves" },
      { pattern: "big-number", purpose: "Show the one number that matters", eyebrow: index(3), headline: "Retention decides it" },
      { pattern: "problem", purpose: "Name the constraint", eyebrow: index(4), headline: "Breadth is the cost" },
      { pattern: "comparison", purpose: "Compare the paths", eyebrow: index(5), headline: "Two paths, one choice" },
      { pattern: "process", purpose: "Lay out the sequence", eyebrow: index(6), headline: "Sequence the work" },
      { pattern: "market", purpose: "Size the opportunity", eyebrow: index(7), headline: "Where demand moves" },
      { pattern: "quote", purpose: "Let a customer say it", eyebrow: index(8), headline: "In their words" },
      { pattern: "recommendation", purpose: "Make the recommendation", eyebrow: index(9), headline: "Commit to the core" },
      { pattern: "closing", purpose: "Close on the decision", eyebrow: index(10), headline: "Decide today", slots: { subtitle: "One owner, one date, one measure" } },
    ],
  },
  {
    id: "swiss-launch-signal",
    name: "Launch signal",
    summary: "A product launch as a typographic poster series: numbered sections, oversized words, one red mark.",
    purpose: "product",
    tags: ["launch", "product", "swiss", "release"],
    designLanguage: "swiss-signal",
    overrides: { motionStyle: "technical" },
    slides: [
      { pattern: "title", purpose: "Announce the product", eyebrow: index(1), headline: "Introducing Signal", slots: { subtitle: "The fastest route from idea to review" } },
      { pattern: "agenda", purpose: "Index the launch", eyebrow: index(2), headline: "Index" },
      { pattern: "problem", purpose: "Name the friction", eyebrow: index(3), headline: "Waiting is the work" },
      { pattern: "feature-grid", purpose: "Show what it does", eyebrow: index(4), headline: "Three capabilities" },
      { pattern: "big-number", purpose: "Prove the speed", eyebrow: index(5), headline: "Four times faster" },
      { pattern: "comparison", purpose: "Before and after", eyebrow: index(6), headline: "Before, after" },
      { pattern: "feedback", purpose: "Early users", eyebrow: index(7), headline: "Heard in beta" },
      { pattern: "release-plan", purpose: "Rollout", eyebrow: index(8), headline: "Rollout in three stages" },
      { pattern: "decision", purpose: "What we ask", eyebrow: index(9), headline: "Ship on Monday" },
      { pattern: "closing", purpose: "Sign off", eyebrow: index(10), headline: "Signal is live", slots: { subtitle: "Start today" } },
    ],
  },
  {
    id: "noir-case-file",
    name: "Case file",
    summary: "A business problem told as an investigation: dark frames, letterbox bars, a serif title card for every scene.",
    purpose: "business",
    tags: ["investigation", "post-mortem", "noir", "story"],
    designLanguage: "cinema-noir",
    slides: [
      { pattern: "title", purpose: "Open the case", eyebrow: "CASE FILE", headline: "The quarter we lost", slots: { subtitle: "An investigation in eight scenes" } },
      { pattern: "story-beat", purpose: "Set the scene", eyebrow: "SCENE ONE", headline: "Nobody saw it coming" },
      { pattern: "big-number", purpose: "The evidence", eyebrow: "EXHIBIT A", headline: "One number told the story" },
      { pattern: "quote", purpose: "A witness speaks", eyebrow: "WITNESS", headline: "Someone said it out loud" },
      { pattern: "timeline", purpose: "Reconstruct the night", eyebrow: "THE NIGHT", headline: "How it unfolded" },
      { pattern: "root-cause", purpose: "Find the cause", eyebrow: "THE CAUSE", headline: "It was never the tooling" },
      { pattern: "statement", purpose: "The turn", eyebrow: "THE TURN", headline: "We stopped guessing" },
      { pattern: "reflection", purpose: "What it taught us", eyebrow: "AFTERMATH", headline: "What the quiet taught us" },
      { pattern: "decision", purpose: "Close the case", eyebrow: "VERDICT", headline: "Close the gap this week" },
      { pattern: "closing", purpose: "Fade out", eyebrow: "END", headline: "Case closed", slots: { subtitle: "Questions from the floor" } },
    ],
  },
  {
    id: "noir-night-story",
    name: "Night story",
    summary: "A personal story lit like a film: one warm light in the dark, slow fades, a title card for each chapter.",
    purpose: "personal",
    tags: ["story", "biography", "noir", "film"],
    designLanguage: "cinema-noir",
    overrides: { voiceStyle: "warm" },
    slides: [
      { pattern: "title", purpose: "Open the film", eyebrow: "A STORY IN SIX REELS", headline: "The long way home", slots: { subtitle: "Told in the order it happened" } },
      { pattern: "story-beat", purpose: "Where it started", eyebrow: "REEL ONE", headline: "It began at night" },
      { pattern: "biography", purpose: "Who they were", eyebrow: "THE LEAD", headline: "A stranger to the city" },
      { pattern: "timeline", purpose: "The years", eyebrow: "REEL TWO", headline: "Ten years, four cities" },
      { pattern: "gallery", purpose: "The places", eyebrow: "LOCATIONS", headline: "Rooms we remember" },
      { pattern: "big-number", purpose: "The measure of it", eyebrow: "REEL THREE", headline: "A life in numbers" },
      { pattern: "quote", purpose: "The line everyone remembers", eyebrow: "THE LINE", headline: "What she always said" },
      { pattern: "reflection", purpose: "Looking back", eyebrow: "REEL FOUR", headline: "What the light showed" },
      { pattern: "story-beat", purpose: "The turn home", eyebrow: "REEL FIVE", headline: "Then the door opened" },
      { pattern: "thank-you", purpose: "Roll credits", eyebrow: "FIN", headline: "Thank you for watching", slots: { subtitle: "Stay for the credits" } },
    ],
  },
];

export const PILOT_PRESETS: readonly DeckPreset[] = PILOT_SOURCES.map(resolvePreset);
