/** Shared deck presets: data only, with no renderer or model dependency. */

import {
  PATTERN_DEFINITIONS,
  type DeckPreset,
  type MotionStyleId,
  type PurposeGroup,
  type SlidePattern,
} from "./schema";

export * from "./schema";
export * from "./quality";

/** The founding reviewed template in each purpose group, retained verbatim. */
const FOUNDATION_PRESETS: readonly DeckPreset[] = [
  {
    id: "business-pitch",
    name: "Sharp pitch",
    summary: "A concise case from problem to proof and next step.",
    purpose: "business",
    tags: ["pitch", "sales proposal", "investor"],
    themeKey: "quiet-luxury",
    motionStyle: "restrained",
    transitionStyle: "fade",
    voiceStyle: "confident",
    reviewed: true,
    slides: [
      { key: "opening", pattern: "title", purpose: "Frame the opportunity", slots: { eyebrow: "OPPORTUNITY", headline: "A clearer way forward", subtitle: "A focused proposal for the next stage" } },
      { key: "problem", pattern: "statement", purpose: "Name the costly problem", slots: { eyebrow: "THE PROBLEM", headline: "The current path creates more work than value", body: "Teams lose momentum when decisions, evidence and ownership live in separate places." } },
      { key: "approach", pattern: "bullets", purpose: "Explain the approach", slots: { eyebrow: "OUR APPROACH", headline: "Make the important work obvious", bullets: ["Start from the outcome", "Keep evidence beside each decision", "Measure progress in one shared view"] } },
      { key: "proof", pattern: "metrics", purpose: "Show credible proof", slots: { eyebrow: "EARLY PROOF", headline: "A practical change with visible leverage", metrics: [{ value: "3×", label: "faster alignment" }, { value: "42%", label: "less rework" }, { value: "2 wks", label: "to first value" }] } },
      { key: "close", pattern: "statement", purpose: "Ask for a decision", slots: { eyebrow: "NEXT STEP", headline: "Choose the first team and begin this month", body: "A small, measured pilot gives us the evidence to scale with confidence." } },
      { key: "agenda", pattern: "agenda", purpose: "Preview the decision path", slots: { eyebrow: "THE CONVERSATION", headline: "Three questions lead to a confident decision", bullets: ["What is changing?", "What evidence supports it?", "What do we do next?"] } },
      { key: "comparison", pattern: "pros-cons", purpose: "Contrast the options", slots: { eyebrow: "TRADE-OFFS", headline: "Focus creates more leverage than breadth", body: "Benefits: faster learning, visible ownership and a reversible decision.", bullets: ["Trade-off: narrower first scope", "Requires named measures", "Optimises confidence"] } },
      { key: "method", pattern: "process", purpose: "Make the pilot concrete", slots: { eyebrow: "THE PILOT", headline: "Learn in three controlled moves", bullets: ["Choose one real workflow", "Run with visible measures", "Review and decide"] } },
      { key: "roadmap", pattern: "roadmap", purpose: "Sequence the investment", slots: { eyebrow: "ROADMAP", headline: "Prove value before scaling", bullets: ["Month 1 — establish baseline", "Month 2 — run the pilot", "Month 3 — decide the rollout"] } },
      { key: "final-ask", pattern: "closing", purpose: "Leave one action", slots: { eyebrow: "THE ASK", headline: "Name the pilot team today", subtitle: "We can begin discovery this week" } },
    ],
  },
  {
    id: "product-launch",
    name: "Product launch",
    summary: "Reveal a product through customer tension, experience and impact.",
    purpose: "product",
    tags: ["launch", "roadmap", "release"],
    themeKey: "bento",
    motionStyle: "dynamic",
    transitionStyle: "push",
    voiceStyle: "bright",
    reviewed: true,
    slides: [
      { key: "opening", pattern: "title", purpose: "Introduce the product", slots: { eyebrow: "INTRODUCING", headline: "Built for the moment work becomes real", subtitle: "One experience from first idea to finished outcome" } },
      { key: "tension", pattern: "section", purpose: "Create customer tension", slots: { eyebrow: "WHY NOW", headline: "People have more tools—and less flow", subtitle: "The handoffs between thinking, making and sharing are where good ideas slow down." } },
      { key: "experience", pattern: "split", purpose: "Show the product experience", slots: { eyebrow: "THE EXPERIENCE", headline: "Move from intent to output without losing context", body: "A guided workspace keeps decisions, assets and delivery connected.", bullets: ["Start quickly", "Stay editable", "Ship confidently"] } },
      { key: "impact", pattern: "metrics", purpose: "Quantify value", slots: { eyebrow: "EXPECTED IMPACT", headline: "Less friction at every handoff", metrics: [{ value: "60%", label: "fewer manual steps" }, { value: "1", label: "shared source" }, { value: "24/7", label: "ready to build" }] } },
      { key: "availability", pattern: "statement", purpose: "Close with availability", slots: { eyebrow: "AVAILABLE NOW", headline: "Start with one real workflow", body: "Bring the work that matters and prove the value in days, not quarters." } },
      { key: "agenda", pattern: "agenda", purpose: "Preview the reveal", slots: { eyebrow: "THE REVEAL", headline: "See the problem, experience and impact", bullets: ["Why the old flow breaks", "How the new experience feels", "What changes for customers"] } },
      { key: "flow", pattern: "process", purpose: "Explain the product flow", slots: { eyebrow: "HOW IT WORKS", headline: "One continuous path replaces the handoffs", bullets: ["Capture intent", "Compose in context", "Review and ship"] } },
      { key: "hero-metric", pattern: "big-number", purpose: "Make the primary outcome memorable", slots: { eyebrow: "THE OUTCOME", headline: "Less work disappears between tools", metrics: [{ value: "60%", label: "fewer manual handoffs" }], caption: "Target for the first customer cohort" } },
      { key: "roadmap", pattern: "roadmap", purpose: "Show what comes next", slots: { eyebrow: "WHAT'S NEXT", headline: "Expand from the core experience", bullets: ["Now — connected authoring", "Next — richer delivery", "Later — scaled templates"] } },
      { key: "final-invite", pattern: "closing", purpose: "Invite adoption", slots: { eyebrow: "TRY IT", headline: "Bring one real project", subtitle: "The fastest way to understand the change is to use it" } },
    ],
  },
  {
    id: "teaching-workshop",
    name: "Hands-on workshop",
    summary: "Teach one idea, demonstrate it, then turn it into practice.",
    purpose: "teaching",
    tags: ["lesson", "workshop", "training"],
    themeKey: "playful-pastel",
    motionStyle: "playful",
    transitionStyle: "fade",
    voiceStyle: "warm",
    reviewed: true,
    slides: [
      { key: "opening", pattern: "title", purpose: "Set the learning goal", slots: { eyebrow: "WORKSHOP", headline: "Learn it by making it", subtitle: "A practical session with one useful outcome" } },
      { key: "goal", pattern: "statement", purpose: "State the learning outcome", slots: { eyebrow: "BY THE END", headline: "You will be able to explain and apply the core idea", body: "We will build from a simple mental model into a repeatable practice." } },
      { key: "model", pattern: "bullets", purpose: "Teach the mental model", slots: { eyebrow: "THE MODEL", headline: "Three moves make the method work", bullets: ["Observe what is actually happening", "Choose the smallest useful intervention", "Check the result and adapt"] } },
      { key: "practice", pattern: "split", purpose: "Prompt practice", slots: { eyebrow: "TRY IT", headline: "Apply the model to a real situation", body: "Work in pairs. Pick one current challenge and make the next move concrete.", bullets: ["Name the evidence", "Choose one action", "Define a signal"] } },
      { key: "recap", pattern: "quote", purpose: "Leave a memorable principle", slots: { eyebrow: "REMEMBER", headline: "Practice beats recall", quote: "A useful idea becomes knowledge when you can use it.", attribution: "Workshop principle" } },
      { key: "agenda", pattern: "agenda", purpose: "Set expectations", slots: { eyebrow: "TODAY", headline: "Learn, try and reflect", bullets: ["Build the mental model", "Apply it to a real case", "Choose a next practice"] } },
      { key: "demonstration", pattern: "process", purpose: "Demonstrate the method", slots: { eyebrow: "DEMO", headline: "Watch the method in three moves", bullets: ["Notice the evidence", "Choose the intervention", "Check the signal"] } },
      { key: "readiness", pattern: "checklist", purpose: "Check understanding", slots: { eyebrow: "YOU'RE READY WHEN", headline: "You can use the method without the slide", bullets: ["You can name the evidence", "You can choose one action", "You can define the signal"] } },
      { key: "practice-number", pattern: "big-number", purpose: "Make practice commitment concrete", slots: { eyebrow: "YOUR COMMITMENT", headline: "Use the method once this week", metrics: [{ value: "1×", label: "real situation" }], caption: "Small repetition makes the model available under pressure" } },
      { key: "close", pattern: "closing", purpose: "End with action", slots: { eyebrow: "NEXT", headline: "Take the method back to real work", subtitle: "Choose the situation before you leave" } },
    ],
  },
  {
    id: "technical-architecture",
    name: "Architecture review",
    summary: "A decision-ready technical narrative with constraints and trade-offs.",
    purpose: "technical",
    tags: ["architecture", "incident", "research"],
    themeKey: "neo-technical",
    motionStyle: "restrained",
    transitionStyle: "cut",
    voiceStyle: "direct",
    reviewed: true,
    slides: [
      { key: "opening", pattern: "title", purpose: "Name the decision", slots: { eyebrow: "ARCHITECTURE REVIEW", headline: "A simpler system boundary", subtitle: "Decision, evidence and migration path" } },
      { key: "constraints", pattern: "bullets", purpose: "Make constraints explicit", slots: { eyebrow: "CONSTRAINTS", headline: "The design must hold under real operating conditions", bullets: ["Predictable failure modes", "Observable ownership", "Incremental migration", "No silent data loss"] } },
      { key: "proposal", pattern: "code", purpose: "Explain the proposed contract", slots: { eyebrow: "PROPOSAL", headline: "Make the execution boundary explicit", code: "result = execute(versioned_input)\nassert result.outcome is not None", language: "python", caption: "Coordination owns the version; execution returns an explicit outcome." } },
      { key: "evidence", pattern: "metrics", purpose: "Show measured evidence", slots: { eyebrow: "EVIDENCE", headline: "The shape meets the operating target", metrics: [{ value: "99.95%", label: "availability" }, { value: "<2 min", label: "recovery" }, { value: "0", label: "silent drops" }] } },
      { key: "decision", pattern: "decision", purpose: "Record the decision", slots: { eyebrow: "DECISION", headline: "Approve the boundary; stage the migration", body: "Ship the adapter first, compare both paths, then retire the legacy writer." } },
      { key: "agenda", pattern: "agenda", purpose: "Frame the review", slots: { eyebrow: "REVIEW PATH", headline: "Constraints, proposal, evidence and decision", bullets: ["Name the operating constraints", "Inspect the proposed boundary", "Choose the migration path"] } },
      { key: "tradeoffs", pattern: "comparison", purpose: "Show the trade-off", slots: { eyebrow: "TRADE-OFF", headline: "Explicit coordination reduces hidden coupling", body: "The current writer combines orchestration and execution in one failure domain.", bullets: ["Versioned contract", "Isolated retries", "Observable outcomes"] } },
      { key: "migration", pattern: "process", purpose: "Explain the migration", slots: { eyebrow: "MIGRATION", headline: "Move traffic without a flag day", bullets: ["Ship the adapter", "Compare both paths", "Retire the legacy writer"] } },
      { key: "roadmap", pattern: "roadmap", purpose: "Sequence implementation", slots: { eyebrow: "DELIVERY", headline: "Each stage leaves the system safer", bullets: ["Stage 1 — read compatibility", "Stage 2 — dual write and compare", "Stage 3 — cut over and remove"] } },
      { key: "close", pattern: "closing", purpose: "Close the review", slots: { eyebrow: "APPROVAL", headline: "Approve the boundary", subtitle: "Begin with the adapter and measured comparison" } },
    ],
  },
  {
    id: "team-all-hands",
    name: "All-hands update",
    summary: "Connect progress, people and the next shared focus.",
    purpose: "team",
    tags: ["all-hands", "onboarding", "retrospective"],
    themeKey: "flat",
    motionStyle: "dynamic",
    transitionStyle: "fade",
    voiceStyle: "inclusive",
    reviewed: true,
    slides: [
      { key: "opening", pattern: "title", purpose: "Welcome the team", slots: { eyebrow: "TEAM UPDATE", headline: "What we learned—and where we go next", subtitle: "Progress, recognition and the next shared focus" } },
      { key: "wins", pattern: "metrics", purpose: "Celebrate progress", slots: { eyebrow: "PROGRESS", headline: "The work is moving in the right direction", metrics: [{ value: "12", label: "customer wins" }, { value: "4", label: "milestones shipped" }, { value: "93%", label: "team confidence" }] } },
      { key: "learning", pattern: "quote", purpose: "Share a lesson", slots: { eyebrow: "WHAT WE LEARNED", headline: "Focus compounds", quote: "The clearest priority made the strongest work easier to see.", attribution: "Quarterly retrospective" } },
      { key: "focus", pattern: "bullets", purpose: "Align the next focus", slots: { eyebrow: "NEXT", headline: "Three things deserve our attention", bullets: ["Finish the customer journey", "Remove the recurring bottleneck", "Share decisions earlier"] } },
      { key: "close", pattern: "statement", purpose: "End with shared intent", slots: { eyebrow: "THANK YOU", headline: "Keep the signal strong", body: "Clear priorities and generous collaboration will carry the next chapter." } },
      { key: "agenda", pattern: "agenda", purpose: "Orient the team", slots: { eyebrow: "TODAY", headline: "Celebrate, learn and focus", bullets: ["Recognise the progress", "Share what changed", "Align the next move"] } },
      { key: "spotlight", pattern: "profile", purpose: "Recognise a contributor", slots: { eyebrow: "TEAM SPOTLIGHT", headline: "Calm ownership made the difference", quote: "Share the rough version early enough for the team to help.", attribution: "Ari Patel · Customer operations" } },
      { key: "timeline", pattern: "timeline", purpose: "Connect the quarter", slots: { eyebrow: "THE QUARTER", headline: "Momentum came from a clear sequence", bullets: ["April — narrowed the journey", "May — removed the bottleneck", "June — shipped and learned"] } },
      { key: "readiness", pattern: "checklist", purpose: "Align on next-quarter readiness", slots: { eyebrow: "READY FOR NEXT", headline: "Three behaviours protect the focus", bullets: ["Surface decisions early", "Name the owner", "Close the feedback loop"] } },
      { key: "final-thanks", pattern: "closing", purpose: "Thank the team", slots: { eyebrow: "TOGETHER", headline: "Make the next chapter visible", subtitle: "Keep the priority clear and the collaboration generous" } },
    ],
  },
  {
    id: "personal-portfolio",
    name: "Portfolio story",
    summary: "Present your point of view through selected work and reflection.",
    purpose: "personal",
    tags: ["portfolio", "event", "story"],
    themeKey: "editorial-serif",
    motionStyle: "cinematic",
    transitionStyle: "fade",
    voiceStyle: "reflective",
    reviewed: true,
    slides: [
      { key: "opening", pattern: "title", purpose: "Introduce the point of view", slots: { eyebrow: "SELECTED WORK", headline: "Making complex things feel clear", subtitle: "A portfolio of systems, stories and useful details" } },
      { key: "belief", pattern: "quote", purpose: "State a creative belief", slots: { eyebrow: "POINT OF VIEW", headline: "What guides the work", quote: "Clarity is not reduction. It is choosing what deserves attention.", attribution: "Design principle" } },
      { key: "work", pattern: "split", purpose: "Present representative work", slots: { eyebrow: "CASE STUDY", headline: "From fragmented workflow to one calm path", body: "Research exposed the moment context was lost; the redesign made that handoff visible.", bullets: ["Research", "System design", "Measured rollout"] } },
      { key: "range", pattern: "bullets", purpose: "Show range", slots: { eyebrow: "CAPABILITIES", headline: "Strategy through finished detail", bullets: ["Product and service design", "Narrative and visual systems", "Prototyping and delivery"] } },
      { key: "close", pattern: "statement", purpose: "Invite a conversation", slots: { eyebrow: "LET'S TALK", headline: "The next good problem starts with a conversation", body: "Bring the ambiguity. We can make the path visible together." } },
      { key: "agenda", pattern: "agenda", purpose: "Preview the story", slots: { eyebrow: "THE STORY", headline: "Belief, work, range and reflection", bullets: ["What guides me", "How the work changed", "What I want to explore next"] } },
      { key: "case-study", pattern: "case-study", purpose: "Deepen the representative work", slots: { eyebrow: "CASE STUDY", headline: "The hidden handoff was the real design problem", body: "Research showed that people lost confidence when ownership changed invisibly.", bullets: ["Mapped the transition", "Made state visible", "Measured adoption"] } },
      { key: "process", pattern: "process", purpose: "Show the working method", slots: { eyebrow: "PROCESS", headline: "The work moves from ambiguity to evidence", bullets: ["Listen for the real tension", "Make the system tangible", "Refine through use"] } },
      { key: "profile", pattern: "profile", purpose: "Add a collaborator's perspective", slots: { eyebrow: "COLLABORATION", headline: "The work gets better in the open", quote: "The strongest detail came from making the unfinished system discussable.", attribution: "Project partner" } },
      { key: "final-invite", pattern: "closing", purpose: "End with an invitation", slots: { eyebrow: "NEXT", headline: "Let's make the complex feel clear", subtitle: "Bring the problem that still resists an easy answer" } },
    ],
  },
] as const;

