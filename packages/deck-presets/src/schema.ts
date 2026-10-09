/** The author-facing schema for deterministic slide patterns. */

export const PURPOSE_GROUPS = ["business", "product", "teaching", "technical", "team", "personal"] as const;
export type PurposeGroup = (typeof PURPOSE_GROUPS)[number];

export const BASE_SLIDE_PATTERNS = ["title", "statement", "bullets", "metrics", "quote", "code", "split"] as const;
export type BaseSlidePattern = (typeof BASE_SLIDE_PATTERNS)[number];

export const SLIDE_PATTERNS = [
  ...BASE_SLIDE_PATTERNS,
  "agenda",
  "section",
  "comparison",
  "process",
  "timeline",
  "roadmap",
  "checklist",
  "pros-cons",
  "big-number",
  "profile",
  "case-study",
  "decision",
  "closing",
  "executive-summary",
  "problem",
  "opportunity",
  "market",
  "financials",
  "risks",
  "recommendation",
  "appendix",
  "feature-grid",
  "user-journey",
  "release-plan",
  "pricing",
  "feedback",
  "demo",
  "changelog",
  "learning-objectives",
  "concept",
  "example",
  "exercise",
  "quiz",
  "reflection",
  "resources",
  "architecture",
  "system-flow",
  "api-contract",
  "data-model",
  "incident",
  "root-cause",
  "benchmark",
  "team-update",
  "wins",
  "blockers",
  "responsibilities",
  "retrospective",
  "shout-outs",
  "gallery",
  "biography",
  "event-schedule",
  "story-beat",
  "thank-you",
] as const;
export type SlidePattern = (typeof SLIDE_PATTERNS)[number];

export type MetricSlotValue = { value: string; label: string };
export type SlotValue = string | string[] | MetricSlotValue[];
export type SlotKind = "text" | "text-list" | "metrics";

export interface SlotDefinition {
  kind: SlotKind;
  label: string;
  description: string;
  required?: boolean;
  minItems?: number;
  maxItems?: number;
  recommendedMaxChars?: number;
  itemRecommendedMaxChars?: number;
}

export interface SlidePatternDefinition {
  name: string;
  summary: string;
  /** The deterministic geometry family used to compose this semantic pattern. */
  composerLayout: BaseSlidePattern;
  slots: Record<string, SlotDefinition>;
  /** At least one named slot in each group must contain content. */
  requiresOneOf?: string[][];
  exampleSlots: Record<string, SlotValue>;
}

const text = (
  label: string,
  description: string,
  options: Pick<SlotDefinition, "required" | "recommendedMaxChars"> = {},
): SlotDefinition => ({ kind: "text", label, description, ...options });

const common = {
  key_message: text("Key message", "The single claim this slide must communicate.", { recommendedMaxChars: 120 }),
  eyebrow: text("Eyebrow", "A short orienting label above the main content.", { recommendedMaxChars: 32 }),
  speaker_notes: text("Speaker notes", "Private delivery notes for the presenter."),
} satisfies Record<string, SlotDefinition>;

/**
 * Named content slots are the public authoring contract. They deliberately say
 * nothing about x/y coordinates: the deterministic composer owns geometry.
 */
