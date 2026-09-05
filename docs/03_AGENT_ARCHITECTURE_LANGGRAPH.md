# Agent Architecture & LangGraph State Model

**Document type:** AI system architecture specification  
**Status:** Foundation / Draft v1.0  
**Primary orchestration recommendation:** LangGraph  
**Purpose:** Define how AI agents reason about, generate, modify, critique, and version presentations.

---

## 1. Objective

Deckastra should use AI as a structured creative team rather than one general-purpose “presentation agent.”

The system must support:
- long-running workflows,
- persistent state,
- human checkpoints,
- tool calling,
- recoverable errors,
- streaming progress,
- scoped editing,
- transaction-based changes,
- source grounding,
- model/provider flexibility.

LangGraph is a suitable orchestration layer because the workflow is naturally represented as a graph with stateful stages and revision loops.

---

## 2. Design Principles

### 2.1 Agents produce structured outputs

No production agent should return arbitrary prose when the next system component expects machine-readable data.

### 2.2 Agents do not directly mutate the presentation store

Agents return:
- proposals,
- typed patches,
- tool calls.

A transaction service validates and applies changes.

### 2.3 Separate reasoning from deterministic computation

Use models for:
- intent,
- narrative,
- semantic grouping,
- design direction,
- motion intent,
- critique.

Use deterministic services for:
- geometry,
- collision detection,
- text measurement,
- constraints,
- ID validation,
- export,
- schema validation.

### 2.4 Preserve provenance

If an agent uses GitHub, a file, or a web source, the result should retain source references.

### 2.5 Human-in-the-loop is a product feature

Users should be able to approve:
- story,
- design direction,
- broad deck revisions,
- destructive changes.

### 2.6 Narrow agent responsibilities

Each agent should have one primary contract and measurable output.

---

## 3. Initial Agent Set

Recommended MVP agents:

1. Orchestrator Agent
2. Research / Repository Agent
3. Story Architect Agent
4. Creative Director Agent
5. Layout Agent
6. Motion Agent
7. Critic Agent

Optional helper services should not automatically become “agents.”

Examples:
- typography measurement service,
- chart renderer,
- constraint solver,
- source indexer.

---

## 4. High-Level Graph

```text
User Request
     |
     v
Orchestrator
     |
     +-----------------------------+
     |                             |
     v                             v
Source Analysis                User Context
     |                             |
     +-------------+---------------+
                   |
                   v
              Story Agent
                   |
             [Human Checkpoint]
                   |
                   v
          Creative Director
                   |
             [Optional Choice]
                   |
                   v
              Layout Agent
                   |
                   v
              Motion Agent
                   |
                   v
                Render
                   |
                   v
              Critic Agent
               /       \
            PASS       REVISE
             |            |
             v            +------> Layout/Story/Design/Motion
         Final Draft
             |
             v
            Editor
```

---

## 5. Shared LangGraph State

```py
class PresentationAgentState(TypedDict, total=False):
    run_id: str
    user_id: str
    project_id: str
    presentation_id: str

    request: UserPresentationRequest
    selected_scope: EditScope

    source_context: SourceContext
    research: ResearchResult
    repository_context: RepositoryContext

    story_plan: StoryPlan
    brand_dna: BrandDNA
    creative_direction: CreativeDirection

    current_document: PresentationDocument
    proposed_patches: list[PresentationPatch]

    layout_candidates: list[LayoutCandidate]
    motion_plan: MotionPlan
    critic_results: list[CriticResult]

    human_decisions: list[HumanDecision]
    agent_events: list[AgentEvent]

    current_stage: str
    revision_count: int
    warnings: list[str]
    errors: list[AgentError]
```

The state should store references to large artifacts rather than repeatedly duplicating full binary content.

---

## 6. User Request Model

```ts
interface UserPresentationRequest {
  instruction: string;
  audience?: string;
  objective?: string;
  durationSeconds?: number;
  targetSlideCount?: number;
  tone?: string;
  styleHints?: string[];
  sources?: SourceReference[];
  outputMode?: "newDeck" | "edit";
}
```

For edits:

```ts
interface EditScope {
  type: "selection" | "slide" | "slides" | "presentation" | "theme";
  targetIds?: string[];
}
```

---

## 7. Agent 1 — Orchestrator

### Responsibility

Convert user intent into an execution plan and route the graph.

### Inputs

- request,
- edit scope,
- current document,
- available sources,
- user/workspace policy.

### Outputs

```ts
interface OrchestrationPlan {
  taskType:
    | "generateDeck"
    | "editDeck"
    | "generateVariants"
    | "critique"
    | "animate"
    | "research";
  requiredAgents: string[];
  checkpoints: string[];
  constraints: string[];
}
```

### Responsibilities