type PresetBrief = {
  id: string;
  name: string;
  summary: string;
  purpose: PurposeGroup;
  tags: string[];
  themeKey: string;
  motionStyle: MotionStyleId;
  voiceStyle: string;
  headlines: readonly string[];
};

const PURPOSE_PATTERNS: Record<PurposeGroup, readonly SlidePattern[]> = {
  business: ["title", "executive-summary", "problem", "opportunity", "market", "financials", "risks", "roadmap", "recommendation", "closing"],
  product: ["title", "agenda", "problem", "feature-grid", "user-journey", "demo", "feedback", "release-plan", "changelog", "closing"],
  teaching: ["title", "learning-objectives", "concept", "example", "process", "exercise", "quiz", "reflection", "resources", "thank-you"],
  technical: ["title", "architecture", "system-flow", "api-contract", "data-model", "benchmark", "incident", "root-cause", "decision", "appendix"],
  team: ["title", "team-update", "wins", "blockers", "responsibilities", "timeline", "retrospective", "shout-outs", "checklist", "closing"],
  personal: ["title", "biography", "story-beat", "gallery", "case-study", "profile", "event-schedule", "quote", "reflection", "thank-you"],
};

const makePreset = (brief: PresetBrief): DeckPreset => ({
  id: brief.id,
  name: brief.name,
  summary: brief.summary,
  purpose: brief.purpose,
  tags: brief.tags,
  themeKey: brief.themeKey,
  motionStyle: brief.motionStyle,
  transitionStyle: "fade",
  voiceStyle: brief.voiceStyle,
  reviewed: true,
  slides: PURPOSE_PATTERNS[brief.purpose].map((pattern, index) => ({
    key: `${pattern}-${index + 1}`,
    pattern,
    purpose: brief.headlines[index]!,
    slots: {
      ...PATTERN_DEFINITIONS[pattern].exampleSlots,
      eyebrow: `${brief.name.toUpperCase()} · ${String(index + 1).padStart(2, "0")}`,
      headline: brief.headlines[index]!,
    },
  })),
});

