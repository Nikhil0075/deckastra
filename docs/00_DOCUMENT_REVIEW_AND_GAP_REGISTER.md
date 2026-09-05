# Document Set Review & Gap Register

**Reviewed:** `01_PRODUCT_REQUIREMENTS`, `02_MYDECK_PRESENTATION_SCHEMA`, `03_AGENT_ARCHITECTURE_LANGGRAPH`, `05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE`
**Reviewed against:** `04_CANVAS_RENDERING_ANIMATION_ENGINE` v1.1
**Date:** 2026-09-05

---

## Verdict

| Doc | Structure | Correctness | Depth | Priority |
| --- | --- | --- | --- | --- |
| 01 — PRD | Strong | Sound | Thin on non-functional detail, sharing, onboarding | Medium |
| 02 — Schema | Strong | ~~Has real gaps~~ **Resolved in v1.1** | — | **Done** |
| 03 — Agents | Strong | Sound; one contradiction with 01 | Missing cost, injection, memory | High |
| 05 — System | Strong | Sound; data model has modelling holes | Missing multi-member workspaces, themes, vector store, webhooks | High |

> **Status update — schema v1.1.** Every doc 02 finding below (S1, S2, and S3) is closed in `02_MYDECK_PRESENTATION_SCHEMA.md` v1.1, along with cross-cutting items #2, #4, #5, #7, and #8. The findings are retained here as the record of what was fixed and why. Items now open are in docs 01, 03, and 05; §"Suggested Fix Order" has been re-sequenced accordingly.

None of the four documents is wrong in its architecture. The issues are of three kinds: **types referenced but never defined**, **features defined but not wired to anything**, and **decisions deferred that block implementation**.

Doc 02 is the one to fix first. It calls itself the source of truth, and three other documents type-check against it.

**Severity key**
- **S1** — blocks implementation or is a correctness bug. Fix before coding that area.
- **S2** — will cause rework or a migration later. Fix before the relevant phase.
- **S3** — enhancement; the doc is usable without it.

---

## 02 — `.mydeck` Presentation Schema

The most important document, and the one with the most outstanding work. It reads as complete because every section has a code block, but many of those blocks reference types that appear nowhere.

### S1 — `PresentationElement` union is never declared

Used at `Slide.elements[]` and `GroupElement.children[]`. Without it, `ElementType` and the individual element interfaces are not connected, and no validator can be generated.

```ts
export type PresentationElement =
  | TextElement | ShapeElement | LineElement | ImageElement | IconElement
  | GroupElement | ChartElement | DiagramElement | TableElement | CodeElement
  | VideoElement | AudioElement | WebEmbedElement | ComponentInstanceElement;
```

### S1 — `ContainerLayout` is defined but attached to nothing

§21 defines the interface. `GroupElement` (§16) has `children` and `groupRole` only. So container layouts are unreachable from a valid document — yet doc 04 §15.3 and the Layout Agent both depend on them, and they are the mechanism that keeps AI-generated card rows from breaking when text length changes.

```ts
export interface GroupElement extends BaseElement {
  type: "group";
  children: PresentationElement[];
  groupRole?: string;
  containerLayout?: ContainerLayout;   // MISSING
  resizeMode?: "scaleChildren" | "resizeContainer";
}
```

### S1 — No component model at all

`PresentationDocument.components: ComponentDefinition[]` is declared; `ComponentDefinition` is never defined. There is no instance element, no props, no overrides, no slot model. Doc 04's pipeline stage 4 ("resolve component instances") has nothing to resolve. Design goal #8 ("composable") is currently unmet.

Minimum needed: `ComponentDefinition { id, name, parameters, template }`, `ComponentInstanceElement { componentId, parameterValues, overrides }`, and a statement of override precedence.

### S1 — Two sources of truth for ordering

`Slide.order: number` alongside slides living in an array; `BaseElement.zIndex` alongside `elements[]` array position. Reordering must then update N fields, and any disagreement between array position and `order` is undefined behaviour.

Recommendation: array order is authoritative for both; delete `Slide.order`; keep `zIndex` only as an explicit override with stated precedence (doc 04 §8.3 already specifies the resolution — mirror it here).