- detect new deck vs edit,
- protect scope,
- decide whether research is needed,
- decide whether story generation is needed,
- route revision loops,
- stop loops after configured thresholds,
- escalate to user when uncertainty is material.

### Non-responsibilities

The Orchestrator should not:
- write slide copy,
- place objects,
- choose exact animations,
- inspect source code deeply.

---

## 8. Agent 2 — Research / Repository Agent

### Responsibility

Produce a grounded knowledge package for downstream agents.

### Inputs

- GitHub repository,
- uploaded files,
- URLs,
- user notes,
- presentation objective.

### Outputs

```ts
interface ResearchResult {
  summary: string;
  facts: FactRecord[];
  claims: ClaimRecord[];
  metrics: MetricRecord[];
  visuals: VisualCandidate[];
  codeExamples: CodeExample[];
  architectureFindings: ArchitectureFinding[];
  citations: SourceCitation[];
  uncertainties: string[];
}
```

### Repository-specific output

```ts
interface RepositoryContext {
  repositoryId: string;
  overview: string;
  languages: string[];
  frameworks: string[];
  importantFiles: FileSummary[];
  modules: ModuleSummary[];
  entryPoints: string[];
  APIs: ApiSummary[];
  workflows: WorkflowSummary[];
  architecture: ArchitectureSummary;
  diagrams: DiagramSource[];
}
```

### Retrieval strategy

Do not send an entire repository to an LLM.

Recommended pipeline:

```text
Repository
   |
   +--> file tree + language metadata
   |
   +--> README/docs extraction
   |
   +--> heuristic importance ranking
   |
   +--> targeted code summaries
   |
   +--> embeddings/index
   |
   +--> query-specific retrieval
```

The agent should be able to explain why a file was selected.

---

## 9. Agent 3 — Story Architect

### Responsibility

Design the information architecture and narrative.

### Output

```ts
interface StoryPlan {
  objective: string;
  audience: string;
  narrativeArc: string;
  estimatedDurationSeconds?: number;
  slides: StorySlide[];
}
```

```ts
interface StorySlide {
  sequence: number;
  purpose: string;
  title: string;
  keyMessage: string;
  supportingPoints: string[];
  evidenceIds?: string[];
  recommendedVisualType?: string;
  estimatedDurationSeconds?: number;
}
```

### Story rules

- one primary message per slide,
- avoid repeated claims,
- maintain beginning/middle/end,
- account for audience expertise,
- identify proof/evidence slides,
- determine which slides need visuals rather than text.

### Human checkpoint

Default new-deck flow should allow the user to inspect story before expensive full generation.

---

## 10. Agent 4 — Creative Director

### Responsibility

Convert narrative + user style intent + brand information into a visual system.

### Output

```ts
interface CreativeDirection {
  name: string;
  description: string;
  designTokens: DesignTokenProposal;
  typographyIntent: string;
  imageryIntent: string;
  diagramIntent: string;
  chartIntent: string;
  density: "low" | "medium" | "high";
  motionPersonality: string;
  doRules: string[];
  dontRules: string[];
}
```

### Example

```json
{
  "name": "Neo Technical",
  "description": "Dark editorial layout with luminous technical accents",
  "density": "low",
  "motionPersonality": "precise and restrained",
  "doRules": [
    "Use large numerical anchors",
    "Use thin architecture connectors",
    "Use whitespace aggressively"
  ],
  "dontRules": [
    "Avoid decorative gradients behind body text",
    "Avoid more than three font sizes per slide"
  ]
}
```

### Important boundary

The Creative Director should not output pixel coordinates.

---

## 11. Agent 5 — Layout Agent

### Responsibility

Translate slide semantic content and design tokens into layout proposals.

### Inputs

- `StorySlide`,
- theme/design tokens,
- available visual assets,
- viewport,
- text measurement service,
- layout library/templates as optional primitives.

### Output

```ts
interface LayoutCandidate {
  id: string;
  slideId: string;
  styleLabel: string;
  patch: PresentationPatch;
  metrics: LayoutMetrics;
}
```

### Layout metrics

```ts
interface LayoutMetrics {
  overflowCount: number;
  overlapCount: number;
  alignmentScore: number;
  whitespaceScore: number;
  densityScore: number;
  hierarchyScore?: number;
}
```

### Candidate generation

For important slides, generate multiple candidates:

- asymmetric editorial,
- centered hero,
- split visual,
- diagram-led,
- data-led.

Candidate scoring should combine deterministic rules and model critique.

---

## 12. Agent 6 — Motion Agent

### Responsibility

Translate slide narrative and object semantics into motion sequences.

### Inputs

- slide semantic intent,
- element tree,
- group semantics,
- motion theme,
- timing budget,
- reduced-motion policy.

