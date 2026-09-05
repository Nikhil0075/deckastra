# MVP System & Repository Architecture

**Document type:** Technical architecture and implementation blueprint  
**Status:** Foundation / Draft v1.0  
**Architecture style:** Monorepo, web-first, service-backed, shared presentation core  
**Purpose:** Define the implementation structure for the first production-capable Deckastra release.

---

## 1. Goals

The architecture must:

- support a web editor,
- support a future desktop shell,
- reuse one presentation engine,
- support agent workflows,
- integrate with GitHub,
- store versioned presentation documents,
- render and export reliably,
- scale from MVP to team/enterprise use,
- keep the LLM layer replaceable.

---

## 2. Recommended Technology Stack

### Frontend

- Next.js
- React
- TypeScript
- Zustand or equivalent local state
- Tailwind CSS or design-token based styling
- DOM + SVG presentation renderer
- animation adapter around Motion/Web Animations/GSAP
- TanStack Query or equivalent for server state

### Backend

- Python
- FastAPI
- LangGraph
- PostgreSQL
- Redis later/where useful
- object storage (S3/GCS/R2)

### Desktop

- Electron after web MVP
- same React editor package

### Integrations

- GitHub App
- model provider abstraction
- file/document ingestion
- image generation
- web research later
- Figma/Drive later

---

## 3. High-Level Deployment Architecture

```text
                         User
                          |
                    Web / Desktop
                          |
                 +--------+---------+
                 |                  |
            Web Frontend        Desktop Shell
                 |                  |
                 +--------+---------+
                          |
                      API Gateway
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
   Presentation API   Agent Service    Export Service
          |               |                |
          +-------+-------+----------------+
                  |
              PostgreSQL
                  |
          +-------+--------+
          |                |
       Redis          Object Storage
                           |
                     Images / uploads
```

GitHub integration:

```text
GitHub
  |
GitHub App
  |
Integration Service
  |
Repository Index
  |
Agent Tool Registry
```

---

## 4. Monorepo Structure

Recommended initial repository:

```text
deckastra/
├── apps/
│   ├── web/
│   ├── desktop/
│   ├── api/
│   └── worker/
│
├── packages/
│   ├── presentation-schema/
│   ├── presentation-core/
│   ├── renderer/
│   ├── editor/
│   ├── layout-engine/
│   ├── animation-engine/
│   ├── transactions/
│   ├── export-pdf/
│   ├── export-pptx/
│   ├── ui/
│   ├── integrations-sdk/
│   └── shared/
│
├── agents/
│   ├── orchestrator/
│   ├── research/
│   ├── repository/
│   ├── story/
│   ├── creative-director/
│   ├── layout/
│   ├── motion/
│   └── critic/
│
├── integrations/
│   ├── github/
│   ├── llm/
│   ├── files/
│   └── images/
│
├── infrastructure/
│   ├── docker/
│   ├── database/
│   ├── deployment/
│   └── observability/
│
├── docs/
│   ├── 01_PRODUCT_REQUIREMENTS_AND_USER_JOURNEYS.md
│   ├── 02_MYDECK_PRESENTATION_SCHEMA.md
│   ├── 03_AGENT_ARCHITECTURE_LANGGRAPH.md
│   ├── 04_CANVAS_RENDERING_ANIMATION_ENGINE.md
│   └── 05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md
│
├── tests/
├── scripts/
└── README.md
```

A JavaScript/TypeScript monorepo tool such as Turborepo or Nx can coordinate frontend packages. Python services can remain in the same repository with separate build tooling.

---

## 5. `apps/web`

Responsibilities:
- authentication UI,
- dashboard,
- project routes,
- editor shell,
- AI panel,
- source browser,
- version history,
- presentation mode,
- export controls.

Suggested structure:

```text
apps/web/
├── app/
│   ├── dashboard/
│   ├── project/[id]/
│   ├── present/[id]/
│   ├── settings/
│   └── api/
├── components/
├── features/
│   ├── editor-shell/
│   ├── ai-panel/
│   ├── github-connect/
│   ├── versions/
│   └── export/
└── lib/
```

---

## 6. `apps/desktop`

Initially defer until web editor stabilizes.

Desktop responsibilities:
- wrap editor,
- filesystem integration,
- native menus,
- local asset import,
- local fonts,
- offline cache,
- OS clipboard,
- native export workers.

Architecture:

```text
Electron Main
   |
Preload bridge
   |
React renderer
   |
shared editor packages
```

