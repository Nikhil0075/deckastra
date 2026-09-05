# Product Requirements & User Journey Model

**Product name:** Deckastra  
**Document type:** Product Requirements Document (PRD)  
**Status:** Foundation / Draft v1.1  
**Supersedes:** Draft v1.0 (working name "DeckOS")  
**Primary audience:** Founders, product managers, designers, frontend engineers, AI engineers, platform engineers  
**Related documents:**  
- `02_MYDECK_PRESENTATION_SCHEMA.md`
- `03_AGENT_ARCHITECTURE_LANGGRAPH.md`
- `04_CANVAS_RENDERING_ANIMATION_ENGINE.md`
- `05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md`

---

## 1. Executive Summary

Deckastra is an AI-native presentation creation platform for web and desktop that combines:

- a free-form visual editor,
- structured slide semantics,
- agentic content and design workflows,
- programmable layouts,
- professional motion and transitions,
- GitHub-connected technical understanding,
- versioned AI changes,
- presentation-as-code capabilities,
- and multi-format export.

The product should not be positioned as another “prompt-to-slides” generator. Its long-term category is closer to a **creative IDE for presentations**.

The core product thesis is:

> **AI proposes. Deterministic engines compose. Humans remain in control.**

Deckastra should allow a user to move fluidly between natural-language instructions, direct manipulation, motion editing, code-level customization, and connected data sources without forcing the user into a fixed template workflow.

---

## 2. Product Vision

### 2.1 Vision statement

Create the next-generation presentation environment where ideas, code, data, documents, and brand systems can be transformed into expressive presentations through a collaboration between humans and specialized AI agents.

### 2.2 Long-term product definition

Deckastra should eventually feel like a combination of:

- PowerPoint for presentation semantics,
- Figma for direct visual manipulation,
- After Effects for motion,
- GitHub for versioning and branching,
- a code editor for programmable creativity,
- and an agentic AI workspace for research, planning, design, and revision.

Deckastra must remain a presentation product first. It should not become a generic design canvas with presentation support added later.

---

## 3. Problem Statement

Current presentation workflows have several recurring limitations:

1. **Prompt-generated decks are visually constrained.**  
   AI tools often produce acceptable but repetitive template-based layouts.

2. **AI editing is too destructive.**  
   “Make this more minimal” may regenerate an entire slide instead of changing only the intended properties.

3. **Animation is secondary.**  
   Most AI presentation tools treat motion as a preset layer rather than a first-class part of the presentation model.

4. **Technical content is poorly understood.**  
   Presentations about software systems often require manual interpretation of repositories, architecture, APIs, data flows, and code.

5. **Presentations are difficult to version.**  
   PowerPoint-style file duplication creates `final_v2_revised_latest.pptx` workflows rather than meaningful version history.

6. **Design intent is not machine-readable.**  
   A normal slide file contains geometry, but often lacks semantic information such as “this is the headline,” “this diagram explains the system boundary,” or “this number is the key KPI.”

7. **Human and AI editing are not equal citizens.**  
   AI often sits beside the editor rather than operating on the same structured document model.

Deckastra is designed to address these limitations through a structured presentation engine and controlled agent transaction model.

---

## 4. Product Principles

### 4.1 Structured, not image-based

A generated slide must remain editable at object level. Text, charts, diagrams, groups, media, and animations should remain structured objects.

### 4.2 AI must make reversible changes

Every AI operation should be represented as an explicit transaction that can be reviewed, reverted, or partially accepted.

### 4.3 Human editing is always available

The user must never be forced to prompt the AI for basic actions such as moving, resizing, formatting, grouping, or animating an object.

### 4.4 Semantic presentation model

Objects should carry semantic roles and intent in addition to visual properties.

### 4.5 Deterministic rendering

LLMs should decide intent and generate structured proposals; the rendering, layout validation, collision detection, and export pipeline should be deterministic.

### 4.6 Progressive complexity

A new user should be able to create a deck quickly, while an advanced user should be able to access timelines, constraints, code, components, and version branches.

### 4.7 Web-native first, export-compatible second

The Deckastra internal format should be more expressive than PPTX. PPTX is an export target, not the source of truth.

### 4.8 Source-aware generation