### Output

```ts
interface MotionPlan {
  slideId: string;
  tracks: AnimationTrack[];
  rationale?: string;
  totalDurationMs?: number;
}
```

### Motion principles

- motion should reinforce narrative order,
- avoid animating everything,
- use semantic groups,
- preserve readability,
- default to restrained motion,
- respect reduced-motion settings.

### Example

For an architecture slide:

1. headline fades in,
2. input node appears,
3. orchestrator appears,
4. agent cluster appears,
5. data flow edges draw,
6. output proof node appears.

The agent defines intent; the animation engine generates deterministic implementation.

---

## 13. Agent 7 — Critic Agent

### Responsibility

Evaluate slide/deck quality and recommend specific revisions.

### Inputs

- structured slide,
- rendered preview image or render metadata,
- story intent,
- design direction,
- audience.

### Output

```ts
interface CriticResult {
  targetId: string;
  verdict: "pass" | "revise";
  scores: {
    hierarchy: number;
    readability: number;
    contrast: number;
    alignment: number;
    density: number;
    consistency: number;
    narrativeClarity: number;
    motionQuality?: number;
  };
  issues: CriticIssue[];
}
```

### Issue model

```ts
interface CriticIssue {
  severity: "info" | "warning" | "error";
  category: string;
  description: string;
  suggestedAction?: string;
  targetIds?: string[];
}
```

### Revision routing

Examples:
- poor story clarity -> Story Agent,
- visual hierarchy -> Layout Agent,
- brand inconsistency -> Creative Director/Layout Agent,
- excessive motion -> Motion Agent.

---

## 14. Deterministic Services

These are not agents.

### 14.1 Text Measurement Service

Returns:
- rendered width,
- rendered height,
- line count,
- overflow.

### 14.2 Layout Validator

Checks:
- element outside slide,
- overlap,
- alignment,
- minimum margins,
- safe areas.

### 14.3 Schema Validator

Checks patch and document validity.

### 14.4 Render Service

Produces preview output used by Critic Agent.

### 14.5 Export Service

Produces target formats.

### 14.6 Transaction Service

Validates and applies agent changes.

---

## 15. Tool Registry

Agents should access capabilities through a centralized registry.

```ts
interface AgentTool {
  id: string;
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  requiredPermissions: string[];
  riskLevel: "low" | "medium" | "high";
}
```

Example tools:

```text
github.listTree
github.readFile
github.searchCode

files.search
files.read

presentation.getSlide
presentation.getSelection
presentation.createPatch
presentation.validatePatch

layout.measureText
layout.validate

render.slidePreview

diagram.generate

image.generate

chart.build
```

---

## 16. Transaction Model

Every accepted agent edit becomes a transaction.

**The type is defined in `02_MYDECK_PRESENTATION_SCHEMA.md` §31.5 and is not
restated here.** v1.0 of this document declared its own `AgentTransaction`
alongside doc 05 §11's `Transaction`, doc 02 §31's `PresentationPatch` and doc 04
§29's `EditCommand` — four names for one concept, which is cross-cutting item #2
in the gap register. They now resolve to one lineage:

```text
PatchOperation   atomic change to one path
      |
    Patch        an ordered set of operations + intent
      |
 Transaction     an applied patch + inverse + source + status
```

Two fields that matter specifically to agents, both absent from the v1.0 shape:

- `status` (`pending | applied | rejected | expired | reverted`) — an agent
  proposal is `pending` until a human approves it, which is where
  proposal-before-apply (doc 01 §11.2) actually lives.
- `inverseOperations` — computed at apply time against the pre-state, because
  that is the only moment the old value is known. It is what makes AI-specific
  undo possible.

Agent attribution (`agentId`, `intent`, `reason`, `confidence`, `sourceIds`)
travels on the same record; see §32 of doc 02 for `AgentChangeMetadata`.

Benefits:
- AI-only undo,
- version history,
- agent inspector,
- audit,
- branch comparison.

---

## 17. Human-in-the-Loop Checkpoints

### New deck

Recommended checkpoints:

1. Story approval.
2. Optional creative direction choice.
3. Broad destructive revision confirmation.

### Edit flow

Potential confirmation thresholds:

**Low risk**
- typo fix,
- small color adjustment,
- minor alignment.

Can auto-apply.

**Medium risk**
- restructure selected slide,
- delete selected elements,
- rewrite large text block.

Preview recommended.

**High risk**
- modify entire deck,
- replace brand theme,
- remove multiple slides.

Explicit confirmation.

---

## 18. LangGraph Node Sketch

Example conceptual graph:

```py
builder.add_node("orchestrate", orchestrate)
builder.add_node("research", research)
builder.add_node("story", story)
builder.add_node("story_checkpoint", story_checkpoint)
builder.add_node("creative", creative)
builder.add_node("layout", layout)
builder.add_node("motion", motion)
builder.add_node("render", render_preview)
builder.add_node("critic", critic)
builder.add_node("apply", apply_transactions)
```

Conditional edges:

```text
orchestrate
  ├── research
  ├── story
  ├── layout
  └── motion

critic
  ├── pass -> apply
  └── revise -> selected revision agent
```

---

## 19. Persistence and Checkpointing

Persist state after meaningful stages:
- request parsed,
- research finished,
- story generated,
- human approved,
- layout generated,
- critic finished,
- transactions applied.

This supports:
- crash recovery,
- resumability,
- audit,
- long-running generation.

Large binary previews should be stored outside LangGraph state and referenced by IDs.

---

## 20. Streaming UX

Agent runs should stream meaningful progress events.

Example:

```text
Research Agent
✓ README analyzed
✓ 32 important files identified
✓ architecture summary created

Story Agent
✓ 10-slide narrative drafted

Creative Director
✓ visual system proposed

Layout Agent
● generating slide 6...
```

Avoid exposing raw chain-of-thought. Show user-facing state transitions, decisions, and results.

---

## 21. Error Handling

### Categories

- source unavailable,
- permission denied,
- model failure,
- invalid patch,
- render failure,
- layout impossible,
- unsupported export,
- timeout.

### Policy

Agents should never silently ignore a failed source or invalid patch.

Every error should include:
- stage,
- recoverability,
- safe fallback,
- user-visible message if needed.

Example fallback:
- if repository code analysis fails, use README/docs only and warn user.

---

## 22. Agent Evaluation

Each agent should have its own evaluation dataset.

### Research
- source precision,
- hallucination rate,
- evidence coverage.

### Story
- logical sequence,
- redundancy,
- audience fit,
- time fit.

### Layout
- overflow,
- overlap,
- alignment,
- hierarchy,
- user preference score.

### Motion
- sequence appropriateness,
- duration,
- readability,
- reduced-motion compatibility.

### Critic
- correlation with human quality judgment,
- false positive/negative issue rate.

---

## 23. Prompt Architecture

Prompts should be modular.

Recommended components:
- system contract,
- role,
- schema,
- user intent,
- scoped context,
- allowed tools,
- design rules,
- output requirements.

Do not inject an entire presentation into every agent request if only one slide is being edited.

Use context minimization.

---

## 24. Model Routing

The architecture should not lock into one model provider.

Create an internal model interface:

```ts
interface ModelRequest {
  taskType: string;
  messages: Message[];
  responseSchema?: object;
  visionInputs?: string[];
  toolIds?: string[];
}
```

Model router can choose:
- low-cost fast model,
- stronger reasoning model,
- vision-capable model,
- code model.

Routing can be task-based.

---

## 25. Security Boundaries

Agents must not:
- receive raw integration secrets,
- access repositories outside installation permission,
- execute arbitrary repository code by default,
- call undeclared tools,
- write directly to storage without transaction validation.

Any future code execution tool should use sandboxing and explicit policies.

---

## 26. MVP Agent Workflow

### New deck from repository

```text
User request
   |
Orchestrator
   |
Repository Agent
   |
Story Agent
   |
Human story approval
   |
Creative Director
   |
Layout Agent
   |
Render
   |
Critic
   |
Motion Agent (optional / simple)
   |
Transaction apply
   |
Editor
```

### Contextual edit

```text
Selection + instruction
   |
Orchestrator
   |
Relevant specialist
   |
Patch
   |
Validate
   |
Preview / apply
   |
Transaction history
```

---

## 27. Features Explicitly Deferred

- fully autonomous multi-hour agents,
- autonomous external publishing,
- unbounded agent recursion,
- arbitrary code execution,
- third-party agent marketplace,
- memory across organizations,
- automatic repository write-back.

---

## 28. Acceptance Criteria

The agent architecture is MVP-ready when:

- [ ] all agents have typed inputs/outputs,
- [ ] edit scope is always explicit,
- [ ] agents cannot bypass the transaction layer,
- [ ] repository retrieval is staged,
- [ ] story checkpoint can pause/resume,
- [ ] Critic can route revision requests,
- [ ] loops have maximum iteration counts,
- [ ] all accepted AI changes produce transactions,
- [ ] tool permissions are enforced,
- [ ] model provider can be swapped without changing presentation schema,
- [ ] user-visible progress events are emitted.

---

## 29. Core Architectural Rule

> Agents should manipulate **intent and structured presentation operations**, not pixels and not opaque rendered images.

Rendered images can be used for critique, but the canonical output of an agentic edit should remain a structured patch against the presentation model.