export const PATTERN_DEFINITIONS: Record<SlidePattern, SlidePatternDefinition> = {
  title: {
    name: "Title",
    summary: "A calm opening with one promise and an optional supporting line.",
    composerLayout: "title",
    slots: {
      ...common,
      headline: text("Headline", "The deck's opening promise.", { required: true, recommendedMaxChars: 90 }),
      subtitle: text("Subtitle", "Audience, occasion or supporting context.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "OPENING", headline: "Make the important work visible", subtitle: "A practical path from intent to outcome" },
  },
  statement: {
    name: "Statement",
    summary: "One decisive claim with optional context.",
    composerLayout: "statement",
    slots: {
      ...common,
      headline: text("Headline", "The claim the audience should remember.", { required: true, recommendedMaxChars: 120 }),
      subtitle: text("Subtitle", "A short clarification below the claim.", { recommendedMaxChars: 140 }),
      body: text("Body", "Supporting context retained for authoring and narration.", { recommendedMaxChars: 240 }),
    },
    exampleSlots: { eyebrow: "DECISION", headline: "Choose the smallest useful next step", body: "A bounded pilot gives the team evidence without hiding the trade-offs." },
  },
  bullets: {
    name: "Bullets",
    summary: "A claim followed by a short, scannable sequence.",
    composerLayout: "bullets",
    slots: {
      ...common,
      headline: text("Headline", "The idea that gives the list meaning.", { required: true, recommendedMaxChars: 100 }),
      subtitle: text("Subtitle", "Optional framing for the list.", { recommendedMaxChars: 120 }),
      bullets: { kind: "text-list", label: "Bullets", description: "Two to six parallel points.", required: true, minItems: 2, maxItems: 6, itemRecommendedMaxChars: 90 },
      caption: text("Caption", "Optional source or qualifier.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "THE METHOD", headline: "Three moves keep the work honest", bullets: ["Start from evidence", "Make one bounded change", "Check the result"] },
  },
  metrics: {
    name: "Metrics",
    summary: "One to four comparable measures in a responsive row.",
    composerLayout: "metrics",
    slots: {
      ...common,
      headline: text("Headline", "The conclusion the numbers support.", { required: true, recommendedMaxChars: 100 }),
      metrics: { kind: "metrics", label: "Metrics", description: "One to four value-and-label pairs.", required: true, minItems: 1, maxItems: 4, itemRecommendedMaxChars: 48 },
      caption: text("Caption", "Optional source or measurement note.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "PROOF", headline: "The change creates visible leverage", metrics: [{ value: "3×", label: "faster alignment" }, { value: "42%", label: "less rework" }, { value: "2 wks", label: "to first value" }] },
  },
  quote: {
    name: "Quote",
    summary: "A memorable quotation with an optional attribution.",
    composerLayout: "quote",
    slots: {
      ...common,
      headline: text("Headline", "An accessible label for the quotation.", { required: true, recommendedMaxChars: 80 }),
      quote: text("Quote", "The quotation without decorative quotation marks.", { required: true, recommendedMaxChars: 240 }),
      attribution: text("Attribution", "Speaker or source.", { recommendedMaxChars: 80 }),
    },
    exampleSlots: { eyebrow: "PRINCIPLE", headline: "What guides the work", quote: "Clarity begins with choosing what deserves attention.", attribution: "Design principle" },
  },
  code: {
    name: "Code",
    summary: "A focused code sample with language and caption metadata.",
    composerLayout: "code",
    slots: {
      ...common,
      headline: text("Headline", "What the sample demonstrates.", { required: true, recommendedMaxChars: 100 }),
      code: text("Code", "The literal code sample.", { required: true }),
      language: text("Language", "A syntax-highlighting language key.", { recommendedMaxChars: 24 }),
      caption: text("Caption", "Optional explanation or source.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "CONTRACT", headline: "Make outcomes explicit", code: "result = run(input)\nassert result.reviewed", language: "python", caption: "A narrow boundary keeps the decision inspectable." },
  },
  split: {
    name: "Split",
    summary: "A claim with two complementary columns.",
    composerLayout: "split",
    slots: {
      ...common,
      headline: text("Headline", "The relationship between both columns.", { required: true, recommendedMaxChars: 100 }),
      body: text("Body", "Narrative content for the left column.", { recommendedMaxChars: 280 }),
      bullets: { kind: "text-list", label: "Bullets", description: "Supporting points for the right column.", minItems: 1, maxItems: 5, itemRecommendedMaxChars: 80 },
      caption: text("Caption", "Optional source or qualifier.", { recommendedMaxChars: 120 }),
    },
    requiresOneOf: [["body", "bullets"]],
    exampleSlots: { eyebrow: "THE SHAPE", headline: "Separate coordination from execution", body: "A narrow contract keeps the critical path visible.", bullets: ["Versioned inputs", "Idempotent work", "Explicit outcomes"] },
  },
  agenda: listPattern("Agenda", "Orient the audience with the sequence ahead.", "TODAY", "Three questions guide the conversation", ["What changed?", "What did we learn?", "What happens next?"]),
  section: {
    name: "Section divider",
    summary: "Reset attention before a new chapter.",
    composerLayout: "title",
    slots: {
      ...common,
      headline: text("Headline", "The next chapter's central idea.", { required: true, recommendedMaxChars: 72 }),
      subtitle: text("Subtitle", "A short bridge from the previous chapter.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "CHAPTER TWO", headline: "From evidence to action", subtitle: "Turn what we learned into one committed move" },
  },
  comparison: splitPattern("Comparison", "Contrast a current state with a better alternative.", "BEFORE / AFTER", "Change the system, not the effort", "Today: context is scattered and handoffs are implicit.", ["Tomorrow: one source", "Visible ownership", "Reviewable decisions"]),
  process: listPattern("Process", "Explain an ordered method in a few memorable steps.", "HOW IT WORKS", "A simple path keeps quality high", ["Frame the outcome", "Compose from constraints", "Review before export"]),
  timeline: listPattern("Timeline", "Show a sequence of dated or staged events.", "TIMELINE", "Three stages move the work forward", ["Now — align the boundary", "Next — prove the workflow", "Then — scale what works"]),
  roadmap: listPattern("Roadmap", "Connect near-term delivery to later capability.", "ROADMAP", "Sequence value before breadth", ["Foundation — reliable creation", "Expansion — richer motion", "Scale — more reviewed presets"]),
  checklist: listPattern("Checklist", "Make readiness criteria explicit and scannable.", "READY WHEN", "The launch bar is concrete", ["The owner is named", "The failure path is tested", "The result is measurable"]),
  "pros-cons": splitPattern("Pros and cons", "Hold benefits and trade-offs in the same frame.", "TRADE-OFFS", "The simpler path wins on control", "Benefits: predictable, inspectable and reversible.", ["Trade-off: fewer free-form choices", "Requires reviewed patterns", "Optimises consistency"]),
  "big-number": {
    name: "Big number",
    summary: "Give one decisive metric the whole stage.",
    composerLayout: "metrics",
    slots: {
      ...common,
      headline: text("Headline", "The conclusion the number supports.", { required: true, recommendedMaxChars: 90 }),
      metrics: { kind: "metrics", label: "Metric", description: "Exactly one value-and-label pair.", required: true, minItems: 1, maxItems: 1, itemRecommendedMaxChars: 48 },
      caption: text("Caption", "Source or measurement note.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "THE RESULT", headline: "One change removed the recurring delay", metrics: [{ value: "62%", label: "faster cycle time" }], caption: "Measured across the first four teams" },
  },
  profile: {
    name: "Profile",
    summary: "Introduce a person through a point of view, not a résumé dump.",
    composerLayout: "quote",
    slots: {
      ...common,
      headline: text("Headline", "The person's role or contribution.", { required: true, recommendedMaxChars: 80 }),
      quote: text("Quote", "A short first-person point of view.", { required: true, recommendedMaxChars: 220 }),
      attribution: text("Attribution", "Name and role.", { required: true, recommendedMaxChars: 80 }),
    },
    exampleSlots: { eyebrow: "MEET THE TEAM", headline: "The operator behind the change", quote: "Make the safe path the easy path.", attribution: "Maya Chen · Platform lead" },
  },
  "case-study": splitPattern("Case study", "Connect a concrete challenge, intervention and result.", "CASE STUDY", "A visible handoff changed the outcome", "The team lost context whenever work moved between tools.", ["Mapped the failure point", "Designed one shared state", "Cut rework by 42%"]),
  decision: {
    name: "Decision",
    summary: "Record the choice, owner and immediate next move.",
    composerLayout: "statement",
    slots: {
      ...common,
      headline: text("Headline", "The decision in direct language.", { required: true, recommendedMaxChars: 110 }),
      subtitle: text("Subtitle", "Owner, timing or decision condition.", { recommendedMaxChars: 140 }),
      body: text("Body", "The reason and next action.", { recommendedMaxChars: 240 }),
    },
    exampleSlots: { eyebrow: "DECISION", headline: "Approve the boundary and stage the migration", subtitle: "Owner: Platform · Start: this month", body: "Ship the adapter first, compare both paths, then retire the legacy writer." },
  },
  closing: {
    name: "Closing",
    summary: "End with one memorable action or invitation.",
    composerLayout: "title",
    slots: {
      ...common,
      headline: text("Headline", "The final action or invitation.", { required: true, recommendedMaxChars: 90 }),
      subtitle: text("Subtitle", "A concise next step.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow: "NEXT STEP", headline: "Begin with one real workflow", subtitle: "Choose the team, name the measure and start this week" },
  },
  "executive-summary": listPattern("Executive summary", "Put the decision, evidence and ask on one scan.", "AT A GLANCE", "The decision is ready", ["The opportunity is clear", "The evidence is credible", "The next move is bounded"]),
  problem: statementPattern("Problem", "Name the audience's costly tension without diluting it.", "THE PROBLEM", "Important work stalls between disconnected decisions"),
  opportunity: statementPattern("Opportunity", "Frame the valuable change now within reach.", "THE OPPORTUNITY", "A shared operating view turns handoffs into momentum"),
  market: metricPattern("Market", "Make market scale and direction comparable.", "MARKET", "Demand is large and moving", [{ value: "$4.2B", label: "addressable market" }, { value: "18%", label: "annual growth" }, { value: "3", label: "priority segments" }]),
  financials: metricPattern("Financials", "Summarise financial performance with a clear conclusion.", "FINANCIALS", "Efficient growth is compounding", [{ value: "$12M", label: "annual revenue" }, { value: "72%", label: "gross margin" }, { value: "18 mo", label: "runway" }]),
  risks: listPattern("Risks", "Name material risks with direct mitigations.", "RISKS", "The main uncertainties are manageable", ["Adoption — stage the rollout", "Delivery — protect the critical path", "Cost — cap each experiment"]),
  recommendation: statementPattern("Recommendation", "State the advised choice and why it wins.", "RECOMMENDATION", "Approve the focused path and measure it weekly"),
  appendix: listPattern("Appendix", "Index supporting material without crowding the main story.", "APPENDIX", "Evidence behind the recommendation", ["Method and assumptions", "Detailed measures", "Source notes"]),
  "feature-grid": listPattern("Feature grid", "Group product capabilities around user value.", "CAPABILITIES", "Every feature removes a real handoff", ["Capture intent in context", "Compose from reviewed patterns", "Export without rebuilding"]),
  "user-journey": listPattern("User journey", "Follow a person through the key product moments.", "USER JOURNEY", "The path stays continuous", ["Arrive with a goal", "Build with guidance", "Share a finished result"]),
  "release-plan": listPattern("Release plan", "Sequence release scope and confidence checks.", "RELEASE PLAN", "Ship value in controlled increments", ["Pilot — prove the core", "Beta — widen the cohort", "Launch — scale support"]),
  pricing: splitPattern("Pricing", "Explain the offer and what each level unlocks.", "PRICING", "Start free and pay when the workflow scales", "Free: core creation and local export.", ["Pro: richer media", "Team: shared controls", "Enterprise: governance"]),
  feedback: quotePattern("Customer feedback", "Anchor the product story in a customer voice.", "CUSTOMER VOICE", "What changed for the user", "We stopped rebuilding the same story in three different tools.", "Pilot customer"),
  demo: codePattern("Demo", "Show a compact product or technical demonstration.", "LIVE DEMO", "One action produces a reviewable result", "const deck = await compose(brief);\nawait deck.export('mp4');"),
  changelog: listPattern("Changelog", "Summarise release changes by user impact.", "WHAT'S NEW", "This release removes the rough edges", ["Faster first draft", "Clearer review states", "More reliable exports"]),
  "learning-objectives": listPattern("Learning objectives", "State observable outcomes for the session.", "YOU WILL", "Three capabilities define success", ["Explain the core model", "Apply it to a real case", "Evaluate the result"]),
  concept: statementPattern("Concept", "Teach one foundational idea at a time.", "CORE IDEA", "Constraints turn vague intent into useful choices"),
  example: splitPattern("Worked example", "Place a concrete example beside the principle it demonstrates.", "EXAMPLE", "See the model in a real decision", "Principle: begin from observable evidence.", ["Context: a delayed launch", "Move: narrow the dependency", "Result: a testable path"]),
  exercise: listPattern("Exercise", "Give learners a bounded practice task.", "TRY IT", "Apply the model to your own work", ["Choose one current challenge", "Name the evidence", "Write the next action"]),
  quiz: listPattern("Knowledge check", "Test understanding with a concise prompt and options.", "QUICK CHECK", "Which move keeps the decision reversible?", ["A — expand the scope", "B — run a bounded pilot", "C — defer the measure"]),
  reflection: quotePattern("Reflection", "Pause for interpretation and personal transfer.", "REFLECT", "Make the lesson yours", "What would you change in your next real decision?", "Reflection prompt"),
  resources: listPattern("Resources", "Collect the references learners need after the session.", "KEEP LEARNING", "Continue with these resources", ["One-page field guide", "Worked example library", "Practice checklist"]),
  architecture: splitPattern("Architecture", "Explain a system boundary and its responsibilities.", "ARCHITECTURE", "Separate orchestration from deterministic execution", "The control plane owns intent and policy.", ["The engine owns layout", "The worker owns exports", "The schema owns the contract"]),
  "system-flow": listPattern("System flow", "Trace data through the important system stages.", "SYSTEM FLOW", "Data crosses four explicit boundaries", ["Validate input", "Resolve the scene", "Render deterministically", "Publish the artifact"]),
  "api-contract": codePattern("API contract", "Show the narrow request or response that joins systems.", "API CONTRACT", "The boundary is small and versioned", "POST /v1/exports\n{ \"kind\": \"mp4\", \"fps\": 30 }"),
  "data-model": codePattern("Data model", "Make the persisted relationship concrete.", "DATA MODEL", "The document remains the source of truth", "document -> slides -> elements\n         -> narration -> takes"),
  incident: listPattern("Incident timeline", "Reconstruct an incident in observable order.", "INCIDENT", "The failure propagated through three moments", ["09:12 — latency rises", "09:18 — retries amplify load", "09:27 — traffic is limited"]),
  "root-cause": splitPattern("Root cause", "Separate the triggering event from the systemic cause.", "ROOT CAUSE", "A missing bound turned retries into load", "Trigger: one dependency slowed unexpectedly.", ["No retry budget", "No admission control", "Alert followed symptoms"]),
  benchmark: metricPattern("Benchmark", "Compare performance against explicit budgets.", "BENCHMARK", "The critical path is inside budget", [{ value: "142ms", label: "p95 latency" }, { value: "0.2%", label: "error rate" }, { value: "410MB", label: "peak RSS" }]),
  "team-update": listPattern("Team update", "Summarise progress, learning and next focus.", "TEAM UPDATE", "Momentum is visible and focused", ["Shipped the core path", "Learned where users pause", "Next: simplify review"]),
  wins: metricPattern("Wins", "Celebrate outcomes with evidence.", "WINS", "The team's work changed the result", [{ value: "4", label: "milestones shipped" }, { value: "31%", label: "faster cycle" }, { value: "9.2", label: "team confidence" }]),
  blockers: listPattern("Blockers", "Make impediments, owners and actions visible.", "BLOCKERS", "Three constraints need decisions", ["Access — owner: Operations", "Scope — owner: Product", "Capacity — owner: Engineering"]),
  responsibilities: splitPattern("Responsibilities", "Clarify ownership across collaborating groups.", "OWNERSHIP", "One accountable owner, many contributors", "Product owns the outcome and priority.", ["Design owns the experience", "Engineering owns reliability", "Operations owns rollout"]),
  retrospective: splitPattern("Retrospective", "Hold what worked and what changes in one frame.", "RETROSPECTIVE", "Keep the focus; change the handoff", "Keep: small batches and visible measures.", ["Change: earlier review", "Stop: parallel sources", "Try: one decision log"]),
  "shout-outs": quotePattern("Shout-outs", "Recognise contribution through a specific impact.", "THANK YOU", "A contribution worth naming", "Rina made the failure path testable before it reached customers.", "The launch team"),
  gallery: splitPattern("Gallery", "Frame a body of visual work with a curatorial idea.", "SELECTED WORK", "Systems can feel both rigorous and human", "A collection of interfaces built around calm decisions.", ["Product systems", "Data stories", "Identity and motion"]),
  biography: quotePattern("Biography", "Introduce a person through their purpose and point of view.", "ABOUT", "Designing clarity into complex systems", "I turn complicated workflows into experiences people can trust.", "Independent product designer"),
  "event-schedule": listPattern("Event schedule", "Orient guests with an ordered programme.", "SCHEDULE", "A day designed to build connection", ["16:00 — welcome", "17:00 — ceremony", "18:30 — dinner and stories"]),
  "story-beat": statementPattern("Story beat", "Hold one emotional turn in a personal narrative.", "THEN EVERYTHING CHANGED", "The smallest decision opened the largest possibility"),
  "thank-you": titlePattern("Thank you", "Close a personal story with warmth and a clear invitation.", "WITH GRATITUDE", "Thank you for being part of the story", "The next chapter starts together"),
};

function listPattern(name: string, summary: string, eyebrow: string, headline: string, bullets: string[]): SlidePatternDefinition {
  return {
    name,
    summary,
    composerLayout: "bullets",
    slots: {
      ...common,
      headline: text("Headline", "The claim that gives the sequence meaning.", { required: true, recommendedMaxChars: 100 }),
      subtitle: text("Subtitle", "Optional framing for the sequence.", { recommendedMaxChars: 120 }),
      bullets: { kind: "text-list", label: "Items", description: "Two to six ordered, parallel items.", required: true, minItems: 2, maxItems: 6, itemRecommendedMaxChars: 90 },
      caption: text("Caption", "Optional source or qualifier.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow, headline, bullets },
  };
}

function splitPattern(name: string, summary: string, eyebrow: string, headline: string, body: string, bullets: string[]): SlidePatternDefinition {
  return {
    name,
    summary,
    composerLayout: "split",
    slots: {
      ...common,
      headline: text("Headline", "The relationship between both sides.", { required: true, recommendedMaxChars: 100 }),
      body: text("Left side", "Narrative content for the left column.", { required: true, recommendedMaxChars: 280 }),
      bullets: { kind: "text-list", label: "Right side", description: "One to five parallel points for the right column.", required: true, minItems: 1, maxItems: 5, itemRecommendedMaxChars: 80 },
      caption: text("Caption", "Optional source or qualifier.", { recommendedMaxChars: 120 }),
    },
    exampleSlots: { eyebrow, headline, body, bullets },
  };
}

function statementPattern(name: string, summary: string, eyebrow: string, headline: string): SlidePatternDefinition {
  return {
    name, summary, composerLayout: "statement",
    slots: { ...common, headline: text("Headline", "The claim to remember.", { required: true, recommendedMaxChars: 120 }), subtitle: text("Subtitle", "Optional clarification.", { recommendedMaxChars: 140 }), body: text("Body", "Supporting context.", { recommendedMaxChars: 240 }) },
    exampleSlots: { eyebrow, headline, body: "A concise explanation keeps the claim grounded and actionable." },
  };
}

function metricPattern(name: string, summary: string, eyebrow: string, headline: string, metrics: MetricSlotValue[]): SlidePatternDefinition {
  return {
    name, summary, composerLayout: "metrics",
    slots: { ...common, headline: text("Headline", "The conclusion supported by the measures.", { required: true, recommendedMaxChars: 100 }), metrics: { kind: "metrics", label: "Metrics", description: "One to four comparable measures.", required: true, minItems: 1, maxItems: 4, itemRecommendedMaxChars: 48 }, caption: text("Caption", "Source or qualifier.", { recommendedMaxChars: 120 }) },
    exampleSlots: { eyebrow, headline, metrics },
  };
}

function quotePattern(name: string, summary: string, eyebrow: string, headline: string, quote: string, attribution: string): SlidePatternDefinition {
  return {
    name, summary, composerLayout: "quote",
    slots: { ...common, headline: text("Headline", "An accessible label for the quotation.", { required: true, recommendedMaxChars: 80 }), quote: text("Quote", "The quotation or prompt.", { required: true, recommendedMaxChars: 240 }), attribution: text("Attribution", "Speaker, source or prompt type.", { recommendedMaxChars: 80 }) },
    exampleSlots: { eyebrow, headline, quote, attribution },
  };
}

function codePattern(name: string, summary: string, eyebrow: string, headline: string, code: string): SlidePatternDefinition {
  return {
    name, summary, composerLayout: "code",
    slots: { ...common, headline: text("Headline", "What the example demonstrates.", { required: true, recommendedMaxChars: 100 }), code: text("Code", "The literal sample.", { required: true }), language: text("Language", "Syntax language key.", { recommendedMaxChars: 24 }), caption: text("Caption", "Optional explanation.", { recommendedMaxChars: 120 }) },
    exampleSlots: { eyebrow, headline, code, language: "text", caption: "A compact example keeps the boundary inspectable." },
  };
}

function titlePattern(name: string, summary: string, eyebrow: string, headline: string, subtitle: string): SlidePatternDefinition {
  return {
    name, summary, composerLayout: "title",
    slots: { ...common, headline: text("Headline", "The central promise.", { required: true, recommendedMaxChars: 90 }), subtitle: text("Subtitle", "Supporting context.", { recommendedMaxChars: 120 }) },
    exampleSlots: { eyebrow, headline, subtitle },
  };
}

export const MOTION_STYLES = {
  restrained: {
    name: "Restrained",
    summary: "A measured fade that keeps reading first.",
    entrance: "fade",
    pacing: "measured",
    sequence: ["eyebrow", "headline", "subtitle", "body", "metric", "quote", "caption"],
    clickReveals: 0,
  },
  dynamic: {
    name: "Dynamic",
    summary: "A tight directional entrance with one optional reveal step.",
    entrance: "slide",
    pacing: "tight",
    sequence: ["headline", "subtitle", "body", "metric", "quote", "caption"],
    clickReveals: 1,
  },
  cinematic: {
    name: "Cinematic",
    summary: "A deliberate masked reveal for narrative moments.",
    entrance: "maskReveal",
    pacing: "deliberate",
    sequence: ["eyebrow", "headline", "quote", "subtitle", "body", "metric", "caption"],
    clickReveals: 0,
  },
  editorial: {
    name: "Editorial",
    summary: "A composed rise and fade with generous reading time.",
    entrance: "fade",
    pacing: "measured",
    sequence: ["eyebrow", "headline", "body", "quote", "caption", "metric"],
    clickReveals: 0,
  },
  energetic: {
    name: "Energetic",
    summary: "Fast staged entrances for launches, demos and team moments.",
    entrance: "springIn",
    pacing: "tight",
    sequence: ["headline", "metric", "body", "caption", "quote"],
    clickReveals: 2,
  },
  technical: {
    name: "Technical",
    summary: "Precise wipes that reveal systems in dependency order.",
    entrance: "maskReveal",
    pacing: "deliberate",
    sequence: ["eyebrow", "headline", "body", "metric", "caption"],
    clickReveals: 1,
  },
  playful: {
    name: "Playful",
    summary: "A buoyant word cascade for welcoming, educational and celebratory stories.",
    entrance: "wordCascade",
    pacing: "tight",
    sequence: ["eyebrow", "headline", "subtitle", "body", "quote", "caption"],
    clickReveals: 1,
  },
} as const;

export type MotionStyleId = keyof typeof MOTION_STYLES;

export interface PresetSlide {
  /** Stable address used by deck_from_template content overrides. */
  key: string;
  pattern: SlidePattern;
  purpose: string;
  slots: Record<string, SlotValue>;
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
  reviewed: boolean;
  slides: PresetSlide[];
}