If a deck is generated from files, GitHub, or data, the system should preserve provenance so the user can inspect where content came from.

---

## 5. Target Users

### 5.1 Primary initial user: Developer / Technical Team

**Jobs to be done**
- Explain a software repository.
- Present system architecture.
- Produce demo slides.
- Create incident or workflow diagrams.
- Turn engineering documentation into an understandable story.
- Build animated product/architecture walkthroughs.

**Why this segment is attractive**
- GitHub integration creates clear differentiation.
- Technical users value version control and inspectability.
- Presentation-as-code is familiar.
- Technical architecture diagrams and demos benefit strongly from intelligent animation.

### 5.2 Secondary user: Founder / Startup Team

**Jobs to be done**
- Create investor decks.
- Produce product launch decks.
- Prepare customer demos.
- Reuse company content while changing story for different audiences.

### 5.3 Secondary user: Designer / Creative Professional

**Jobs to be done**
- Generate layout alternatives.
- Use AI without losing visual control.
- Create advanced motion.
- Build reusable components and brand systems.

### 5.4 Future user: Enterprise Business Team

**Jobs to be done**
- Produce recurring business reviews.
- Enforce corporate brand standards.
- Connect approved data sources.
- Maintain audit trails and approval policies.

---

## 6. Core Product Modes

The product should expose five primary modes.

### 6.1 Design Mode

Purpose: direct manipulation.

Core functions:
- select,
- move,
- resize,
- rotate,
- align,
- distribute,
- group,
- lock,
- hide,
- style,
- crop,
- reorder,
- edit text,
- edit chart,
- edit diagram.

### 6.2 AI Mode

Purpose: natural-language and agentic control.

Examples:
- “Make slide 6 more executive-friendly.”
- “Convert these four bullets into an architecture diagram.”
- “Use a more cinematic layout but keep all text.”
- “Create three alternatives without changing the content.”
- “Explain this GitHub repository in eight slides.”

### 6.3 Motion Mode

Purpose: edit slide-level and element-level animation.

Core functions:
- timeline,
- tracks,
- keyframes,
- delays,
- durations,
- easing,
- entrances,
- emphasis,
- exits,
- shared-element transitions.

### 6.4 Code Mode

Purpose: advanced programmatic editing and extension.

Possible capabilities:
- inspect presentation JSON,
- author reusable components,
- create data-driven slide blocks,
- use presentation APIs,
- define custom motion sequences.

This mode should be optional in V1 and can initially be read-only or limited.

### 6.5 Present Mode

Purpose: run the deck.

Core capabilities:
- full screen,
- presenter view,
- notes,
- timer,
- keyboard navigation,
- remote control later,
- interactive click/hover actions later.

---

## 7. Primary User Journeys

## 7.1 Journey A — Create from Prompt

### Goal

A user turns an idea into an editable, presentation-ready deck.

### Flow

1. User creates a new project.
2. User enters:
   - topic,
   - audience,
   - purpose,
   - approximate duration or slide count,
   - optional style preference.
3. Orchestrator interprets intent.
4. Story Agent creates a proposed narrative.
5. User reviews and optionally edits the narrative.
6. Creative Director proposes a visual direction.
7. User accepts or changes the visual direction.
8. Layout Agent generates slide compositions.
9. Motion Agent optionally creates motion.
10. Critic Agent evaluates the result.
11. User lands in the editor.
12. User manually edits or gives follow-up AI instructions.
13. User presents or exports.

### Success criteria

- User can reach a presentable first draft in one session.
- Every generated element is editable.
- AI does not overwrite user changes without an explicit transaction.
- Story and design can be changed independently.

---

## 7.2 Journey B — Create from GitHub

### Goal

A technical user turns a repository into an architecture or product presentation.

### Flow

1. User connects GitHub using a GitHub App.
2. User chooses one or more repositories.
3. User selects repository scope:
   - entire repository,
   - README + docs,
   - chosen directories/files.
4. Repository Agent extracts:
   - project purpose,
   - modules,
   - languages,
   - important files,
   - system boundaries,
   - interfaces,
   - APIs,
   - workflows,
   - diagrams,
   - relevant metrics.