const EXPANDED_PRESET_BRIEFS: readonly PresetBrief[] = [
  { id: "investor-update", name: "Investor update", summary: "A measured update from market signal to capital priorities.", purpose: "business", tags: ["investor", "fundraising", "update"], themeKey: "midnight", motionStyle: "editorial", voiceStyle: "assured", headlines: ["Momentum is becoming durable", "The quarter in one page", "Growth still hides one constraint", "A focused wedge expands the opportunity", "The market is moving toward us", "Efficiency is improving with scale", "The risks are visible and bounded", "Capital follows the proof points", "Stay focused on repeatable growth", "Build the next chapter with discipline"] },
  { id: "quarterly-review", name: "Quarterly review", summary: "A crisp operating review with results, risks and next-quarter choices.", purpose: "business", tags: ["quarterly", "operations", "leadership"], themeKey: "civic", motionStyle: "restrained", voiceStyle: "direct", headlines: ["A quarter of sharper execution", "What leaders need to know", "The missed handoff slowed delivery", "Retention creates the next opening", "Demand is strongest in the core", "Margin improved without losing pace", "Two risks need active ownership", "The next quarter has three moves", "Protect focus and close the loop", "Leave with owners and dates"] },
  { id: "board-briefing", name: "Board briefing", summary: "Decision-ready board material with context, evidence and an explicit ask.", purpose: "business", tags: ["board", "governance", "decision"], themeKey: "quiet-luxury", motionStyle: "cinematic", voiceStyle: "executive", headlines: ["One decision unlocks the next stage", "The board brief at a glance", "Our operating model has reached its limit", "The alternative is now credible", "The category is consolidating", "The investment fits the plan", "Downside is controlled by milestones", "Stage the commitment around evidence", "Approve the first tranche", "Decide with confidence"] },
  { id: "product-roadmap", name: "Product roadmap", summary: "A customer-led roadmap connecting problems, bets and releases.", purpose: "product", tags: ["roadmap", "product", "strategy"], themeKey: "oceanic", motionStyle: "dynamic", voiceStyle: "optimistic", headlines: ["The roadmap follows customer friction", "The story in ten moves", "Teams lose context at the handoff", "Three capabilities restore continuity", "The journey becomes one calm path", "The prototype proves the interaction", "Customers value visibility first", "Release in learning-sized increments", "Every release closes a loop", "Align on the first bet"] },
  { id: "release-notes", name: "Release notes", summary: "Turn a product release into a clear story of change and value.", purpose: "product", tags: ["release", "launch", "changelog"], themeKey: "high-contrast", motionStyle: "energetic", voiceStyle: "bright", headlines: ["A faster way to finish the work", "What changed and why", "The old flow created repeat effort", "The release removes the busywork", "The shortest path is now obvious", "See the new flow in action", "Beta feedback shaped the details", "Rollout begins with the core teams", "Small fixes complete the experience", "Upgrade with confidence"] },
  { id: "customer-case-study", name: "Customer case study", summary: "A proof-led customer story from tension to measurable outcome.", purpose: "product", tags: ["customer", "case study", "proof"], themeKey: "forest", motionStyle: "editorial", voiceStyle: "credible", headlines: ["Clarity changed the pace of work", "The customer story at a glance", "Fragmented ownership delayed every launch", "A shared workspace changed the system", "The team found one continuous path", "The new workflow made progress visible", "Adoption grew through weekly feedback", "Rollout followed confident champions", "Iteration turned friction into habit", "Make the next success repeatable"] },
  { id: "lesson-plan", name: "Lesson plan", summary: "A paced lesson from objectives through practice and reflection.", purpose: "teaching", tags: ["lesson", "classroom", "education"], themeKey: "paper-ink", motionStyle: "restrained", voiceStyle: "encouraging", headlines: ["Learn to turn evidence into a claim", "By the end, you can explain and apply", "A strong claim connects cause and proof", "Watch the reasoning take shape", "Use three steps to test the idea", "Now build the argument yourself", "Check the logic before moving on", "Name what changed in your thinking", "Keep these references close", "Carry the method into your next problem"] },
  { id: "training-module", name: "Training module", summary: "A practical workplace module built around demonstration and practice.", purpose: "teaching", tags: ["training", "enablement", "workshop"], themeKey: "bento", motionStyle: "dynamic", voiceStyle: "supportive", headlines: ["Make every handoff explicit", "Know the standard and practise it", "Good ownership is visible", "See a clean handoff in context", "Follow the same reliable sequence", "Practise with a real scenario", "Choose the strongest response", "Reflect on the moment of uncertainty", "Use the checklist on the job", "Make the behaviour routine"] },
  { id: "thesis-defence", name: "Thesis defence", summary: "A rigorous academic argument with method, evidence and implications.", purpose: "teaching", tags: ["thesis", "research", "defence"], themeKey: "lavender", motionStyle: "editorial", voiceStyle: "scholarly", headlines: ["A new account of adaptive coordination", "The defence has four objectives", "Coordination emerges from visible constraints", "A field example reveals the mechanism", "The method separates signal from noise", "Test the model against the evidence", "The result survives the key challenge", "The limits clarify future research", "The evidence and methods remain open", "Thank you for examining the work"] },
  { id: "incident-review", name: "Incident review", summary: "A blameless technical review from architecture to corrective action.", purpose: "technical", tags: ["incident", "reliability", "postmortem"], themeKey: "neo-technical", motionStyle: "technical", voiceStyle: "calm", headlines: ["A retry storm saturated the write path", "Where the failure propagated", "The request path amplified pressure", "The contract allowed unbounded retries", "Hot partitions concentrated the load", "Latency exposed the threshold", "The incident unfolded in twelve minutes", "Three conditions combined at once", "Bound retries and isolate partitions", "Evidence, owners and follow-up"] },
  { id: "research-talk", name: "Research talk", summary: "A technical research narrative linking model, experiment and result.", purpose: "technical", tags: ["research", "conference", "technical"], themeKey: "blueprint", motionStyle: "editorial", voiceStyle: "precise", headlines: ["Constraint-aware planning improves stability", "The model has three cooperating layers", "Signals move through a bounded graph", "The API preserves experimental control", "The data model keeps provenance explicit", "Results improve across all workloads", "Failure cases reveal the boundary", "The cause is sensitivity to sparse input", "Adopt the model for high-variance tasks", "Methods and replication notes"] },
  { id: "system-design-review", name: "System design review", summary: "A decision-oriented architecture review with contracts and trade-offs.", purpose: "technical", tags: ["architecture", "system design", "review"], themeKey: "midnight", motionStyle: "technical", voiceStyle: "analytical", headlines: ["Separate authoring from deterministic rendering", "The architecture has four bounded services", "Documents move through explicit stages", "Contracts keep each boundary testable", "The schema preserves editability", "The design meets the latency budget", "The main risk is queue contention", "Contention comes from shared scheduling", "Approve isolation by workload class", "Open questions and decision log"] },
  { id: "onboarding", name: "Team onboarding", summary: "A welcoming introduction to purpose, people and ways of working.", purpose: "team", tags: ["onboarding", "culture", "team"], themeKey: "playful-pastel", motionStyle: "playful", voiceStyle: "welcoming", headlines: ["Welcome to a team that makes clarity", "Here is how the team is moving", "These wins show what good looks like", "Ask early when context is missing", "Ownership is explicit and shared", "Your first month has a gentle rhythm", "We improve the system together", "Meet the people who unblock the work", "Keep this first-week checklist", "You belong in the conversation"] },
  { id: "retrospective", name: "Team retrospective", summary: "A candid review of wins, friction and concrete improvements.", purpose: "team", tags: ["retrospective", "agile", "improvement"], themeKey: "sunset", motionStyle: "dynamic", voiceStyle: "candid", headlines: ["The sprint taught us where flow breaks", "The team shipped meaningful progress", "Three wins deserve to be repeated", "Two blockers interrupted the rhythm", "Ownership worked when named early", "The sprint changed at the midpoint", "Keep the signal and change the system", "Recognition belongs close to the work", "Commit to three practical changes", "Start the next sprint with clarity"] },
  { id: "team-kickoff", name: "Team kickoff", summary: "An energising kickoff aligning mission, roles and first milestones.", purpose: "team", tags: ["kickoff", "project", "alignment"], themeKey: "flat", motionStyle: "energetic", voiceStyle: "energising", headlines: ["One team, one visible outcome", "The work begins from a shared signal", "Early momentum is already visible", "Name the constraints before they surprise us", "Every decision has one clear owner", "The first six weeks build the proof", "We will learn in the open", "Celebrate the behaviours that compound", "Leave with a ready-to-start checklist", "Make the first move today"] },
  { id: "event-story", name: "Event story", summary: "A cinematic event narrative with people, moments and a clear arc.", purpose: "personal", tags: ["event", "story", "celebration"], themeKey: "glassmorphism", motionStyle: "cinematic", voiceStyle: "warm", headlines: ["A day made from shared moments", "How this gathering came to life", "The story began with a simple invitation", "Small details made the atmosphere", "One turning point brought everyone together", "The people gave the day its meaning", "The rhythm carried us from welcome to celebration", "A few words captured the feeling", "We leave with something worth keeping", "Thank you for being part of the story"] },
  { id: "wedding-story", name: "Wedding story", summary: "An elegant personal story for ceremonies, dinners and keepsakes.", purpose: "personal", tags: ["wedding", "ceremony", "memories"], themeKey: "quiet-luxury", motionStyle: "cinematic", voiceStyle: "tender", headlines: ["Two lives, one generous promise", "The paths that led here", "Their story grew through ordinary days", "A gallery of the moments between", "One journey changed the shape of home", "The people beside them made it possible", "Tonight unfolds in four chapters", "Love is attention, given daily", "Carry the joy into the years ahead", "Thank you for celebrating with us"] },
  { id: "personal-narrative", name: "Personal narrative", summary: "A reflective life or career story told through decisive moments.", purpose: "personal", tags: ["biography", "career", "storytelling"], themeKey: "editorial-serif", motionStyle: "editorial", voiceStyle: "reflective", headlines: ["The work began with a question", "A few moments shaped the direction", "Curiosity became a way of moving", "The archive reveals a consistent thread", "One project changed the ambition", "Mentors made the possibility visible", "The next chapter has its own rhythm", "The clearest lesson is to stay open", "Reflection turns experience into choice", "Thank you for listening"] },
] as const;

export const DECK_PRESETS: readonly DeckPreset[] = [
  ...FOUNDATION_PRESETS,
  ...EXPANDED_PRESET_BRIEFS.map(makePreset),
];

export function findDeckPreset(id: string): DeckPreset | undefined {
  return DECK_PRESETS.find((preset) => preset.id === id && preset.reviewed);
}
