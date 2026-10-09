import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";

export type PurposeGroup = "business" | "product" | "teaching" | "technical" | "team" | "personal";
export type BaseSlidePattern = "title" | "statement" | "bullets" | "metrics" | "quote" | "code" | "split";
export type SlidePattern = BaseSlidePattern
  | "agenda" | "section" | "comparison" | "process" | "timeline" | "roadmap" | "checklist" | "pros-cons" | "big-number" | "profile" | "case-study" | "decision" | "closing"
  | "executive-summary" | "problem" | "opportunity" | "market" | "financials" | "risks" | "recommendation" | "appendix"
  | "feature-grid" | "user-journey" | "release-plan" | "pricing" | "feedback" | "demo" | "changelog"
  | "learning-objectives" | "concept" | "example" | "exercise" | "quiz" | "reflection" | "resources"
  | "architecture" | "system-flow" | "api-contract" | "data-model" | "incident" | "root-cause" | "benchmark"
  | "team-update" | "wins" | "blockers" | "responsibilities" | "retrospective" | "shout-outs"
  | "gallery" | "biography" | "event-schedule" | "story-beat" | "thank-you";
export type PresetSlotValue = string | string[] | Array<{ value: string; label: string }>;
export type PresetSlotKind = "text" | "text-list" | "metrics";
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
  composerLayout: BaseSlidePattern;
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
}

export interface StoryMetric {
  value: string;
  label: string;
}

export interface StoryPlanSlide {
  layout: SlidePattern;
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

export interface DeckComposeRequest {
  story_plan: StoryPlanInput;
  theme_key?: string;
  project_id?: string | null;
}

export interface ComposedDeckResult {
  presentation_id: string;
  version_id: string;
  document: PresentationDocument;
  template_id?: string | null;
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