5. User enters a goal:
   - technical deep dive,
   - executive summary,
   - demo presentation,
   - onboarding deck.
6. Story Agent creates a repository-grounded narrative.
7. Layout/Diagram agents generate technical visuals.
8. User edits.
9. Presentation can optionally be saved as a versioned project tied to the repository.

### Success criteria

- User can inspect which repository content informed each slide.
- Large repositories use staged retrieval rather than full-context ingestion.
- The GitHub App requests least-privilege permissions.
- Private source content is never exposed publicly.

---

## 7.3 Journey C — Contextual AI Editing

### Goal

AI modifies only the intended selection.

### Example flow

1. User selects a chart and title.
2. User asks: “Make this comparison easier to understand.”
3. System attaches selected object IDs to the agent request.
4. Agent returns a patch proposal.
5. Patch preview shows:
   - changed properties,
   - added elements,
   - deleted elements.
6. User accepts.
7. Transaction is applied.
8. User can undo only that AI transaction later.

### Requirement

The AI must receive selection context explicitly. It should never guess the intended target when a selection exists.

---

## 7.4 Journey D — Manual Creative Editing

The user should be able to create a complete presentation without AI.

Required:
- create blank slide,
- add text,
- draw shapes,
- insert images,
- add charts,
- add groups,
- adjust layer ordering,
- edit theme,
- animate,
- export.

This is important for product durability. AI should accelerate the editor, not replace it.

---

## 7.5 Journey E — Generate Design Variants

### Goal

Explore visual options without losing content.

1. User selects one or more slides.
2. User chooses “Generate variants.”
3. System freezes semantic content.
4. Design/Layout Agent generates alternatives.
5. User previews:
   - Editorial,
   - Cinematic,
   - Minimal,
   - Data-first,
   - Experimental.
6. User applies one variant.
7. Previous layout remains recoverable.

### Technical requirement

Content and layout must be separable in the document model.

---

## 7.6 Journey F — Version and Branch a Presentation

### Goal

Create alternate presentations without uncontrolled duplication.

1. User creates branch `investor-short`.
2. User or agent modifies selected slides.
3. Version engine records operations.
4. User compares branch against parent.
5. User can:
   - keep separate,
   - selectively copy slides,
   - merge accepted changes.

Git-style semantics should be adapted for non-technical users with simple visual language.

---

## 8. Functional Requirements

### 8.1 Project Management

MVP:
- create project,
- rename,
- duplicate,
- delete,
- recent projects,
- project metadata,
- basic version history.

Later:
- folders,
- organization workspaces,
- templates,
- team permissions.

### 8.2 Slide Management

MVP:
- create,
- duplicate,
- delete,
- reorder,
- hide,
- rename,
- copy/paste.

### 8.3 Element Editing

**The canonical element list is `02_MYDECK_PRESENTATION_SCHEMA.md` §37.1.** It is
not restated here.

v1.0 of this document and v1.0 of the schema disagreed — this document listed
`icon` as MVP where the schema omitted it, and `table` was absent here entirely
despite being defined in the schema and mapped for export in doc 04. That is one
decision recorded twice, which is one time too many. The schema owns it; this
section points at it.

For orientation only, the MVP set is: text, shape, line, image, icon, group,
chart, diagram, table, code. Component instances, video, audio and web embeds are
schema-defined now and implemented later, so decks authored today stay
forward-compatible.

### 8.4 Theme

MVP:
- color tokens,
- font families,
- type scale,
- spacing,
- background,
- default shape styles.

Later:
- motion grammar,
- chart grammar,
- image treatments,
- logo usage rules,
- brand constraints.

### 8.5 AI

MVP:
- create narrative,
- generate deck,
- rewrite selection,
- restyle selection,
- create diagram,
- generate layout variants,
- critique slide,
- basic repository analysis.

Later:
- autonomous presentation maintenance,
- organization memory,
- recurring data refresh,
- voice-assisted editing,
- marketplace skills.

### 8.6 Animation

MVP:
- entrance presets,
- emphasis presets,
- basic sequencing,
- delays,
- duration,
- easing,
- slide transition.

Later:
- full keyframe curves,
- camera movement,
- masks,
- path animation,
- advanced morph,
- particles,
- shader effects.