Do not expose unrestricted Node APIs directly to renderer code.

---

## 7. `apps/api`

Recommended responsibilities:
- authentication/session validation,
- projects,
- presentations,
- versions,
- agent run initiation,
- integration management,
- asset metadata,
- export job creation.

Suggested structure:

```text
apps/api/
├── main.py
├── routes/
│   ├── projects.py
│   ├── presentations.py
│   ├── versions.py
│   ├── agents.py
│   ├── github.py
│   ├── assets.py
│   └── exports.py
├── services/
├── repositories/
├── schemas/
└── middleware/
```

---

## 8. `apps/worker`

Useful when asynchronous jobs are introduced.

Jobs:
- repository indexing,
- export,
- preview rendering,
- large AI generation,
- media processing.

MVP can begin with simpler request-bound workflows if deployment constraints allow, but architecture should anticipate queues.

---

## 9. `packages/presentation-schema`

Contains:
- TypeScript interfaces,
- Zod schemas,
- JSON Schema generation,
- schema version constants,
- migrations,
- canonical example documents.

This package must not depend on React.

---

## 10. `packages/presentation-core`

Contains model-level operations:

```ts
createPresentation()
createSlide()
addElement()
removeElement()
moveElement()
cloneSlide()
resolveElementById()
validateReferences()
```

This package should be pure and heavily unit-tested.

---

## 11. `packages/transactions`

Responsibilities:
- apply patches,
- generate inverse patches,
- group commands,
- undo/redo,
- identify transaction source,
- version snapshots.

Core types:

```ts
interface Transaction {
  id: string;
  source: "user" | "agent" | "system";
  operations: PatchOperation[];
  inverseOperations: PatchOperation[];
  metadata?: Record<string, unknown>;
}
```

---

## 12. `packages/renderer`

Contains:
- scene graph derivation,
- React element renderer,
- SVG primitives,
- theme resolution,
- render context,
- editor-safe and presentation-safe modes.

Should not own persistence.

---

## 13. `packages/editor`

Contains:
- selection state,
- resize handles,
- drag behavior,
- snapping,
- group navigation,
- clipboard,
- keyboard shortcuts,
- object inspector bindings.

Example:

```text
editor/
├── selection/
├── transforms/
├── snapping/
├── clipboard/
├── keyboard/
├── overlays/
└── hooks/
```

---

## 14. `packages/layout-engine`

Responsibilities:
- container layouts,
- simple constraints,
- text measurement interface,
- collision detection,
- candidate scoring helpers.

This package provides deterministic tools to Layout Agent.

---

## 15. `packages/animation-engine`

Responsibilities:
- animation preset registry,
- timeline model adapters,
- runtime playback,
- seek/pause/play,
- reduced motion,
- transition execution.

Example API:

```ts
playSlide(slideId)
pause()
seek(ms)
previewTrack(trackId)
```

---

## 16. Export Packages

### `export-pdf`

Responsibilities:
- high-fidelity static output,
- page dimensions,
- fonts,
- images,
- vector preservation where practical.

### `export-pptx`

Responsibilities:
- map Deckastra elements to PPTX equivalents,
- preserve text/shapes/images/charts where supported,
- flatten unsupported effects,
- produce compatibility warnings.

Export adapters should return a report:

```ts
interface ExportReport {
  warnings: ExportWarning[];
  flattenedElements: string[];
  unsupportedFeatures: string[];
}
```

---

## 17. `agents/`

Each agent should contain:
- prompt contract,
- input schema,
- output schema,
- node implementation,
- evaluation fixtures,
- unit tests.

Example:

```text
agents/story/
├── prompt.md
├── schemas.py
├── node.py
├── evaluator.py
└── tests/
```

Agent implementations should not know database details directly.

---

## 18. Tool Registry Architecture

Create a central tool layer.

```text
LangGraph Agent
     |
 Tool Registry
     |
+----+---------+-----------+-----------+
|              |           |           |
GitHub      Files      Presentation   Render
```

Python contract:

```py
class ToolDefinition(BaseModel):
    id: str
    description: str
    input_schema: dict
    output_schema: dict
    required_permissions: list[str]
```

The registry handles:
- permission checks,
- tracing,
- retries,
- input validation,
- output validation.

---

## 19. GitHub App Architecture

Use a GitHub App rather than broad user token access.

### Flow