### S1 — Patch path grammar unspecified

`PatchOperation.path` is JSON Pointer, so `/slides/2/elements/7`. Index-addressed paths break under concurrent edits and under any operation that inserts or removes an earlier sibling — which is exactly what agents do. Doc 04 §29.1 and §43.4 recommend id-addressed paths (`/slides/id:slide-02/elements/id:el-7`) resolved to indices at apply time.

Also missing from the op set: `test` (needed for optimistic concurrency) and `copy`.

Decide this before any agent writes ship. It is a schema-version-breaking change afterwards.

### S1 — `DataBinding.transform?: string` is an unspecified expression language

Free-form string transforms evaluated somewhere unnamed. Is it JS? A template? JSONata? If it is evaluated client-side, a shared deck becomes a code-execution vector — and doc 05 §34 explicitly forbids arbitrary code execution in MVP.

Pin it to a small declarative allowlist (`number.format`, `date.format`, `string.truncate`, `math.sum`, …) with named parameters, or drop `transform` from v1.

### S2 — ~25 types referenced but never defined

`VariableValue`, `BackgroundDefinition`, `SlideLayoutMetadata`, `ElementMetadata`, `RichTextDocument`, `CropDefinition`, `Point`, `AnchorReference`, `StrokeStyle`, `ShadowStyle`, `CornerRadius`, `VisualFilter`, `GradientStop`, `Insets`, `ColorTokens`, `TypographyTokens`, `SpacingTokens`, `RadiusTokens`, `ShadowTokens`, `GridTokens`, `ChartTheme`, `DiagramTheme`, `ImageryTheme`, `BrandRule`, `ChartDataReference`, `ChartEncoding`, `ChartStyle`, `IconReference`, and the five constraint variants (`AlignConstraint` etc. — only shown as a union).

Not all are urgent, but the token types (`ColorTokens`, `TypographyTokens`) and `RichTextDocument` are, because the theme and text are the two things every other document assumes.

### S2 — `RichTextDocument` deferred in a way that will force a migration

§12 says it "can initially be a simple string plus spans", and the §33 example uses `content: { text: "..." }`. If MVP ships plain strings and inline styling arrives later, every stored deck needs migrating. Doc 04 §17.1 proposes shipping the blocks+spans *shape* immediately even if only one span per block is populated. Cheap now, expensive later.

### S2 — `icon` and `table` are orphaned

`icon` is in `ElementType` and `IconReference` is used by `DiagramNode`, but neither `IconElement` nor `IconReference` is defined. `table` is in `ElementType` but has no interface and is absent from doc 01's element list entirely — despite being essential for business-review decks (§5.4) and mapped in doc 04 §33.2.

### S2 — Theme token set is too small to be a design contract

§22 promises the theme is "a design contract" agents reference. The §33 example provides three colors. Real decks need semantic tokens (surface, surfaceAlt, muted, border, onAccent), state colors, an ordered chart series palette, and declared contrast pairs — otherwise the Creative Director and Critic have nothing concrete to check against.

Also: naming is inconsistent — theme uses `typography.heading.family`, elements use `typography.fontFamily`.

### S2 — `AssetReference.uri` conflicts with doc 05 §24

Doc 05 says "do not store transient signed URLs in canonical documents". `uri` invites exactly that. Rename to `storageKey` (opaque, resolved to a signed URL at render time) and state the rule in 02.

### S2 — Package structure vs in-memory document mismatch

§3 shows `animations.json` and `components.json` as separate files; §4 embeds animations inside slides and components at the top level. Two serializations, no stated mapping. Specify which is canonical and how the split/join works, or drop the package layout until it is built.

### S3 — Animation model details unstated

- What `AnimationClip.startMs` means when the trigger is `afterPrevious` (offset? absolute? — doc 04 §25.1 treats it as an added offset).
- `Keyframe.offset` is 0–1 normalized against the clip duration; say so.
- What happens when two clips animate the same property over overlapping intervals (doc 04 §25.3: last-defined wins, warn).
- Precedence when an `Interaction` trigger and an `AnimationTrigger` both fire on click of the same element.

### S3 — `variables` has no semantics

`Record<string, VariableValue>` with no scoping, no resolution order, no relationship to `dataSources`. Either define it or remove it from v1.