### 8.7 Export

MVP:
- browser presentation,
- PDF,
- PPTX.

Later:
- PNG/JPEG package,
- MP4,
- GIF,
- editable HTML package,
- embed code.

---

## 9. Non-Functional Requirements

### 9.1 Performance

"Quickly", "instantaneous" and "normal slide complexity" are not targets — nothing
can be measured against them and nothing can regress against them. The numbers
below are imported verbatim from `04_CANVAS_RENDERING_ANIMATION_ENGINE.md` §31.1
so that the PRD and the engineering document cannot disagree about the same
budget.

| Scenario | Budget |
| --- | --- |
| Typical slide (≤ 120 objects) first paint | < 250 ms |
| Heavy slide (300 objects) first paint | < 700 ms |
| Drag/resize frame time | < 16 ms p95, < 24 ms p99 |
| Slide switch (warm) | < 120 ms |
| Slide switch (cold, images to decode) | < 400 ms |
| Timeline scrub frame | < 16 ms |
| Thumbnail strip, 60 slides | < 1 s to first thumbnails, virtualized |
| Memory, 60-slide deck | < 600 MB tab RSS |

Every budget must be instrumented as a dashboard line (doc 04 §31.5). A budget
nobody plots is a budget that regresses quietly.

Also required, and not expressible as a single number:
- background agent work must never block direct manipulation.

### 9.2 Reliability

- autosave,
- crash recovery,
- deterministic serialization,
- schema migration support,
- transaction logs.

### 9.3 Security

- least privilege integrations,
- short-lived credentials where possible,
- secrets never stored in client code,
- repository content encrypted in transit and at rest,
- clear organization data boundaries.

### 9.4 Privacy

Users must understand:
- what content an agent reads,
- what is sent to model providers,
- what is retained,
- which sources are connected.

Enterprise mode should eventually support provider routing and data-retention policies.

### 9.5 Accessibility

**Target: WCAG 2.1 AA.**

In scope for MVP: colour contrast (enforced by theme contrast pairs, doc 02 §22.2
and rule W210), keyboard navigation, focus management, slide and image alt text,
and a reduced-motion playback path that every animation preset must declare.

Explicitly deferred, and stated so that "AA" is not read as a promise the product
does not yet keep: tagged-PDF export, and full screen-reader support for the
authoring surface as opposed to the presented output.

At minimum:
- keyboard navigation,
- focus management,
- color contrast warnings,
- slide alt-text support,
- reduced-motion playback option,
- screen-reader friendly editor controls where possible.

---

## 10. Product Information Architecture

Suggested application shell:

```text
Dashboard
├── Projects
├── Templates
├── Recent
├── Shared
└── Settings

Project
├── Editor
│   ├── Design
│   ├── AI
│   ├── Motion
│   └── Code
├── Present
├── Versions
├── Sources
├── Assets
└── Export
```

Suggested editor layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Project / Undo / Redo / Present / Share / Export / GitHub  │
├──────────────┬───────────────────────────────┬───────────────┤
│ Slide strip  │                               │ Inspector     │
│              │            Canvas             │ / AI panel    │
│              │                               │               │
├──────────────┴───────────────────────────────┴───────────────┤
│ Optional motion timeline                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 11. AI Interaction Model

### 11.1 Levels of AI scope

Every AI command should declare a scope:

- `selection`,
- `slide`,
- `slides`,
- `presentation`,
- `sources`,
- `theme`.

Example:

```json
{
  "scope": "selection",
  "targetIds": ["title-12", "chart-8"],
  "instruction": "Make this comparison clearer"
}
```

### 11.2 Proposal-before-apply

For destructive or broad changes, the AI should produce a proposed transaction that can be previewed.

Direct apply can be allowed for low-risk operations.

### 11.3 Explainability

For meaningful changes, the UI should be able to show:
- what changed,
- why,
- which agent changed it,
- confidence,
- source context used.

---

## 12. MVP Definition

The MVP is successful if a technical user can:

1. Sign in.
2. Create a presentation.
3. Connect a GitHub repository.
4. Ask for a technical presentation.
5. Review an AI-generated storyline.
6. Generate editable slides.
7. Manually move/edit objects.
8. Ask AI to modify a selected object or slide.
9. Add simple animations.
10. Present in the browser.
11. Export to PDF or PPTX.
12. Undo AI changes.

