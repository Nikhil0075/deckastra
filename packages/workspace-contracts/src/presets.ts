import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

export type PurposeGroup = "business" | "product" | "teaching" | "technical" | "team" | "personal";
export type BaseSlidePattern = "title" | "statement" | "bullets" | "metrics" | "quote" | "code" | "split";
export type DataSlideLayout = "chart" | "diagram" | "timeline" | "image";
export type LayoutFamily =
  | "cover" | "statement" | "agenda" | "section" | "comparison" | "process" | "practice"
  | "timeline" | "roadmap" | "checklist" | "big-number" | "profile" | "case-study"
  | "decision" | "closing" | "summary" | "feature-grid" | "journey" | "pricing"
  | "gallery" | "reflection" | "data-chart" | "architecture" | "system-flow" | "code-demo" | "media"
  | "metrics" | "quote" | "split" | "list";
export type PatternContentKind = "text" | "metrics" | "chart" | "diagram" | "timeline" | "media" | "code";
export type SlidePattern = BaseSlidePattern
  | "agenda" | "section" | "comparison" | "process" | "timeline" | "roadmap" | "checklist" | "pros-cons" | "big-number" | "profile" | "case-study" | "decision" | "closing"
  | "executive-summary" | "problem" | "opportunity" | "market" | "financials" | "risks" | "recommendation" | "appendix"
  | "feature-grid" | "user-journey" | "release-plan" | "pricing" | "feedback" | "demo" | "changelog"
  | "learning-objectives" | "concept" | "example" | "exercise" | "quiz" | "reflection" | "resources"
  | "architecture" | "system-flow" | "api-contract" | "data-model" | "incident" | "root-cause" | "benchmark"
  | "team-update" | "wins" | "blockers" | "responsibilities" | "retrospective" | "shout-outs"
  | "gallery" | "biography" | "event-schedule" | "story-beat" | "thank-you"
  | "bar-chart" | "trend-chart" | "waterfall-chart" | "slope-chart" | "share-chart"
  | "system-diagram" | "process-flow" | "milestones" | "full-bleed-photo";
/**
 * A chart's data as a plan carries it: categories and named series, or, for a
 * scatter, bubble chart or bubble map, the points themselves (2026-10-13). The
 * server checks which a type needs.
 */
export interface ChartPlanInput {
  type?: string;
  categories?: string[];
  series?: Array<{ name: string; values: number[] }>;
  points?: Array<{ label?: string; x?: number; y?: number; size?: number; latitude?: number; longitude?: number; group?: string }>;
  x_title?: string;
  y_title?: string;
  unit?: string;
}

export type PresetSlotValue =
  | string
  | string[]
  | Array<{ value: string; label: string }>
  | ChartPlanInput
  | { kind?: string; direction?: "LR" | "TB"; view?: "flat" | "isometric" | "stack" | "orbit"; nodes: Array<{ key: string; label: string; sublabel?: string; role?: string }>; edges?: Array<{ source: string; target: string; label?: string }> }
  | Array<{ when: string; label: string; detail?: string }>;
export type PresetSlotKind = "text" | "text-list" | "metrics" | "chart" | "diagram" | "timeline";
export type MotionStyleId = "restrained" | "dynamic" | "cinematic" | "editorial" | "energetic" | "technical" | "playful";

export interface PresetSlotDefinition {
  kind: PresetSlotKind;
  label: string;
  description: string;
  required?: boolean;
  minItems?: number;
  maxItems?: number;
  recommendedMaxChars?: number;
  itemRecommendedMaxChars?: number;
}

export interface PresetPatternDefinition {
  name: string;
  summary: string;
  composerLayout: BaseSlidePattern | DataSlideLayout;
  family?: LayoutFamily;
  variant?: string;
  contentKinds?: PatternContentKind[];
  previewKey?: string;
  version?: number;
  slots: Record<string, PresetSlotDefinition>;
  requiresOneOf?: string[][];
  exampleSlots: Record<string, PresetSlotValue>;
}

export interface PresetSlide {
  key: string;
  pattern: SlidePattern;
  purpose: string;
  slots: Record<string, PresetSlotValue>;
}

export interface DeckPreset {
  id: string;
  name: string;
  summary: string;
  purpose: PurposeGroup;
  tags: string[];
  /** The design language it composes in (UI audit unit 5). Absent from an older server. */
  designLanguage?: string;
  themeKey: string;
  motionStyle: MotionStyleId;
  transitionStyle: string;
  voiceStyle: string;
  reviewed: true;
  slides: PresetSlide[];
}

export interface PresetTheme {
  key: string;
  name: string;
  summary: string;
  preview: {
    background?: string;
    foreground?: string;
    accent?: string;
    surface?: string;
  };
}

export interface PresetCatalog {
  catalogVersion?: number;
  description: string;
  purposeGroups: PurposeGroup[];
  slidePatterns: SlidePattern[];
  patternDefinitions: Record<SlidePattern, PresetPatternDefinition>;
  motionStyles: Record<MotionStyleId, {
    name: string;
    summary: string;
    entrance: string;
    pacing: "tight" | "measured" | "deliberate";
    sequence: string[];
    clickReveals: number;
  }>;
  presets: DeckPreset[];
  themes: PresetTheme[];
  /** What each design language is, for the gallery and for agents. Absent from an older server. */
  designLanguages?: Record<string, PresetDesignLanguage>;
}