### S3 — Missing from §34 validation list

Cyclic constraints, animation clips exceeding slide duration, elements outside the viewport, duplicate `zIndex` within a group, orphaned connector anchors, and font references not present in the asset manifest.

---

## 03 — Agent Architecture & LangGraph

The strongest of the four conceptually. The agent boundaries are well drawn and the "agents propose, deterministic services compose" rule is right. Gaps are operational.

### S1 — `EditScope` contradicts doc 01

Doc 01 §11.1 lists six scopes including `sources`. Doc 03 §6 defines five and omits it. Pick one; `sources` is meaningful ("re-run research against the updated repo"), so add it.

### S1 — No prompt-injection or untrusted-content policy

The product's flagship flow ingests arbitrary GitHub repositories and, later, web content and MCP results. A README containing "ignore previous instructions and…" currently has nothing standing in its way. §25 covers secrets and permissions but not content-borne instructions.

Needed: a stated rule that all retrieved content is data, delivered inside a labelled envelope, and that no agent acts on instructions found within it. Doc 04 §48.2 has the wording.

### S1 — No cost, token, or iteration budget

§7 says "stop loops after configured thresholds" without numbers. §24 routes models without a cost model. There is no per-run token budget, no max tool calls, no wall-clock timeout, no workspace spend cap. A revision loop between Critic and Layout on a 40-slide deck is the obvious runaway.

Add: `max_revisions` (suggest 2 per slide, 3 per deck), per-run token ceiling, per-tool timeout, per-workspace daily credit, and behaviour on exhaustion (degrade and warn — never fail silently).

### S2 — Retrieval index has no home

§8's pipeline ends at "embeddings/index" and doc 05 lists "vector DB" as a flexible choice with no store in the deployment diagram or data model. Given Postgres is already in the stack, `pgvector` is the low-friction answer. Also unspecified: chunking strategy, embedding model, re-index triggers, and index invalidation on repo push.

### S2 — No agent memory or reuse model

§27 defers "memory across organizations", but there is no *within*-project memory either: user style preferences, previously accepted layouts, rejected proposals. Without it, the Critic re-flags the same thing the user already dismissed. That is the fastest way to lose the trust §14 is trying to protect.

### S2 — Proposal state is undefined

Doc 01 §11.2 requires proposal-before-apply. §16's `AgentTransaction` describes an *accepted* edit. There is no representation for a proposed-but-unapplied transaction, no expiry, no accept/reject transition. This is also what doc 04 §46.2 needs for MCP writes.

Add `status: "pending" | "applied" | "rejected" | "expired"` and define the lifecycle in one place.

### S2 — Three overlapping transaction types across the doc set

| Doc | Type | Has inverses | Has agent metadata |
| --- | --- | --- | --- |
| 02 §31 | `PresentationPatch` | no | yes |
| 03 §16 | `AgentTransaction` | no | yes |
| 05 §11 | `Transaction` | yes | partly |
| 04 §29 | `EditCommand` | yes | via id |

Four names for one concept. Reconcile into: `PatchOperation` (atomic) → `Patch` (a set) → `Transaction` (an applied patch with inverse, source, and metadata). Define once in doc 02 and reference everywhere else.

### S3 — Graph node names don't match the agent list

§4's diagram has "Source Analysis" and "User Context" nodes not in §3's list of seven agents. Either they are stages of the Research Agent or they are nodes; say which.

### S3 — Streaming event schema unspecified

§20 shows example output but no event type. Doc 05 §29 commits to SSE. Define the payload (`stage`, `agentId`, `status`, `message`, `progress`, `artifactRefs`) so the frontend can be built against it.

### S3 — No fallback when the Critic disagrees repeatedly

If Critic returns `revise` three times on the same slide, what ships? Define: accept the highest-scoring candidate, attach the unresolved issues to the slide, surface them in the editor.

---

## 05 — MVP System & Repository Architecture

Well-organised and pragmatic. The gaps are in the data model, where they are cheapest to fix now and most painful to fix later.

### S1 — No workspace membership table

`workspaces` has `owner_id` only. §27's authorization chain (`User → Workspace → Project → …`) cannot be resolved for anyone but the owner, and §26 promises team permissions later. Add:

```text
workspace_members
- workspace_id
- user_id
- role            (owner | admin | editor | viewer)
- created_at
```

Single-member workspaces then become a special case of the general model rather than a schema migration.

### S1 — No transaction status / proposal storage

Same gap as 03. The `transactions` table has no `status` and no `parent_version_id`, so a proposed transaction has nowhere to live and the version lineage of an applied one is implicit.

### S2 — No themes table

Themes are embedded in the document JSON only, so an organization cannot define or enforce a shared brand — contradicting §5.4 of the PRD and the "brand rules as a design contract" claim in doc 02 §22. Add a `themes` table scoped to workspace, with documents referencing `themeId` plus a resolved snapshot for portability.

### S2 — No sharing / permission model for presentations

The editor toolbar in doc 01 §10 has a Share button. There is no `presentation_shares` table, no link-sharing model, no viewer role, no public-present URL. Present mode for an audience is a core use case and currently has no access path for anyone but the author.

### S2 — GitHub integration has no webhooks or re-index strategy

`github_repositories.last_indexed_at` exists, but nothing invalidates it. A deck generated from `main` silently drifts from the repository. Add webhook handling (push, installation change, repo deletion), incremental re-index, per-repo size quotas, and a staleness indicator surfaced in the UI.

### S2 — LangGraph checkpointing location undecided

§2 lists Redis as "later/where useful"; §25 puts agent run state in Redis; doc 03 §19 requires durable checkpoints for resumability. Redis is explicitly "not source of truth" (§25). Decide: Postgres checkpointer for durability, Redis for ephemeral progress/pubsub.

### S2 — No vector store in the data model

Follows from 03's gap. If `pgvector`, say so and add the tables (`repository_chunks` with embedding, file path, line range, and a provenance link).

### S2 — No asset lifecycle

`assets` has no soft delete, no reference counting, no orphan cleanup, no quota. Generated images accumulate indefinitely, and deleting a slide silently orphans its uploads.

### S3 — Observability tooling unnamed

§32 lists what to track, not how. Name the stack: OpenTelemetry for traces/metrics, a trace store, and an LLM-specific tracer (LangSmith/Langfuse) for agent runs — because §22's evaluation loop needs run-level traces to be useful.

### S3 — No migration or backup policy

Alembic (or equivalent) for schema, plus a stated backup/restore/RPO position for a product whose value proposition is "your work is safe and versioned".

### S3 — No environment/deployment topology

§35 covers local dev; there is no dev/staging/prod description, no secret management, no scaling notes for the worker pool, no cost model for the headless render fleet doc 04 §41 introduces.

---

## 01 — Product Requirements & User Journeys

The most complete of the four as a document. Its gaps are the ones a PRD usually has at this stage: the operational and commercial surfaces.

### S2 — No sharing, collaboration, or permissions requirements

Share appears in the UI mockup and nowhere in the requirements. Who can open a deck? Can a link be public? Is there a viewer role? Present mode implies an audience; the audience currently has no defined access.

### S2 — Non-functional targets are unmeasurable

§9.1 says "quickly", "instantaneous", "60 FPS for normal slide complexity". Doc 04 v1.1 §31.1 now has concrete budgets. Import them so the PRD and the engineering doc agree on the same numbers.

Same for §9.5 accessibility: name WCAG 2.1 AA as the target, and state which criteria are in scope for MVP (contrast, keyboard, focus, alt text, reduced motion) versus deferred (tagged PDF, full screen-reader editor support).

### S2 — Element type list disagrees with the schema

§8.3 lists `icon` as MVP; doc 02's MVP subset (§37) omits it. `table` is missing from §8.3 entirely though the schema defines it and doc 04 maps it for export. Reconcile the two lists — they are the same decision recorded twice.

### S2 — No onboarding, empty-state, or error-experience requirements

First-run, first deck, what an empty project looks like, what happens when an agent run fails mid-generation, what the user sees when a repository index is stale or a font is missing. These shape a large share of the perceived quality and are absent.

### S3 — Several §16 open decisions are already settled elsewhere