```text
User
  |
Install GitHub App
  |
Select repositories
  |
Installation ID stored
  |
Backend requests short-lived token
  |
Repository service fetches permitted content
```

### Store

```text
github_installations
- id
- user_id / workspace_id
- github_installation_id
- account_login
- created_at

github_repositories
- id
- installation_id
- github_repository_id
- owner
- name
- default_branch
- last_indexed_at
```

Never store private keys in frontend code.

---

## 20. Repository Indexing Pipeline

Recommended:

```text
1. Fetch repository metadata
2. Fetch tree
3. Ignore binaries/vendor/build artifacts
4. Extract README/docs
5. Detect languages/frameworks
6. Rank important source files
7. Chunk source text
8. Generate structural metadata
9. Store embeddings/search index
10. Build RepositoryContext
```

Ignore patterns should include:
- `node_modules`,
- build outputs,
- generated files,
- large vendored code,
- secrets,
- binary artifacts.

Do not execute repository code during normal indexing.

---

## 21. Database Model

Suggested MVP tables.

### users

```text
id
email
name
created_at
```

### workspaces

```text
id
name
owner_id
created_at
```

### projects

```text
id
workspace_id
name
description
created_by
created_at
updated_at
```

### presentations

```text
id
project_id
title
current_version_id
schema_version
created_at
updated_at
```

### presentation_versions

```text
id
presentation_id
parent_version_id
snapshot_uri / snapshot_json
created_by
source
created_at
```

### transactions

```text
id
presentation_id
version_id
source
agent_id
operations_json
inverse_operations_json
metadata_json
created_at
```

### agent_runs

```text
id
project_id
presentation_id
status
workflow_type
state_reference
started_at
completed_at
error_json
```

### assets

```text
id
project_id
type
storage_uri
mime_type
checksum
width
height
created_at
```

### github_installations

as above.

### sources

```text
id
project_id
type
reference
metadata_json
created_at
```

---

## 22. Snapshot + Operations Versioning

Avoid saving full copies for every small edit.

Recommended:
- continuous operation log,
- periodic snapshots,
- snapshot on important checkpoints.

Example:

```text
Snapshot v100
  +
ops 101..124
  =
Current presentation
```

Create snapshots:
- every N operations,
- before/after major agent runs,
- before branch creation,
- at explicit named versions.

---

## 23. Branch Model

V1 can keep branches simple.

```text
presentation_branches
- id
- presentation_id
- name
- head_version_id
- created_from_version_id
```

Initially support:
- create branch,
- switch,
- compare.

Full arbitrary merge can be deferred.

---

## 24. Object Storage

Store:
- uploaded images,
- generated images,
- video,
- large documents,
- exports,
- render previews,
- agent artifacts.

Use stable object IDs and signed URLs.

Do not store transient signed URLs in canonical documents.

---

## 25. Caching

Potential Redis usage:
- agent run state,
- job queues,
- repository metadata cache,
- render preview cache,
- rate limits,
- collaborative presence later.

Do not use Redis as source of truth.

---

## 26. Authentication

MVP:
- email/social authentication,
- GitHub connection separately,
- project ownership checks.

Future:
- organization roles,
- SSO,
- SCIM,
- enterprise policy.

GitHub login and GitHub repository installation are different concepts and should not be conflated.

---

## 27. Authorization

Every server operation should resolve:

```text
User
  |
Workspace
  |
Project
  |
Presentation / Source / Asset
```

Agent tools must execute under the user's/workspace's permissions.

---

## 28. API Examples

### Get presentation

```http
GET /v1/presentations/{id}
```

### Apply transaction

```http
POST /v1/presentations/{id}/transactions
```

### Start agent run

```http
POST /v1/presentations/{id}/agent-runs
```

Body:

```json
{
  "instruction": "Make slide 6 more executive-friendly",
  "scope": {
    "type": "slide",
    "targetIds": ["slide-06"]
  }
}
```

### Connect repository

```http
POST /v1/projects/{id}/sources/github
```

---

## 29. Realtime Transport

Agent progress can use:
- Server-Sent Events for simple streaming,
- WebSockets if bidirectional real-time collaboration becomes necessary.

MVP recommendation:
- SSE for agent progress,
- standard HTTP for document mutations.

---

## 30. Frontend State Architecture

Separate three categories.

### Server state
- project metadata,
- presentation snapshots,
- agent runs,
- versions.

### Document state
- canonical presentation document,
- transaction history.

### Editor state
- selection,
- zoom,
- open panel,
- hovered object,
- temporary drag position,
- timeline scroll.