export interface PresetDesignLanguage {
  id: string;
  name: string;
  version: number;
  summary: string;
  axes: {
    expression: "editorial" | "expressive";
    density: "dense" | "spacious";
    imagery: "photographic" | "graphic";
    motion: "calm" | "kinetic";
    tone: "formal" | "playful";
  };
  rules: string[];
  forbid: string[];
  /** The layouts this language draws itself; any other composes neutral. */
  layouts?: string[];
  density?: { maxBullets: number; maxHeadlineWords: number };
  defaults?: { themeKey: string; motionStyle: string; transitionStyle: string; voiceStyle: string };
}

export interface StoryMetric {
  value: string;
  label: string;
}

export interface StoryPlanSlide {
  /** A composer layout; the data layouts carry their data in the fields below. */
  layout: BaseSlidePattern | DataSlideLayout;
  /** Optional concrete V2 pattern; layout remains the compatibility fallback. */
  pattern_id?: SlidePattern;
  purpose: string;
  key_message: string;
  headline: string;
  eyebrow?: string;
  subtitle?: string;
  body?: string;
  bullets?: string[];
  metrics?: StoryMetric[];
  quote?: string;
  attribution?: string;
  code?: string;
  language?: string;
  caption?: string;
  speaker_notes?: string;
  /** Required by the chart layout. */
  chart?: ChartPlanInput;
  /** Required by the diagram layout; edges name nodes by key. */
  diagram?: {
    kind?: string;
    direction?: "LR" | "TB";
    view?: "flat" | "isometric" | "stack" | "orbit";
    nodes: Array<{ key: string; label: string; sublabel?: string; role?: string }>;
    edges?: Array<{ source: string; target: string; label?: string }>;
  };
  /** Two or more entries, required by the timeline layout. */
  timeline?: Array<{ when: string; label: string; detail?: string }>;
  /** The image layout: what the photograph shows. */
  picture?: string;
}

export interface StoryPlanInput {
  title: string;
  audience: string;
  objective: string;
  narrative_arc: string;
  slides: StoryPlanSlide[];
}

export interface DeckFromTemplateRequest {
  template_id: string;
  theme_key?: string;
  title?: string;
  project_id?: string | null;
  /** Stable preset slide key -> named slot -> replacement content. */
  content?: Record<string, Record<string, PresetSlotValue>>;
}

/**
 * A template composed exactly as creating it would, returned and never stored
 * (UI audit 2026-10-10, unit 2). "cover" is the first slide, for a gallery card;
 * "all" is every slide, for the detail drawer.
 */
export interface TemplatePreviewRequest {
  theme_key?: string;
  content?: Record<string, Record<string, PresetSlotValue>>;
  slides?: "cover" | "all";
}

export interface TemplatePreviewResult {
  template_id: string;
  /** Which catalog composed it; part of every cache key that holds one. */
  catalog_revision: string;
  language_version: number | null;
  slides: "cover" | "all";
  /** For drawing only: no presentation or version id, because nothing is stored. */
  document: PresentationDocument;
}

export interface DeckComposeRequest {
  story_plan: StoryPlanInput;
  /** Absent means the language's own theme, or the neutral default. */
  theme_key?: string;
  /** The grammar to compose in (UI audit unit 7b). Absent is neutral. */
  design_language?: string;
  project_id?: string | null;
}

export interface ComposedDeckResult {
  presentation_id: string;
  version_id: string;
  document: PresentationDocument;
  template_id?: string | null;
  /** What composing changed or noticed, such as bullets past a language's limit. */
  warnings?: string[];
}

/** Add one reviewed pattern without exposing layout geometry to the caller. */
export interface InsertPatternRequest {
  expected_version_id: string;
  pattern: SlidePattern;
  slots?: Record<string, PresetSlotValue>;
  after_slide_id?: string;
  intent?: string;
  client_label?: string;
  /** Return the editor-ready operation without creating a server proposal. */
  dry_run?: boolean;
}

/**
 * Every slide pattern's example, composed in one design language: what the Add
 * library draws as each pattern's tile. Read-only; the editor draws each slide
 * in the deck's own theme.
 */
/**
 * An art direction's palette and faces (POST /presentations/{id}/theme). Every
 * other colour role is derived; text below WCAG AA is refused.
 */
export interface ThemeProposalRequest {
  expected_version_id: string;
  name?: string;
  background: string;
  foreground: string;
  accent: string;
  secondary?: string;
  series?: string[];
  display_font?: string;
  body_font?: string;
  intent?: string;
  client_label?: string;
  dry_run?: boolean;
}

export interface ThemeProposalResult {
  outcome: string;
  risk_tier?: string;
  transaction_id?: string;
  version_id?: string | null;
  text_contrast: number;
  accent_contrast: number;
  notes: string[];
}

export interface PatternPreviews {
  language: string;
  /** Changes when the catalog does, so a cached answer is never an old one. */
  revision: string;
  slides: Record<string, unknown>;
}

export interface InsertPatternResult {
  outcome: string;
  risk_tier?: string;
  reasons?: string[];
  transaction_id?: string | null;
  version_id?: string | null;
  expires_at?: string | null;
  slide_id: string;
  pattern: SlidePattern;
  warnings: string[];
  operations?: PatchOperation[];
}