- Q6 (responsive vs fixed layouts) — doc 04 §4 fixes logical coordinates. Decided.
- Q4 (auto motion on generated slides) — doc 04 §24 argues for restrained defaults on. Effectively decided.
- Q3 (Code Mode in MVP) — doc 01 §6.4 already says "optional in V1, read-only or limited". Effectively decided.

Close them in the PRD so they stop reading as open.

### S3 — No pricing, packaging, or quota model

Model spend is the dominant variable cost and there is no notion of credits, plan tiers, or per-workspace limits — which doc 03's budget gap and doc 04 §45.4's rate limits both need to reference.

### S3 — Metrics have no targets

§13 lists what to measure without target values or a definition of success. "Percentage of generated slides kept without regeneration" is the single most important quality metric in the document; give it a number.

### S3 — Journey letters

Journey F is version/branch. Doc 04 Appendix A's proposed agent-driven journey is therefore **G**. (Corrected in doc 04 v1.1.)

---

## Cross-Cutting Contradictions

| # | Contradiction | Docs | Resolution |
| --- | --- | --- | --- |
| 1 | `EditScope` has 5 vs 6 values | 01 §11.1, 03 §6 | Add `sources` to 03 |
| 2 | Four names for one transaction concept | 02 §31, 03 §16, 05 §11, 04 §29 | Define once in 02; reference elsewhere |
| 3 | `icon` MVP vs not; `table` present vs absent | 01 §8.3, 02 §37 | One canonical element list |
| 4 | `AssetReference.uri` vs "no signed URLs in documents" | 02 §28, 05 §24 | Rename to `storageKey` |
| 5 | Ordering: `order`/`zIndex` fields vs array position | 02 §7, §8 | Array authoritative; `zIndex` as override |
| 6 | Agent run state in Redis vs durable checkpoints | 03 §19, 05 §25 | Postgres checkpointer, Redis for progress |
| 7 | Package files vs embedded document | 02 §3 vs §4 | Declare one canonical serialization |
| 8 | Theme naming: `family` vs `fontFamily` | 02 §22 vs §12 | Pick one convention |
| 9 | MVP definitions differ slightly | 01 §12, 05 §38 | Single canonical list, referenced twice |
| 10 | Journey F collision | 01 §7.6, 04 App. A | Corrected to Journey G |

---

## Suggested Fix Order

~~**Before any code** — doc 02 S1 items and cross-cutting #2~~ **Done in schema v1.1.**

**Before Phase 1 (presentation core)**
1. Doc 03 S1 — edit scope (`sources`), injection policy, run budgets.
2. Doc 05 S1 — `workspace_members`, transaction `status` / `parent_version_id` / `result_version_id`.
3. Doc 03 §16 and doc 05 §11 — replace the local transaction types with references to schema §31.5.

**Before Phase 4 (AI foundation)**
4. Doc 03 S2 — retrieval index home, proposal lifecycle, agent memory model.
5. Doc 05 S2 — vector store (pgvector), LangGraph checkpointing decision.

**Before Phase 5 (GitHub)**
6. Doc 05 — webhooks, incremental re-index, per-repo quotas.

**Before launch**
7. Doc 01 S2/S3 — sharing model, measurable NFRs (import from doc 04 §31.1), onboarding and error UX, pricing/quota model.
8. Doc 05 S2/S3 — themes table, asset lifecycle, observability stack, backups.
9. Doc 01 §8.3 — replace the element list with a reference to schema §37.1.

---

## What Is Already Right

Worth stating, because the fixes above are all additive rather than corrective:

- The core thesis — AI proposes, deterministic engines compose, humans stay in control — is applied consistently across all five documents. That consistency is rare and is the reason the gaps are fillable rather than structural.
- Separating semantic intent (`semanticIntent`, `semanticRole`, `keyMessage`) from geometry is the right call and is what makes agent editing tractable.
- Agent boundaries in doc 03 are well drawn, especially the refusal to let the Creative Director emit coordinates.
- Treating PPTX as a compatibility target rather than a source of truth avoids the trap that has limited every competitor.
- Snapshot-plus-operations versioning (05 §22) is the correct model and is what makes AI-specific undo possible.
- The decision to keep provenance in the document rather than in a side channel will matter more than it currently appears to.