Editor state should not pollute persisted presentation JSON.

---

## 31. Autosave Strategy

Possible approach:
- local optimistic operations,
- batch every short interval,
- persist transaction batch,
- acknowledge server version,
- retry failures.

Conflict handling initially can assume one active editor per presentation if real-time collaboration is out of scope.

---

## 32. Observability

Track:

### Backend
- request latency,
- error rate,
- DB latency,
- export duration.

### Agents
- model,
- tokens,
- latency,
- tool calls,
- revision loops,
- failures,
- acceptance rate.

### Editor
- crash/error events,
- render duration,
- FPS sampling,
- autosave failures.

### Export
- format,
- duration,
- warnings,
- failure reasons.

---

## 33. Testing Strategy

### Schema tests
- valid documents,
- invalid references,
- migrations.

### Presentation core
- add/remove/move,
- inverse patches,
- snapshot reconstruction.

### Editor
- selection,
- transforms,
- undo,
- keyboard shortcuts.

### Agents
- structured output validation,
- hallucination tests,
- source grounding tests.

### GitHub
- installation permission,
- repository scope,
- indexing exclusions.

### End-to-end
- create deck,
- connect GitHub,
- generate story,
- generate deck,
- edit,
- animate,
- export.

---

## 34. Security Requirements

- no integration secrets in browser bundle,
- short-lived repository access tokens,
- encrypted storage,
- strict tenant boundaries,
- signed asset URLs,
- allowlisted tool registry,
- no arbitrary code execution in MVP,
- sanitize SVG/HTML imports,
- content security policy,
- rate limits on expensive endpoints.

---

## 35. Local Development

Recommended developer experience:

```text
docker compose up
```

Services:
- PostgreSQL,
- Redis,
- API,
- worker,
- web.

Environment files:
- `.env.local` for local only,
- secrets through deployment platform in production.

Seed project:
- one sample technical deck,
- one sample GitHub-like repository context,
- one animation test deck.

---

## 36. CI/CD

Pipeline:

```text
PR
 |
 +--> lint
 +--> typecheck
 +--> unit tests
 +--> schema compatibility tests
 +--> agent contract tests
 +--> visual regression tests
 +--> build
```

Main branch:
- deploy preview/staging,
- run E2E,
- promote to production.

Desktop release pipeline comes later.

---

## 37. Suggested MVP Development Sequence

### Phase 0 — Foundations

- product scope,
- presentation schema,
- repo setup,
- CI,
- design tokens.

### Phase 1 — Presentation Core

- document model,
- serialization,
- slide CRUD,
- element CRUD,
- transactions,
- undo/redo.

### Phase 2 — Editor

- canvas,
- selection,
- move/resize,
- text,
- shapes,
- images,
- groups,
- snapping.

### Phase 3 — Renderer + Present

- theme,
- diagrams,
- charts,
- present mode.

### Phase 4 — AI Foundation

- LangGraph,
- Orchestrator,
- Story,
- Creative Director,
- Layout,
- structured patches.

### Phase 5 — GitHub

- GitHub App,
- repository indexing,
- Repository Agent,
- repository-to-deck flow.

### Phase 6 — Motion

- basic presets,
- sequencing,
- motion panel/timeline.

### Phase 7 — Critic + Export

- Critic Agent,
- PDF,
- PPTX,
- warnings.

### Phase 8 — Hardening

- testing,
- performance,
- permissions,
- telemetry,
- onboarding.

---

## 38. MVP Milestone Definition

A release qualifies as MVP when a user can:

1. create an account,
2. create a project,
3. create a blank or AI deck,
4. connect a GitHub repository,
5. generate a repository-grounded story,
6. generate editable slides,
7. manually edit objects,
8. ask AI to modify one slide or selection,
9. undo an AI change,
10. add simple animations,
11. present in the browser,
12. export to PDF and PPTX.

---

## 39. Technical Decisions to Lock Early

Lock early:
- canonical schema,
- stable element IDs,
- patch semantics,
- logical coordinate system,
- theme token model,
- GitHub App permission model.

Keep flexible:
- LLM provider,
- animation library,
- exact CSS framework,
- vector DB,
- queue implementation,
- desktop wrapper details.

---

## 40. Core Architectural Rule

> Build the presentation model and editing engine as reusable product infrastructure; treat AI, GitHub, export formats, and desktop packaging as clients/adapters around that core.