### Explicitly out of scope for MVP

- real-time multiplayer,
- full marketplace,
- advanced 3D,
- advanced video editing,
- mobile authoring,
- enterprise SSO,
- extensive offline mode,
- complex branch merging,
- full After Effects-level keyframes,
- arbitrary executable third-party plugins.

---

## 13. Product Metrics

### Activation
- percentage of new users who create a first deck,
- percentage who reach editor from prompt,
- percentage who connect GitHub in the technical segment.

### Creation quality
- percentage of generated slides kept without regeneration,
- average number of manual edits per generated slide,
- percentage of agent proposals accepted.

### Engagement
- weekly created decks,
- AI edits per active project,
- motion usage,
- export usage.

### Reliability
- failed agent runs,
- rendering failures,
- export failures,
- lost edit incidents.

### Differentiation indicators
- repository-to-deck conversion,
- agent transaction undo usage,
- design variant usage,
- animation timeline usage.

---

## 14. Risks and Mitigations

### Risk: Product becomes too broad

**Mitigation:**  
Start with technical presentations and a constrained feature set.

### Risk: AI generates inconsistent layouts

**Mitigation:**  
Use design tokens, layout constraints, deterministic validation, and Critic Agent scoring.

### Risk: Desktop and web diverge

**Mitigation:**  
Use a shared presentation core and renderer.

### Risk: PPTX export becomes a blocker

**Mitigation:**  
Treat PPTX as compatibility export. Keep web-native presentation as source of truth.

### Risk: GitHub scope feels niche

**Mitigation:**  
Use GitHub as the initial wedge, not the permanent product boundary.

### Risk: Users lose trust in AI editing

**Mitigation:**  
Transactions, previews, source context, AI-specific undo, and scoped operations.

---

## 15. Acceptance Criteria for Product Foundation

The product design is ready to enter implementation when:

- [ ] primary user segment is agreed,
- [ ] MVP scope is frozen,
- [ ] the structured presentation model can represent all MVP features,
- [ ] AI edit scopes are defined,
- [ ] agent transactions are specified,
- [ ] editor modes are agreed,
- [ ] GitHub onboarding flow is agreed,
- [ ] supported exports are agreed,
- [ ] performance targets are established,
- [ ] out-of-scope features are documented.

---

## 16. Product Decisions

Several of these were recorded as open while already being settled elsewhere in
the document set. A question that reads as open when it is not costs a reader real
time, so the resolved ones are closed here with their source.

### 16.1 Settled

| # | Question | Decision | Settled by |
| --- | --- | --- | --- |
| 1 | Final public product name | **Deckastra.** The working name DeckOS was dropped on domain availability. The `.mydeck` file extension, the schema package name and the `mydeck` type prefixes are unchanged — they are internal format identity, cross-referenced throughout the document set, and renaming them buys nothing. | This revision |
| 3 | Code Mode in MVP or V2 | Optional in V1, read-only or limited. | §6.4, which already said so |
| 4 | Motion on generated slides | Yes, on by default, restrained. | doc 04 §24 |
| 6 | Responsive vs fixed layouts | Fixed logical coordinates, 1920×1080 by default. | doc 04 §4 |

### 16.2 Genuinely open

| # | Question | Needed by |
| --- | --- | --- |
| 2 | Is GitHub optional during onboarding, or central to the first run? | Phase 6, and the onboarding work in Phase 9 |
| 5 | Does the user approve the story before slide generation by default? | Phase 5. Doc 03 §9 recommends yes for the new-deck flow; the default is worth measuring rather than assuming |
| 7 | Does team collaboration arrive before advanced motion? | Post-MVP sequencing |
| 8 | Are presentation branches user-facing in V1, or internal version history only? | Phase 2 exposes the model either way; this is a UI decision |

---

## 17. Recommended Product Positioning

### Category

**Agentic presentation studio**

### Initial wedge

**Technical teams and developers**

### Core message

> Turn ideas, code, and data into presentations that move.

### Product promise

> Create with AI without giving up control.
