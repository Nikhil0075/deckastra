# `.mydeck` Presentation Schema Specification

**Document type:** Core document model specification
**Status:** Foundation / Draft v1.1 (expanded)
**Supersedes:** Draft v1.0
**Schema version described:** `1.0.0`
**Purpose:** Define the canonical internal representation of a Deckastra presentation.

**Related documents**
- `01_PRODUCT_REQUIREMENTS_AND_USER_JOURNEYS.md`
- `03_AGENT_ARCHITECTURE_LANGGRAPH.md`
- `04_CANVAS_RENDERING_ANIMATION_ENGINE.md`
- `05_MVP_SYSTEM_REPOSITORY_ARCHITECTURE.md`

**What changed in v1.1**

Section numbering §1–§39 is unchanged, so existing cross-references from the other documents remain valid.

| Change | Section | Register item |
| --- | --- | --- |
| Added conventions, identifier rules, and primitive types | **§0** (new) | S2 — undefined types |
| Declared the `PresentationElement` union | §8.6 | **S1** |
| Wired `ContainerLayout` into `GroupElement`; added `resizeMode` | §16.2 | **S1** |
| Added the component and variable system | **§40** (new) | **S1** |
| Removed `Slide.order`; defined single ordering authority and `zIndex` precedence | §7.2, §8.4 | **S1** |
| Defined id-addressed patch path grammar; added `test` and `copy` | §31.3 | **S1** |
| Replaced `DataBinding.transform` string with a declarative allowlist | §29.5 | **S1** |
| Defined `RichTextDocument` as blocks + spans | §12.1 | S2 |
| Added `IconElement`, `TableElement`, `VideoElement`, `AudioElement`, `WebEmbedElement` | §19 | S2 |
| Expanded theme tokens; unified `fontFamily` naming | §22 | S2 |
| `AssetReference.uri` → `storageKey` | §28.1 | S2 |
| Defined the canonical transaction lineage (`PatchOperation` → `Patch` → `Transaction`) | §31 | Cross-cutting #2 |
| Defined package ↔ in-memory serialization mapping | **§41** (new) | S2 |
| Full validation rule catalog with codes | **§42** (new) | S3 |
| Clarified animation timing, keyframe offsets, and conflict rules | §24.4–§24.6 | S3 |
| Reconciled the MVP element list with doc 01 | §37.1 | S2 |

---

## 0. Conventions and Primitives

Everything below is referenced by later sections. It exists so that no section defines a type twice and no section references a type that does not exist.

### 0.1 Reading conventions

- Types are written as TypeScript. TypeScript is the normative form; Zod schemas and JSON Schema are generated from it (§34.4).
- `?` means optional. Optional does not mean unspecified — every optional property below states its default.
- All lengths, sizes, and coordinates are **logical presentation pixels** (§6), expressed as bare numbers. Never `"12px"` strings.
- All durations are **milliseconds**, integers.
- All angles are **degrees**, clockwise positive.
- All timestamps are **ISO 8601 UTC strings** (`2026-09-05T00:00:00Z`).
- Normalized values (`0..1`) are used for offsets, opacity, and focal points.

### 0.2 Identifiers

```ts
type Id = string;   // "{prefix}_{ULID}"  e.g. "el_01JB8Z9K2QW4RN7F3XG5HTMD6A"
```

| Prefix | Applies to |
| --- | --- |
| `doc_` | `PresentationDocument` |
| `sld_` | `Slide` |
| `el_` | any `PresentationElement`, including group children |
| `anm_` | `AnimationTrack` |
| `clp_` | `AnimationClip` |
| `ast_` | `AssetReference` |
| `cmp_` | `ComponentDefinition` |
| `src_` | `DataSourceDefinition` |
| `thm_` | `ThemeDefinition` |
| `txn_` | `Transaction` |
| `prv_` | `ProvenanceRecord` |

Rules:

1. **Unique within a document.** Duplicate ids are a validation error (`E001`).
2. **Stable forever.** An id is assigned at creation and never changes. Animations, constraints, connectors, provenance, and agent patches all reference elements by id; renaming or moving an element must not change it.
3. **Never reused.** A deleted element's id is not reassigned, so undo and history stay unambiguous.
4. **Generated with ULID**, not a counter and not a UUIDv4: 26 characters, Crockford base32, lexicographically sortable by creation time. Sortability makes diffs and logs readable; monotonic generation avoids collisions in a single session.
5. **Prefixes are advisory, not typed.** A validator may check that an `elements[]` entry starts with `el_`, but code must not parse ids for meaning beyond that.

Human-facing names (`Slide.name`, `BaseElement.name`) are free text and are not identifiers.

### 0.3 Geometry primitives

```ts
interface Point { x: number; y: number; }
interface Size  { width: number; height: number; }
interface Rect  { x: number; y: number; width: number; height: number; }

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type Normalized = number;   // 0..1, clamped by the validator
```

### 0.4 Color and paint

```ts
/**
 * Either a theme token reference or a literal color.
 * Token form: "token:colors.accent" — resolved against ThemeDefinition (§22).
 * Literal form: "#RRGGBB", "#RRGGBBAA", or "rgb()/hsl()" CSS strings.
 */
type ColorValue = string;

interface GradientStop {
  offset: Normalized;
  color: ColorValue;
}

type Paint =
  | { type: "none" }
  | { type: "solid"; color: ColorValue }
  | { type: "linearGradient"; stops: GradientStop[]; angle: number }
  | { type: "radialGradient"; stops: GradientStop[]; center?: Point; radius?: number }
  | { type: "image"; assetId: Id; fit?: ImageFit; opacity?: Normalized };
```

**Prefer tokens over literals.** A deck built from `token:` references re-themes cleanly; one built from hex values does not. The Critic Agent should flag literal colors that have a near-equivalent token (§42, rule `W203`).

### 0.5 Stroke, shadow, corners, filters

```ts
interface StrokeStyle {
  paint: Paint;
  width: number;                 // logical px, default 1
  align?: "inside" | "center" | "outside";   // default "center"
  dash?: number[];               // e.g. [6, 4]; omit for solid
  dashOffset?: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
}

interface ShadowStyle {
  type: "drop" | "inner";
  offsetX: number;
  offsetY: number;
  blur: number;
  spread?: number;
  color: ColorValue;
}

type CornerRadius =
  | number
  | { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };

type VisualFilter =
  | { type: "blur"; radius: number }
  | { type: "brightness"; amount: number }
  | { type: "contrast"; amount: number }
  | { type: "saturate"; amount: number }
  | { type: "grayscale"; amount: Normalized }
  | { type: "sepia"; amount: Normalized };
```

Filters are declared in the schema but are **export-constrained**: PPTX cannot represent most of them and will rasterize (doc 04 §33.2). The schema permits them; adapters report degradation.

### 0.6 Time and easing

```ts
type Milliseconds = number;

/**
 * Named easings resolve through one canonical table shared by the animation
 * runtime and every export adapter (doc 04 §22.3).
 * Custom form: "cubic-bezier(0.2,0,0,1)"
 * Spring form: "spring(stiffness,damping,mass)" — sampled to keyframes at build time.
 */
type Easing =
  | "linear" | "easeIn" | "easeOut" | "easeInOut" | "emphasized"
  | `cubic-bezier(${string})`
  | `spring(${string})`;
```

### 0.7 Fit modes and alignment

```ts
type ImageFit = "cover" | "contain" | "fill" | "none";
type HorizontalAlign = "left" | "center" | "right" | "justify";
type VerticalAlign = "top" | "middle" | "bottom";
```

### 0.8 Forward compatibility rule

A reader encountering an unknown property, unknown element `type`, or unknown enum value **must preserve it on round-trip** and must not drop it during serialization.

This is what allows a newer client to add a property, an older client to open and save the same deck, and the newer client to still find its property intact. Renderers skip what they cannot draw and mark the element `unsupported`; they never delete it.

The single exception is a document whose `schemaVersion` major exceeds the reader's supported major — that is refused outright (§35.4), because forward-compatible *reading* is not the same as forward-compatible *editing*.

### 0.9 Size limits

| Limit | Value | Rationale |
| --- | --- | --- |
| Slides per document | 300 | Beyond this the editor's slide strip and version diffs degrade |
| Elements per slide | 800 | Renderer budget (doc 04 §31.1) |
| Group nesting depth | 8 | Transform-math readability; deeper is almost always accidental |
| Document JSON size | 12 MB | Excludes assets, which are referenced not embedded |
| Text content per element | 20 000 characters | A slide is not a document |
| Animation clips per slide | 200 | Timeline usability |

Limits are validation warnings at 80% and errors at 100%.

---

## 1. Why a Custom Presentation Model Is Required

Deckastra does not use PPTX, HTML, canvas state, or a rendered image as its internal source of truth.

The internal model must support semantic presentation structure, editable slide objects, rich layouts, reusable components, constraints, themes, data bindings, animation timelines, interactions, agent operations, version history, and multiple render targets.

The model must remain stable even if rendering libraries, animation libraries, LLM providers, or export adapters change.

### 1.1 What each rejected alternative costs

| Candidate source of truth | Why it fails |
| --- | --- |
| **PPTX** | Cannot express semantic roles, constraints, container layouts, data bindings, or timeline animation. Editing it means editing XML through a lossy library. Its animation model is weaker than the product requires. |
| **HTML/CSS** | No stable object identity, no separation of content from layout, no clean patch surface. "Make the headline larger" becomes a CSS cascade problem rather than a property change. |
| **Canvas/scene state** | Geometry without meaning. An agent cannot answer "which element is the headline" without inferring it from font size — the exact failure doc 01 §3.6 identifies. |
| **Rendered images** | Not editable. Any AI edit becomes regeneration, which is doc 01 §3.2's core complaint about existing tools. |
| **Markdown** | Expressive enough for text, nowhere near enough for design, motion, or diagrams. Useful as an *import* source only (§36). |

### 1.2 The working file identity

The working file identity is `.mydeck`. A `.mydeck` artifact can be:

- a JSON document during early development,
- a directory-based project,
- or a packaged archive containing manifest + assets.

All three carry the same logical content; §41 defines the mapping between them.

---

## 2. Design Goals

The schema must be:

1. **Serializable** — JSON-compatible throughout. No functions, no class instances, no circular references, no `undefined` (omit the key instead).
2. **Deterministic** — the same model renders to the same output, given the same fonts (doc 04 §2.2).
3. **Versioned** — schema migrations are possible in both directions within a major version.
4. **Semantic** — elements carry roles and intent, not only geometry.
5. **Patchable** — agents modify small parts safely, addressed by id.
6. **Render-agnostic** — no dependency on React, GSAP, Motion, Konva, or any runtime.
7. **Export-friendly** — adapters can map the model to PPTX/PDF/video/web.
8. **Composable** — reusable components with parameters and overrides (§40).
9. **Inspectable** — a human can read the JSON and understand the slide.
10. **Extensible** — new element types and properties can be added without breaking existing documents (§0.8).

### 2.1 Goals in tension, and how they resolve

| Tension | Resolution |
| --- | --- |
| Semantic richness vs. simplicity | Semantic fields are optional. A minimal valid element has `id`, `type`, `transform`. Everything else earns its place. |
| Expressiveness vs. export fidelity | The schema is deliberately more expressive than PPTX. Adapters degrade and report (doc 04 §32.2); the model does not shrink to the weakest target. |
| Determinism vs. flexibility | Anything non-deterministic (layout algorithms, text fitting) is specified with fixed iteration counts and quantized outputs rather than banned. |
| Human-readable vs. compact | Readable wins. Documents are gzip-compressed in transit and storage; verbose property names cost nothing in practice and save hours of debugging. |

### 2.2 Explicit non-goals

- Not a general vector graphics format. Boolean path operations, mesh gradients, and brush engines are out.
- Not a document format. No page flow, no footnotes, no cross-references.
- Not a programming environment. There is no expression language anywhere in the schema — bindings use a declarative allowlist (§29.5), components use parameter bindings (§40.3). This is a security decision as much as a simplicity one, since a `.mydeck` file is shareable.

---

## 3. Package Structure

A packaged `.mydeck`:

```text
example.mydeck/
├── manifest.json
├── presentation.json
├── theme.json
├── animations.json
├── components.json
├── data/
├── assets/
│   ├── images/
│   ├── video/
│   ├── audio/
│   └── fonts-ref/
└── metadata/
    ├── sources.json
    └── versions.json
```

For MVP, the application stores the same logical structures in PostgreSQL and object storage rather than as a physical package. §41 defines exactly how the split form and the single-document form map onto each other, so the two never drift.

---

## 4. Canonical Top-Level Type

```ts
export interface PresentationDocument {
  schemaVersion: string;                       // semver, e.g. "1.0.0"
  id: Id;                                      // "doc_..."
  metadata: PresentationMetadata;              // §5
  viewport: PresentationViewport;              // §6
  theme: ThemeDefinition;                      // §22
  slides: Slide[];                             // §7 — array order is authoritative
  assets: AssetReference[];                    // §28
  components: ComponentDefinition[];           // §40
  dataSources: DataSourceDefinition[];         // §29
  variables: Record<string, VariableDefinition>; // §40.6
  provenance?: ProvenanceRecord[];             // §30
  createdAt: string;
  updatedAt: string;

  /** Preserved verbatim across round-trips (§0.8). */
  extensions?: Record<string, unknown>;
}
```

### 4.1 What is deliberately absent

| Not in the document | Where it lives instead |
| --- | --- |
| Editor camera, zoom, pan | Editor state (doc 04 §5.3) |
| Selection, hover, isolation | Editor state |
| Rendered geometry, text metrics, resolved matrices | `IntermediateScene` (doc 04 §7) |
| Signed asset URLs | Resolved at render time from `storageKey` (§28.1) |
| User identity beyond author ids | `users` table (doc 05 §21) |
| Undo stack | Session memory + `transactions` table |
| Comments | Separate collaboration store (V2) |

A field belongs in the document if and only if two users opening the same deck must agree on it.

### 4.2 Invariants

1. `slides` may be empty; a zero-slide deck is valid (a new project).
2. Every `Id` referenced anywhere resolves to something in this document, except `assets[].storageKey` which resolves externally.
3. `updatedAt >= createdAt`.
4. `schemaVersion` is present and parseable, always.

---

## 5. Presentation Metadata

```ts
export interface PresentationMetadata {
  title: string;
  description?: string;
  authorIds?: string[];
  language?: string;                    // BCP-47, e.g. "en-IN"; default "en"
  tags?: string[];
  presentationType?:
    | "technical" | "pitch" | "business-review" | "training"
    | "conference" | "education" | "marketing" | "custom";
  audience?: string;
  objective?: string;
  estimatedDurationSeconds?: number;
  sourceProjectId?: string;
}
```

### 5.1 Why `audience` and `objective` are first-class

They are not decoration. Every agent reads them:

| Field | Consumed by |
| --- | --- |
| `audience` | Story Agent (vocabulary, assumed expertise), Critic (density judgement) |
| `objective` | Story Agent (narrative arc), Critic (narrative clarity score) |
| `presentationType` | Creative Director (visual system defaults), template selection |
| `estimatedDurationSeconds` | Story Agent (slide count), Motion Agent (timing budget) |
| `language` | Text measurement cache key, line-breaking rules (doc 04 §17.7) |

An untitled deck with no audience and no objective forces every agent to guess, and guessing is what produces generic output.

### 5.2 Example

```json
{
  "title": "AgentSphere SecureOps",
  "presentationType": "technical",
  "audience": "Hackathon judges",
  "objective": "Explain the architecture and demonstrate verifiable AI security operations",
  "estimatedDurationSeconds": 600,
  "language": "en"
}
```

---

## 6. Viewport Model

```ts
export interface PresentationViewport {
  width: number;
  height: number;
  unit: "px";
  aspectRatio?: string;                 // derived; stored for readability
  safeArea?: Insets;
}
```

Recommended default:

```json
{ "width": 1920, "height": 1080, "unit": "px", "aspectRatio": "16:9",
  "safeArea": { "top": 80, "right": 120, "bottom": 80, "left": 120 } }
```

### 6.1 Presets

| Preset | Size | Use |
| --- | --- | --- |
| `16:9` | 1920 × 1080 | Default; screens, projectors, PPTX widescreen |
| `16:10` | 1920 × 1200 | Some laptop displays |
| `4:3` | 1440 × 1080 | Legacy projectors, PPTX standard |
| `A4 landscape` | 1123 × 794 | Print-first handouts |
| `1:1` | 1080 × 1080 | Social export |
| custom | any | Advanced |

### 6.2 Changing the viewport

Changing `viewport` on an existing deck is a **high-risk operation** (doc 03 §17). Elements do not move; the canvas changes size around them, so content can fall outside the slide or the safe area.

Required behaviour: produce a `LayoutValidation` report (doc 04 §16.4) *before* applying, listing every element that would be out of bounds, and offer three strategies — leave, scale proportionally, or re-run the Layout Agent. Never apply silently.

### 6.3 Safe area

`safeArea` is advisory geometry, not a clip region. Nothing is cut off by it. It exists so that:

- snapping has margin targets (doc 04 §14.1),
- the Layout Agent has a content region rather than the full bleed,
- the Critic can flag text too close to the edge,
- backgrounds and hero images can intentionally break out of it.

---

## 7. Slide Model

```ts
export interface Slide {
  id: Id;                               // "sld_..."
  name?: string;
  semanticIntent?: string;
  keyMessage?: string;
  background?: BackgroundDefinition;    // §7.3
  layout?: SlideLayoutMetadata;         // §7.4
  elements: PresentationElement[];      // array order = z-order base (§8.4)
  animations?: AnimationTrack[];        // §24
  transition?: SlideTransition;         // §26
  interactions?: Interaction[];         // §27
  speakerNotes?: RichTextDocument | string;
  hidden?: boolean;                     // default false
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}
```

### 7.1 `semanticIntent` and `keyMessage`

`semanticIntent` explains *why the slide exists*. `keyMessage` is the one thing the audience should retain.

```json
{
  "semanticIntent": "Explain how security evidence moves through the six-agent workflow",
  "keyMessage": "AI decisions are checked by deterministic policy and independently verified"
}
```

These drive the Story, Layout, Motion, and Critic agents. A slide with a `keyMessage` and no matching prominent element is a hierarchy failure the Critic can detect mechanically.

### 7.2 Ordering — `order` removed

**v1.0 defined `Slide.order: number`. v1.1 removes it.**

Reason: two sources of truth. Slides live in an array *and* carried an `order` field, so a reorder had to update N fields, and any disagreement between array position and `order` was undefined behaviour.

**Rule: array position in `slides[]` is the sole authority for slide order.**

Consequences:

- Reordering is a `move` patch operation, not N `replace` operations.
- Slide numbering shown to the user is derived (`index + 1`), skipping `hidden` slides in present mode but not in the editor.
- Migration `1.0.0 → 1.0.1` sorts by the old `order` field, then deletes it (§35.3).

### 7.3 Background

```ts
export interface BackgroundDefinition {
  paint?: Paint;                        // §0.4
  assetId?: Id;                         // convenience for a full-bleed image
  fit?: ImageFit;
  focalPoint?: Point;                   // normalized
  overlay?: Paint;                      // scrim above the image, below content
  blur?: number;
}
```

The overlay exists because full-bleed photography under text almost always needs a scrim, and encoding it as a separate rectangle element makes it a selectable object the user deletes by accident.

### 7.4 Layout metadata

```ts
export interface SlideLayoutMetadata {
  templateId?: string;                  // which layout pattern produced this slide
  styleLabel?: string;                  // "asymmetric editorial", "centered hero"
  contentRegion?: Rect;                 // authored content area, defaults to safeArea
  gridColumns?: number;                 // default from theme.grid
  locked?: boolean;                     // layout agent may not restructure this slide
}
```

`locked: true` is the user's way of saying "I arranged this by hand, leave it alone." Agents must honour it: a locked slide can have its *content* edited but not its composition, and a broad restyle skips it.

### 7.5 Speaker notes

Notes accept a `RichTextDocument` (§12.1) or a plain string. Rich notes matter more than they look: they carry presenter emphasis, and later they carry timing markers referenced by the animation timeline (doc 04 §25.4).

---

## 8. Base Element Contract

```ts
export interface BaseElement {
  id: Id;                               // "el_..."
  type: ElementType;
  name?: string;                        // user-facing layer name
  semanticRole?: SemanticRole;          // §9
  transform: Transform;                 // §10
  style?: CommonStyle;                   // §11
  opacity?: Normalized;                 // default 1
  visible?: boolean;                    // default true
  locked?: boolean;                     // default false
  zIndex?: number;                      // override; see §8.4
  constraints?: LayoutConstraint[];     // §20
  bindings?: DataBinding[];             // §29
  metadata?: ElementMetadata;           // §8.5
  extensions?: Record<string, unknown>;
}
```

### 8.1 Element types

```ts
export type ElementType =
  | "text" | "shape" | "line" | "image" | "icon" | "group"
  | "chart" | "diagram" | "table" | "code"
  | "video" | "audio" | "webEmbed" | "componentInstance";
```

### 8.2 `visible` vs `hidden` vs `opacity: 0`

Three different things, deliberately:

| State | Rendered | Selectable | Exported | Use |
| --- | --- | --- | --- | --- |
| `visible: false` | no | via layers panel only | no | Author is hiding a variant |
| `opacity: 0` | yes, transparent | yes | yes (invisible) | Animation start state, deliberate fade |
| `locked: true` | yes | via layers panel only | yes | Background art the author does not want to grab |

An animation that fades an element in must not set `visible: false` as its start state, because the element would be excluded from layout and export. It sets `opacity: 0`.

### 8.3 `name`

Optional and free text, but the editor should always synthesize one (`"Headline"`, `"Image 3"`) so the layers panel is usable and so PPTX export can emit stable shape names for Morph pairing (doc 04 §33.3).

### 8.4 Z-order — single authority

**Rule: position in the parent's `elements[]` (or `children[]`) array is the base z-order, ascending. Later in the array paints on top.**

`zIndex` is an optional override for the uncommon case where an author wants an element pinned above or below its siblings without reordering the array.

```text
sortKey(el) = [ el.zIndex ?? arrayIndex(el), arrayIndex(el) ]
sort ascending, lexicographic
```

Ties break on array index, so ordering is always total and always stable. Groups create a stacking context: a child can never paint outside its group's z-band (doc 04 §8.3).

Consequences for editing: "bring to front" is an array `move` operation, not a `zIndex` increment. Reserving `zIndex` for overrides keeps it from becoming the drifting parallel ordering that `Slide.order` was.

### 8.5 Element metadata

```ts
export interface ElementMetadata {
  createdBy?: "user" | "agent" | "import" | "template";
  agentId?: string;
  sourceIds?: Id[];                     // provenance records (§30)
  replacesId?: Id;                      // set when an agent substitutes an element
  notes?: string;
  altText?: string;                     // accessibility; also used for image/chart/diagram
  doNotEdit?: boolean;                  // agents skip this element
  [key: string]: unknown;
}
```

`replacesId` matters more than it looks: it lets the editor remap selection after an agent transaction (doc 04 §10.4), so a user who had an element selected does not lose their selection when the AI swaps it.

### 8.6 The element union — **new in v1.1**

v1.0 referenced `PresentationElement[]` in `Slide.elements` and `GroupElement.children` without ever declaring it. The union is now explicit, which is what makes `ElementType` discriminate and makes generated validators possible.

```ts
export type PresentationElement =
  | TextElement              // §12
  | ShapeElement             // §13
  | LineElement              // §14
  | ImageElement             // §15
  | IconElement              // §19.1
  | GroupElement             // §16
  | ChartElement             // §17
  | DiagramElement           // §18
  | TableElement             // §19.2
  | CodeElement              // §19.3
  | VideoElement             // §19.4
  | AudioElement             // §19.5
  | WebEmbedElement          // §19.6
  | ComponentInstanceElement // §40.4
  | UnknownElement;          // §8.7
```

The discriminant is `type`. Every member extends `BaseElement` and narrows `type` to a single literal.

### 8.7 Unknown elements

```ts
export interface UnknownElement extends BaseElement {
  type: string;                         // an ElementType this reader does not know
  [key: string]: unknown;
}
```

Required by §0.8. A reader that meets an element type from a newer schema keeps it intact, renders a labelled placeholder at its transform, and refuses to let agents modify it. Without this, opening a deck in an older client silently deletes content.

---

## 9. Semantic Roles

Semantic roles make the document understandable to AI and to deterministic layout rules.

```ts
export type SemanticRole =
  | "headline" | "subtitle" | "body" | "caption" | "quote" | "metric"
  | "eyebrow" | "footer" | "pageNumber"
  | "heroVisual" | "supportingVisual"
  | "primaryChart" | "secondaryChart"
  | "mainDiagram" | "supportingDiagram"
  | "callout" | "evidence" | "logo"
  | "navigation" | "decoration" | "custom";
```

### 9.1 What roles buy

Roles let instructions be expressed against meaning rather than geometry:

| Instruction | Without roles | With roles |
| --- | --- | --- |
| "Increase headline dominance" | LLM infers the title from font size and position | Target `semanticRole: "headline"` directly |
| "Make this slide less dense" | Guess which elements are secondary | Reduce `body` and `caption`, protect `keyMessage` carriers |
| "Animate the diagram after the title" | Guess which object is the diagram | Target `mainDiagram` |
| Contrast checking | Check every pair | Check text roles against their backgrounds |
| Overlap detection | Flag all intersections | Ignore `decoration` overlaps (doc 04 §16.4) |
| PPTX export | Generic shape names | Map `headline` → title placeholder |

### 9.2 Rules

1. At most one `headline` per slide. A second is a validation warning (`W101`).
2. `decoration` elements are excluded from overlap checks, tab order, and screen-reader output.
3. `metric` elements are expected to contain a number and are the natural targets for `numberCount` animation.
4. Roles are advisory for rendering and authoritative for agent targeting. Changing a role never changes appearance.

### 9.3 Example

```json
{ "id": "el_01JB8Z...", "type": "text", "semanticRole": "headline" }
```

---

## 10. Transform Model

```ts
export interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;                    // degrees, default 0
  scaleX?: number;                      // default 1
  scaleY?: number;                      // default 1
  originX?: Normalized;                 // default 0.5
  originY?: Normalized;                 // default 0.5
}
```

### 10.1 Coordinate convention

- Origin `(0,0)` is the slide's top-left.
- `x` increases right, `y` increases downward.
- `x, y` locate the element's **unrotated** top-left corner in its parent's coordinate space.
- Rotation and scale are applied about `(originX, originY)` expressed as a fraction of the element's own box.
- Dimensions are logical presentation pixels.

### 10.2 Scale vs. size

`width`/`height` and `scaleX`/`scaleY` are both present and mean different things:

| | Changes layout | Changes text size | Typical source |
| --- | --- | --- | --- |
| `width`/`height` | yes | no (box only) | Resize handles |
| `scaleX`/`scaleY` | no (visual only) | yes (everything scales) | Animation, group scaling, flip |

A resize handle drag changes `width`/`height`. An animation changing apparent size changes `scale`. Keeping them separate means an animation never corrupts the authored layout, and resetting `scale` to 1 always restores it.

Flip is `scaleX: -1` (doc 04 §12.6), not a separate property.

### 10.3 Nesting

A child of a group expresses its transform in the **group's** coordinate space, not the slide's. World transforms are composed by the renderer (doc 04 §8.2) and are never persisted.

### 10.4 Numeric hygiene

- Persist geometry rounded to 2 decimals.
- `width`, `height` ≥ 1; zero-size elements break hit testing and matrix inversion.
- `NaN` and `Infinity` are validation errors (`E006`).
- `rotation` normalized to `[0, 360)` on commit.

---

## 11. Common Style

```ts
export interface CommonStyle {
  fill?: Paint;                         // §0.4
  stroke?: StrokeStyle;                 // §0.5
  shadow?: ShadowStyle[];               // §0.5, applied in array order
  cornerRadius?: CornerRadius;          // §0.5
  blendMode?: BlendMode;
  filters?: VisualFilter[];             // §0.5
  backdropFilters?: VisualFilter[];     // applied to what is behind the element
}

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay"
  | "darken" | "lighten" | "colorDodge" | "colorBurn"
  | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
```

### 11.1 Export constraints

| Property | PDF | PPTX | Note |
| --- | --- | --- | --- |
| `fill` solid/gradient | full | full | — |
| `stroke` incl. dash | full | full | — |
| `shadow` | full | approximated | PPTX has one outer shadow per shape |
| `cornerRadius` uniform | full | full | — |
| `cornerRadius` per-corner | full | rasterized | No DrawingML equivalent |
| `blendMode` | partial | rasterized | — |
| `filters` | rasterized | rasterized | — |
| `backdropFilters` | rasterized | rasterized | Also unsupported in some browsers |

The schema permits all of them. Adapters degrade and report (doc 04 §32.2). The document does not shrink to the weakest target.

---

## 12. Text Element

```ts
export interface TextElement extends BaseElement {
  type: "text";
  content: RichTextDocument;            // §12.1
  typography: TypographyStyle;          // §12.2 — element defaults
  paragraph?: ParagraphStyle;           // §12.3 — element defaults
  fit?: TextFit;                        // §12.4, default "fixed"
  minFontSize?: number;                 // shrinkToFit floor, default max(12, fontSize*0.5)
  maxFontSize?: number;
  overflowBehavior?: "visible" | "clip" | "ellipsis";   // default "visible"
  padding?: Insets;
  verticalAlign?: VerticalAlign;        // default "top"
  direction?: "ltr" | "rtl" | "auto";   // default "auto" from metadata.language
}
```

### 12.1 `RichTextDocument` — defined in v1.1

v1.0 said this "can initially be a simple string plus spans" and the example document used `{ "text": "..." }`. That defers a migration onto every stored deck the moment inline styling ships. The shape is therefore fixed now, even though MVP may only ever populate one span per block.

```ts
export interface RichTextDocument {
  version: 1;
  blocks: TextBlock[];
}

export interface TextBlock {
  id: Id;
  type: "paragraph" | "bullet" | "numbered" | "quote" | "heading";
  indentLevel?: number;                 // 0..4, default 0
  spans: TextSpan[];
  style?: Partial<ParagraphStyle>;      // overrides the element's paragraph style
  listMarker?: string;                  // custom bullet glyph
}

export interface TextSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  color?: ColorValue;
  highlight?: ColorValue;
  link?: string;
  fontFamily?: string;                  // rare; prefer inheriting
  fontWeight?: number;
  fontSizeScale?: number;               // relative to element fontSize, default 1
  variableRef?: string;                 // renders a variable's value (§40.6)
}
```

**Why `fontSizeScale` rather than an absolute per-span size.** Shrink-to-fit (doc 04 §17.3) multiplies one number and every span keeps its relative emphasis. With absolute span sizes, resizing the box destroys the typographic hierarchy inside it. The same applies when a theme changes its type scale.

**Why spans carry `variableRef`.** "Prepared for {{client}}" must survive re-theming, translation, and shrink-to-fit as a single text run, not as three concatenated elements.

Minimal valid content:

```json
{
  "version": 1,
  "blocks": [
    { "id": "blk_01JB8Z...", "type": "paragraph",
      "spans": [{ "text": "Autonomous Data Migration Control Tower" }] }
  ]
}
```

### 12.2 Typography

```ts
export interface TypographyStyle {
  fontFamily: string;                   // family name or "token:typography.heading.fontFamily"
  fontSize: number;                     // logical px
  fontWeight?: number;                  // 100..900, default 400
  fontStyle?: "normal" | "italic";      // default "normal"
  lineHeight?: number;                  // multiplier, default 1.3
  letterSpacing?: number;               // logical px, default 0
  color?: ColorValue;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  textDecoration?: "none" | "underline" | "lineThrough";
  fontFeatures?: string[];              // OpenType, e.g. ["tnum", "ss01"]
  fontVariationSettings?: Record<string, number>;   // variable fonts
}
```

`fontFeatures` is not a nicety: tabular numerals (`tnum`) are what stop a `numberCount` animation from making the whole slide jitter as digit widths change.

**Naming note.** v1.0 used `typography.heading.family` in the theme and `typography.fontFamily` on elements. v1.1 uses `fontFamily`/`fontSize`/`fontWeight` in both places (§22.3), so a theme token and an element property are directly assignable.

### 12.3 Paragraph

```ts
export interface ParagraphStyle {
  align?: HorizontalAlign;              // default "left"
  verticalAlign?: VerticalAlign;        // default "top"
  listStyle?: "none" | "bullet" | "numbered";
  paragraphSpacing?: number;            // px after each block, default 0
  paragraphSpacingBefore?: number;
  indent?: number;
  hangingIndent?: number;
  lineBreakStrategy?: "auto" | "balanced" | "strict";
}
```

`"balanced"` maps to CSS `text-wrap: balance` and is the right default for headlines — it prevents the single-orphan-word last line that makes AI-generated titles look unconsidered.

### 12.4 Fit modes

```ts
export type TextFit = "fixed" | "autoHeight" | "shrinkToFit" | "growBox";
```

| Mode | Width | Height | Font size |
| --- | --- | --- | --- |
| `fixed` | fixed | fixed | fixed |
| `autoHeight` | fixed | derived from content | fixed |
| `shrinkToFit` | fixed | fixed | reduced to `minFontSize` floor |
| `growBox` | grows to `maxWidth` | derived | fixed |

The algorithm is specified in doc 04 §17.3, including the 0.25 px quantization that keeps results stable across runs.

**Guidance for the Layout Agent:** use `autoHeight` for body text (content length varies), `shrinkToFit` for headlines in fixed hero regions, `fixed` only when overflow is genuinely acceptable.

---

## 13. Shape Element

```ts
export interface ShapeElement extends BaseElement {
  type: "shape";
  shape: ShapeKind;
  pathData?: string;                    // SVG path, required when shape === "customPath"
  points?: number;                      // star/polygon point count
  innerRadius?: Normalized;             // star
  arrowhead?: { start?: MarkerKind; end?: MarkerKind };
  text?: RichTextDocument;              // optional label inside the shape
  textPadding?: Insets;
}

export type ShapeKind =
  | "rectangle" | "ellipse" | "triangle" | "diamond" | "pill"
  | "star" | "polygon" | "arrow" | "chevron" | "parallelogram"
  | "speechBubble" | "customPath";

export type MarkerKind = "none" | "arrow" | "openArrow" | "dot" | "square" | "diamond";
```

### 13.1 Shapes carry text

A shape with a label is one element, not a shape plus an overlapping text box. Two reasons: moving it is one operation rather than a group, and diagram nodes are exactly this — a labelled shape.

### 13.2 `customPath` constraints

`pathData` is an SVG path string restricted to `M L H V C S Q T A Z` commands in a **normalized 0..1 coordinate space**, scaled to the element's box at render time. Normalizing means resizing a custom shape does not require rewriting the path, and the same path survives a viewport change.

Path strings are untrusted input when they arrive from import or an agent: the validator rejects anything containing characters outside the path grammar (`E012`).

---

## 14. Line and Connector Element

```ts
export interface LineElement extends BaseElement {
  type: "line";
  from: Point | AnchorReference;        // §14.1
  to: Point | AnchorReference;
  waypoints?: Point[];                  // manual routing overrides
  routing?: "straight" | "orthogonal" | "curved";   // default "straight"
  startMarker?: MarkerKind;             // default "none"
  endMarker?: MarkerKind;               // default "none"
  label?: RichTextDocument;
  labelPosition?: Normalized;           // 0..1 along the path, default 0.5
}
```

### 14.1 Anchor references — defined in v1.1

```ts
export interface AnchorReference {
  elementId: Id;
  anchor: AnchorPoint;
  offset?: Point;                       // fine adjustment from the anchor
}

export type AnchorPoint =
  | "top" | "right" | "bottom" | "left"
  | "topLeft" | "topRight" | "bottomLeft" | "bottomRight"
  | "center"
  | "auto";                             // renderer picks the shortest sensible side
```

`"auto"` is the default an agent should emit. It lets the connector re-choose its side when either endpoint moves, which is what makes "add a node to the architecture diagram" not produce a tangle.

### 14.2 Anchor lifecycle

| Event | Behaviour |
| --- | --- |
| Anchored element moves | Connector re-routes automatically |
| Anchored element deleted | Endpoint converts to the last computed `Point`; connector survives; validation warning `W105` |
| Anchored element hidden | Connector hides too |
| Connector endpoint dragged onto an element | Converts `Point` → `AnchorReference` |
| Connector endpoint dragged to empty canvas | Converts `AnchorReference` → `Point` |

Deleting a node must never delete its connectors silently — the user loses work they did not ask to lose.

### 14.3 Line vs diagram

Deliberately two different things (doc 04 §20.5): a `LineElement` is a hand-drawn connector the user fully controls; a `DiagramElement` (§18) is a managed subgraph with automatic layout. A user who wants control uses connectors; a user who wants structure uses a diagram.

---

## 15. Image Element

```ts
export interface ImageElement extends BaseElement {
  type: "image";
  assetId: Id;
  fit: ImageFit;                        // default "cover"
  crop?: CropDefinition;                // §15.1
  focalPoint?: Point;                   // normalized, default {0.5, 0.5}
  altText?: string;
  mask?: MaskDefinition;                // §15.2
  placeholder?: "blurhash" | "color" | "none";   // default "blurhash"
}
```

### 15.1 Crop

```ts
export interface CropDefinition {
  x: Normalized;                        // all four normalized to the SOURCE image
  y: Normalized;
  width: Normalized;
  height: Normalized;
  rotation?: number;
}
```

Normalized to the source, not to pixels, so replacing a 1200 px image with a 4000 px version of the same picture keeps the crop valid.

### 15.2 Mask

```ts
export type MaskDefinition =
  | { type: "rounded"; radius: CornerRadius }
  | { type: "ellipse" }
  | { type: "path"; pathData: string }          // normalized 0..1, as §13.2
  | { type: "shapeRef"; elementId: Id };
```

### 15.3 "Replace image, keep layout"

An explicit product requirement for AI edits (doc 04 §19.2). The contract, stated here because it is a schema-level guarantee:

Replacing `assetId` **preserves** `transform`, `fit`, `mask`, `style`, and `semanticRole`; **resets** `crop` (a crop rect from a different image is meaningless) and `focalPoint` (to the new asset's detected focal point, or center).

```json
[
  { "op": "replace", "path": "/slides/id:sld_04/elements/id:el_12/assetId", "value": "ast_01JB..." },
  { "op": "remove",  "path": "/slides/id:sld_04/elements/id:el_12/crop" }
]
```

---

## 16. Group Model

```ts
export interface GroupElement extends BaseElement {
  type: "group";
  children: PresentationElement[];      // array order = z-order base within the group
  groupRole?: string;                   // "titleBlock", "kpiRow", "architectureCluster"
  containerLayout?: ContainerLayout;    // §21 — NEW in v1.1
  resizeMode?: GroupResizeMode;         // NEW in v1.1
  clipContent?: boolean;                // default false
  padding?: Insets;                     // used when containerLayout is set
}

export type GroupResizeMode = "scaleChildren" | "resizeContainer";
```

### 16.1 Groups are first-class

Examples: title block, architecture cluster, KPI card group, footer group. AI instructions target a group as a meaningful unit — "stagger the agent cluster" is one id, not five.

### 16.2 Container layout wiring — the v1.0 gap

v1.0 defined `ContainerLayout` in §21 and attached it to nothing. Container layouts were therefore unreachable from a valid document, even though doc 04 §15.3 and the Layout Agent both depend on them.

`containerLayout` now lives on `GroupElement`. When present:

- children's `transform.x/y` become **advisory** — retained in the document (so pulling a child out of the container restores a sensible position) but ignored while the container is laying out;
- children's `width`/`height` are respected or stretched depending on `align`;
- `resizeMode` defaults to `resizeContainer` (re-run layout at the new size) rather than `scaleChildren`.

When `containerLayout` is absent or `type: "free"`, children are absolutely positioned and `resizeMode` defaults to `scaleChildren`.

**This is the mechanism that keeps AI-generated content robust.** Four KPI cards emitted as a horizontal container survive a longer label; the same four emitted as absolute boxes overlap.

### 16.3 Resize semantics

| Mode | Effect | Text |
| --- | --- | --- |
| `scaleChildren` | Multiply child geometry and font sizes by the scale factor | Scales by `min(sx, sy)`; boxes scale freely (doc 04 §12.4) |
| `resizeContainer` | Re-run container layout at the new size | Type sizes unchanged |

### 16.4 Nesting

Depth limit 8 (§0.9). A group may contain any element type including other groups and component instances.

---

## 17. Chart Model

Charts store data semantics separately from rendering.

```ts
export interface ChartElement extends BaseElement {
  type: "chart";
  chartType: ChartKind;
  data: ChartDataReference;             // §17.1
  encoding: ChartEncoding;              // §17.2
  chartStyle?: ChartStyle;              // §17.3
  altText?: string;
}

export type ChartKind =
  | "bar" | "column" | "line" | "area" | "pie" | "donut"
  | "scatter" | "stackedBar" | "stackedColumn" | "combo";
```

### 17.1 Data reference — defined in v1.1

```ts
export type ChartDataReference =
  | { type: "inline"; rows: Record<string, unknown>[] }
  | { type: "dataSource"; sourceId: Id; path?: string }
  | { type: "table"; elementId: Id };   // driven by a TableElement on the same slide
```

Inline data keeps a deck self-contained and portable — the default for AI-generated charts. `dataSource` is for live data (§29). `table` lets a visible table and a chart stay in sync, which is a common business-review pattern.

### 17.2 Encoding

```ts
export interface ChartEncoding {
  category: string;                     // field name for the categorical axis
  value: string | string[];             // one field, or several for multi-series
  series?: string;                      // field that splits rows into series
  color?: string;
  size?: string;                        // scatter
  sort?: { by: "category" | "value"; direction: "asc" | "desc" };
  aggregate?: "sum" | "avg" | "min" | "max" | "count";
  limit?: number;                       // top-N; remainder grouped as "Other"
}
```

```json
{ "chartType": "bar", "encoding": { "category": "team", "value": "incidents" } }
```

### 17.3 Chart style

```ts
export interface ChartStyle {
  palette?: ColorValue[];               // defaults to theme.chart.series
  showLegend?: boolean;
  legendPosition?: "top" | "right" | "bottom" | "left";
  showGridlines?: boolean;
  showDataLabels?: boolean;
  numberFormat?: NumberFormat;          // §29.5
  axisX?: AxisStyle;
  axisY?: AxisStyle;
  stacking?: "none" | "normal" | "percent";
  smoothing?: Normalized;               // line tension
}

export interface AxisStyle {
  title?: string;
  min?: number;
  max?: number;
  includeZero?: boolean;                // default true for bar/column
  tickCount?: number;                   // target, not exact; renderer picks "nice" values
  format?: NumberFormat;
  hidden?: boolean;
}
```

Axis domains must be computed from explicit rules rather than renderer heuristics, or the same chart gets different axes in the editor and in export (doc 04 §21.4).

### 17.4 What the renderer decides

Everything geometric: plot area, tick placement, label collision avoidance, legend layout. The document holds data and intent only. This is what makes the same chart render identically in a PNG, a PDF, and the editor.

---

## 18. Diagram Model

A diagram is not stored as SVG.

```ts
export interface DiagramElement extends BaseElement {
  type: "diagram";
  diagramType: DiagramKind;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  layoutHint?: DiagramLayoutHint;       // §18.3
  groups?: DiagramGroup[];              // §18.4 — boundaries/swimlanes
}

export type DiagramKind =
  | "flow" | "architecture" | "sequence" | "network" | "mindmap" | "timeline";
```

### 18.1 Nodes and edges

```ts
export interface DiagramNode {
  id: Id;
  label: string;
  sublabel?: string;
  role?: string;                        // "service", "datastore", "external", "actor"
  icon?: IconReference;                 // §19.1
  shape?: ShapeKind;
  rank?: number;                        // layout hint: pin to a layer
  position?: Point;                     // manual override; see §18.5
  style?: CommonStyle;
  data?: Record<string, unknown>;
  groupId?: Id;
}

export interface DiagramEdge {
  id: Id;
  from: Id;                             // node id
  to: Id;
  label?: string;
  direction?: "forward" | "reverse" | "both" | "none";   // default "forward"
  kind?: "solid" | "dashed" | "dotted";
  weight?: number;                      // thickness / emphasis
  style?: CommonStyle;
}
```

### 18.2 Why structure rather than geometry

Four capabilities depend on it:

1. **Layout can be recomputed** when a node is added, so the diagram stays tidy.
2. **Motion can be semantic** — "draw the edges out of the orchestrator" resolves to edge ids, not coordinates (doc 04 §20.6).
3. **Agents can edit meaning** — adding a node is one operation, not repositioning nine shapes.
4. **Export can degrade sensibly** — PPTX gets real shapes and connectors rather than a flat image.

### 18.3 Layout hint

```ts
export interface DiagramLayoutHint {
  algorithm?: "layered" | "radial" | "grid" | "force" | "manual";
  direction?: "TB" | "BT" | "LR" | "RL";       // default "LR" for architecture
  nodeSpacing?: number;
  rankSpacing?: number;
  alignRanks?: boolean;
  mode?: "managed" | "hybrid" | "manual";      // §18.5
  seed?: number;                               // required when algorithm === "force"
}
```

Layout must be deterministic (doc 04 §20.2): fixed iteration counts, document order for tie-breaking, no unseeded randomness. A diagram that lays out differently on each render produces spurious diffs and makes visual regression testing worthless.

### 18.4 Boundaries

```ts
export interface DiagramGroup {
  id: Id;
  label?: string;
  nodeIds: Id[];
  style?: CommonStyle;
  kind?: "boundary" | "swimlane" | "cluster";
}
```

Trust boundaries and swimlanes are what make an architecture diagram say something. Without them, every system diagram is an undifferentiated box-and-arrow field.

### 18.5 Managed vs manual positions

`mode` decides what happens to `DiagramNode.position`:

| Mode | Dragging a node | Relayout |
| --- | --- | --- |
| `managed` | Disabled, with an explanation | Always recomputed |
| `hybrid` | Sets `position` as a pin | Pinned nodes fixed, others flow around them |
| `manual` | Free | Never recomputed |

Default `hybrid`. Silently discarding a user's drag on the next relayout is the worst of the three outcomes and must not be a possible state.

---

## 19. Remaining Element Types

v1.0 listed `icon`, `table`, `video`, `audio`, and `webEmbed` in `ElementType` without defining any of them. `IconReference` was used by `DiagramNode` and never declared.

### 19.1 Icon

```ts
export interface IconElement extends BaseElement {
  type: "icon";
  icon: IconReference;
  color?: ColorValue;                   // monochrome tint
  strokeWidth?: number;                 // for stroke-based icon sets
}

export interface IconReference {
  set: string;                          // "lucide", "simple-icons", "custom"
  name: string;                         // "database", "shield-check"
  assetId?: Id;                         // required when set === "custom"
  variant?: "outline" | "filled" | "duotone";
}
```

Icons are a separate type rather than images because they are theme-tinted, resolution-independent, and searchable by name — which is what lets an agent request "a database icon" without generating one.

Custom icon SVGs are sanitized on ingestion (doc 04 §19.5).

### 19.2 Table

```ts
export interface TableElement extends BaseElement {
  type: "table";
  columns: TableColumn[];
  rows: TableRow[];
  headerRow?: boolean;                  // default true
  headerColumn?: boolean;               // default false
  columnWidths?: number[];              // logical px; omitted = auto
  rowHeights?: number[];
  tableStyle?: TableStyle;
  data?: ChartDataReference;            // optional: rows driven by a data source
}

export interface TableColumn {
  id: Id;
  label?: string;
  align?: HorizontalAlign;
  format?: NumberFormat;
  width?: number;
}

export interface TableRow {
  id: Id;
  cells: TableCell[];
  emphasis?: "none" | "subtotal" | "total" | "highlight";
}

export interface TableCell {
  content: RichTextDocument | string;
  colSpan?: number;
  rowSpan?: number;
  style?: CommonStyle;
  align?: HorizontalAlign;
}

export interface TableStyle {
  banding?: "none" | "rows" | "columns";
  borders?: "all" | "horizontal" | "outer" | "none";
  headerFill?: Paint;
  cellPadding?: Insets;
  compact?: boolean;
}
```

Tables were absent from doc 01 §8.3 entirely. They belong in MVP: business-review and technical decks both need them, PPTX maps them natively, and a table is the only sensible representation for comparison data that a chart would obscure.

### 19.3 Code

```ts
export interface CodeElement extends BaseElement {
  type: "code";
  language: string;                     // "typescript", "python", "bash", "text"
  code: string;
  showLineNumbers?: boolean;            // default false
  startLineNumber?: number;             // default 1
  highlightedLines?: number[];
  diffMode?: boolean;                   // render +/- lines
  wrap?: boolean;                       // default false
  themeToken?: string;                  // syntax theme id
  fileName?: string;                    // rendered as a caption/tab
}
```

`highlightedLines` plus `startLineNumber` is what makes "walk through this function" work: the same code block appears on three slides with different lines emphasized, and a shared-element morph carries it between them.

### 19.4 Video

```ts
export interface VideoElement extends BaseElement {
  type: "video";
  assetId: Id;
  posterAssetId?: Id;
  autoplay?: boolean;                   // default false
  loop?: boolean;
  muted?: boolean;                      // default true; browsers require it for autoplay
  controls?: boolean;                   // default true
  startTimeMs?: number;
  endTimeMs?: number;
  fit?: ImageFit;
  captionsAssetId?: Id;                 // WebVTT
}
```

### 19.5 Audio

```ts
export interface AudioElement extends BaseElement {
  type: "audio";
  assetId: Id;
  autoplay?: boolean;
  loop?: boolean;
  scope?: "slide" | "presentation";     // narration vs background track
  volume?: Normalized;                  // default 1
  transcript?: string;
}
```

`scope: "presentation"` is how a background track survives slide changes — and it is also the hook video export needs for narration mixing (doc 04 §35.2).

### 19.6 Web embed

```ts
export interface WebEmbedElement extends BaseElement {
  type: "webEmbed";
  url: string;
  allowInteraction?: boolean;           // default false
  fallbackAssetId?: Id;                 // static image for export and offline
  aspectRatio?: string;
}
```

**Security.** Embed URLs are checked against a workspace allowlist at render time, rendered in a sandboxed iframe with no same-origin access, and never granted clipboard, camera, microphone, or storage permissions. Creating a `webEmbed` via an agent patch requires an elevated scope (doc 04 §48.1). Exports always use `fallbackAssetId`; a PDF cannot contain a live page.

---

## 20. Layout Constraints

Absolute coordinates are necessary for free design, but constraints coexist with them. v1.0 declared the union without defining any member.

```ts
export type LayoutConstraint =
  | AlignConstraint
  | DistanceConstraint
  | AnchorConstraint
  | EqualSizeConstraint
  | ContainmentConstraint
  | AspectRatioConstraint;
```

### 20.1 The constraint types

```ts
export interface AlignConstraint {
  type: "align";
  axis: "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
  targetId: Id;                         // element id, or "slide"
  offset?: number;                      // default 0
  priority?: ConstraintPriority;
}

export interface DistanceConstraint {
  type: "distance";
  edge: "left" | "right" | "top" | "bottom";
  targetId: Id;
  targetEdge?: "left" | "right" | "top" | "bottom";
  value: number;                        // logical px gap
  relation?: "equal" | "min" | "max";   // default "equal"
  priority?: ConstraintPriority;
}

export interface AnchorConstraint {
  type: "anchor";
  anchor: "parent" | "slide";
  edges: ("top" | "right" | "bottom" | "left")[];
  insets: Insets;
  priority?: ConstraintPriority;
}

export interface EqualSizeConstraint {
  type: "equalSize";
  axis: "width" | "height" | "both";
  targetId: Id;
  priority?: ConstraintPriority;
}

export interface ContainmentConstraint {
  type: "containment";
  containerId: Id;                      // element id, or "slide", or "safeArea"
  padding?: Insets;
  priority?: ConstraintPriority;
}

export interface AspectRatioConstraint {
  type: "aspectRatio";
  ratio: number;                        // width / height
  priority?: ConstraintPriority;
}

export type ConstraintPriority = "required" | "strong" | "medium" | "weak";
```

### 20.2 Priority exists to break cycles

Doc 04 §16.1 resolves constraints with a dependency-ordered evaluator that drops the lowest-priority constraint in any cycle. Without priorities that choice is arbitrary; with them it is predictable and explainable to the user ("your 'equal width' rule was suspended because it conflicted with the pin to the slide edge").

Default priority is `"strong"`. `"required"` constraints are never dropped — if two `required` constraints conflict, that is a validation error (`E020`), not a silent resolution.

### 20.3 Precedence

```text
container layout  >  constraints  >  absolute x/y
```

Stated in doc 04 §15.5 and normative here. A constraint on a container child may adjust cross-axis alignment only; it cannot fight the container's main-axis placement.

### 20.4 MVP scope

Implement `align`, `distance`, `anchor`, and `containment` in v1. `equalSize` and `aspectRatio` are schema-defined and can be added to the solver without a schema change.

---

## 21. Container Layouts

```ts
export interface ContainerLayout {
  type: "free" | "horizontal" | "vertical" | "grid" | "stack";
  gap?: number;                         // default from theme.spacing
  rowGap?: number;
  columnGap?: number;
  padding?: Insets;
  align?: "start" | "center" | "end" | "stretch" | "baseline";   // cross axis
  justify?: "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly";
  columns?: number;                     // grid
  rows?: number;
  wrap?: boolean;                       // default false
  autoFlow?: "row" | "column";
  distribute?: "none" | "equal";        // equal-size children
}
```

Attached to `GroupElement.containerLayout` (§16.2). This is the fix for the v1.0 gap where the type existed but was unreachable.

### 21.1 When each type applies

| Type | Use |
| --- | --- |
| `free` | Absolute children; the default, and the escape hatch |
| `horizontal` | KPI rows, logo strips, comparison columns |
| `vertical` | Bullet stacks, agenda lists, timeline steps |
| `grid` | Feature matrices, icon grids, photo walls |
| `stack` | Overlaid layers — a scrim over an image, a badge on a card |

### 21.2 Why this matters for AI output

The single most common failure of generated slides is content that fits the sample text and breaks on real text. A container re-flows; absolute boxes overlap. The Layout Agent should emit containers for anything repeated and reserve `free` for genuinely bespoke compositions (doc 04 §15.4).

---

## 22. Theme Model

```ts
export interface ThemeDefinition {
  id: Id;                               // "thm_..."
  name: string;
  description?: string;
  mode?: "light" | "dark";
  colors: ColorTokens;                  // §22.1
  typography: TypographyTokens;         // §22.3
  spacing: SpacingTokens;               // §22.4
  radii: RadiusTokens;
  shadows: ShadowTokens;
  grid: GridTokens;                     // §22.5
  chart?: ChartTheme;                   // §22.6
  diagram?: DiagramTheme;
  imagery?: ImageryTheme;
  motion?: MotionTheme;                 // §23
  brandRules?: BrandRule[];             // §22.7
  logoAssetIds?: Id[];
  extends?: Id;                         // inherit from a workspace theme
}
```

The theme is not cosmetic. Agents reference it as a **design contract**: the Creative Director proposes tokens, the Layout Agent consumes them, and the Critic checks conformance. A three-color theme gives all three nothing to work with, which is why v1.1 expands the token set.

### 22.1 Color tokens

```ts
export interface ColorTokens {
  // surfaces
  background: ColorValue;
  surface: ColorValue;
  surfaceAlt: ColorValue;
  overlay: ColorValue;

  // content
  foreground: ColorValue;
  foregroundMuted: ColorValue;
  foregroundSubtle: ColorValue;

  // brand
  accent: ColorValue;
  accentForeground: ColorValue;         // guaranteed readable ON accent
  accentMuted?: ColorValue;
  secondary?: ColorValue;
  secondaryForeground?: ColorValue;

  // structure
  border: ColorValue;
  borderStrong?: ColorValue;
  divider?: ColorValue;

  // status
  success?: ColorValue;
  warning?: ColorValue;
  danger?: ColorValue;
  info?: ColorValue;

  // data
  chartSeries: ColorValue[];            // ordered, minimum 6
  chartPositive?: ColorValue;
  chartNegative?: ColorValue;
  chartNeutral?: ColorValue;

  custom?: Record<string, ColorValue>;
}
```

**Why foreground/background pairs.** `accentForeground` exists so that "text on an accent fill" has a defined answer instead of every layout guessing. It is also what makes contrast validation mechanical rather than heuristic.

**Why `chartSeries` is an ordered array.** Chart color assignment must be deterministic — series 0 always takes `chartSeries[0]`. A palette object keyed by name would make chart colors depend on data ordering.

### 22.2 Contrast pairs

```ts
export interface ContrastPair {
  foreground: string;                   // token path
  background: string;
  minimumRatio: number;                 // 4.5 body, 3.0 large text / UI
}
```

Declared on the theme and checked by the validator (`W210`) and the Critic. This is how brand enforcement becomes testable rather than aspirational, and it satisfies doc 01 §9.5's contrast requirement with a concrete rule (WCAG 2.1 AA).

### 22.3 Typography tokens

```ts
export interface TypographyTokens {
  display: TypographyStyle;
  h1: TypographyStyle;
  h2: TypographyStyle;
  h3: TypographyStyle;
  body: TypographyStyle;
  bodySmall: TypographyStyle;
  caption: TypographyStyle;
  quote: TypographyStyle;
  code: TypographyStyle;
  metric: TypographyStyle;
  scaleRatio?: number;                  // e.g. 1.25 — documents the type scale
  custom?: Record<string, TypographyStyle>;
}
```

**Naming fix.** v1.0's example used `typography.heading.family` while elements used `typography.fontFamily`. v1.1 uses `TypographyStyle` (§12.2) in both places, so a token is directly assignable to an element and `"token:typography.h1"` resolves to a complete style rather than a fragment.

### 22.4 Spacing, radii, shadows

```ts
export interface SpacingTokens {
  base: number;                         // default 8
  xs: number; sm: number; md: number; lg: number; xl: number; xxl: number;
  slideMargin: Insets;
  custom?: Record<string, number>;
}

export interface RadiusTokens {
  none: number; sm: number; md: number; lg: number; full: number;
  custom?: Record<string, number>;
}

export interface ShadowTokens {
  none: ShadowStyle[];
  sm: ShadowStyle[]; md: ShadowStyle[]; lg: ShadowStyle[];
  custom?: Record<string, ShadowStyle[]>;
}
```

### 22.5 Grid tokens

```ts
export interface GridTokens {
  columns: number;                      // default 12
  gutter: number;
  margin: number;
  baseUnit: number;                     // snapping increment, default 8
  baselineGrid?: number;                // vertical rhythm
}
```

`baseUnit` is what doc 04 §14.5 uses for `Shift`+arrow nudges and grid snapping. Putting it in the theme means a dense technical deck and an airy pitch deck can have different rhythms.

### 22.6 Chart, diagram, and imagery themes

```ts
export interface ChartTheme {
  series: ColorValue[];
  gridlineColor?: ColorValue;
  axisColor?: ColorValue;
  labelTypography?: TypographyStyle;
  showGridlines?: boolean;
  barCornerRadius?: number;
  lineWidth?: number;
  pointSize?: number;
}

export interface DiagramTheme {
  nodeFill?: Paint;
  nodeStroke?: StrokeStyle;
  nodeRadius?: number;
  nodePadding?: Insets;
  nodeTypography?: TypographyStyle;
  edgeStroke?: StrokeStyle;
  edgeLabelTypography?: TypographyStyle;
  roleStyles?: Record<string, CommonStyle>;   // per DiagramNode.role
  boundaryStyle?: CommonStyle;
}

export interface ImageryTheme {
  treatment?: "none" | "duotone" | "grayscale" | "tinted";
  duotoneColors?: [ColorValue, ColorValue];
  defaultCornerRadius?: number;
  defaultOverlay?: Paint;
  aspectPreference?: string[];          // ["16:9", "4:3"]
}
```

`roleStyles` is what makes an architecture diagram legible: datastores look different from services, externals look different from internals, and the difference comes from the theme rather than from per-node styling an agent has to remember.

### 22.7 Brand rules

```ts
export interface BrandRule {
  id: string;
  kind: "must" | "should" | "must-not";
  scope: "typography" | "color" | "imagery" | "layout" | "motion" | "content";
  statement: string;                    // human-readable, given to agents
  check?: BrandCheck;                   // machine-checkable form, optional
}

export type BrandCheck =
  | { type: "maxFontSizesPerSlide"; value: number }
  | { type: "allowedFontFamilies"; value: string[] }
  | { type: "minContrastRatio"; value: number }
  | { type: "forbiddenColorLiterals"; value: boolean }
  | { type: "maxTextDensity"; value: number }       // characters per slide
  | { type: "requiredElements"; value: SemanticRole[] }
  | { type: "logoPlacement"; value: { corner: string; minSize: number } };
```

Rules with a `check` are enforced by the validator. Rules without one are prompt context for the Creative Director and Critic. Both forms are useful; only the first is reliable.

### 22.8 Theme resolution order

```text
element literal value
  > element token reference
  > component parameter default (§40)
  > theme token
  > theme.extends parent token
  > built-in default
```

A missing token resolves up the chain rather than failing. A token reference that resolves nowhere is validation error `E015`.

---

## 23. Motion Theme

```ts
export interface MotionTheme {
  personality?: "subtle" | "cinematic" | "playful" | "technical" | "custom";
  defaultEntrance?: string;             // preset name
  defaultExit?: string;
  defaultEmphasis?: string;
  defaultDurationMs?: number;           // default 500
  defaultEasing?: Easing;               // default "easeOut"
  staggerMs?: number;                   // default 80
  defaultTransition?: SlideTransition;
  reducedMotionFallback?: "fade" | "none";
  maxSlideDurationMs?: number;          // entrance budget, default 2500
}
```

### 23.1 Personality presets

| Personality | Duration | Easing | Stagger | Character |
| --- | --- | --- | --- | --- |
| `subtle` | 300 ms | `easeOut` | 50 ms | Barely noticed; business reviews |
| `technical` | 400 ms | `emphasized` | 70 ms | Precise, restrained; architecture decks |
| `cinematic` | 700 ms | `emphasized` | 120 ms | Deliberate, weighty; keynotes |
| `playful` | 500 ms | `spring(180,12,1)` | 90 ms | Overshoot; product launches |

A preset invoked with no parameters must look correct for the deck's personality (doc 04 §24.1). This table is how that happens without every agent hardcoding numbers.

### 23.2 `maxSlideDurationMs`

The entrance budget. Past ~2.5 s the presenter is talking over an animation that is still running. The Critic flags slides that exceed it; the Motion Agent treats it as a hard constraint when sequencing.

---

## 24. Animation Track Model

Animation is a first-class part of the document, not a rendering afterthought.

```ts
export interface AnimationTrack {
  id: Id;                               // "anm_..."
  targetId: Id;                         // element id
  subTarget?: string;                   // §24.3
  trigger: AnimationTrigger;            // §25
  clips: AnimationClip[];
  label?: string;
  disabled?: boolean;
}

export interface AnimationClip {
  id: Id;                               // "clp_..."
  preset?: string;                      // §24.2
  presetParams?: Record<string, unknown>;
  propertyTracks?: PropertyTrack[];     // explicit keyframes; overrides preset
  startMs: Milliseconds;                // §24.4
  durationMs: Milliseconds;
  delayMs?: Milliseconds;               // default 0
  easing?: Easing;
  repeat?: number;                      // default 0; -1 = infinite
  direction?: "normal" | "reverse" | "alternate";
  fill?: "none" | "forwards" | "backwards" | "both";   // default "forwards"
}
```

### 24.1 Property tracks and keyframes

```ts
export interface PropertyTrack {
  property: AnimatableProperty;
  keyframes: Keyframe[];
}

export type AnimatableProperty =
  | "opacity" | "x" | "y" | "scale" | "scaleX" | "scaleY" | "rotation"
  | "blur" | "clip" | "pathProgress" | "numberValue"
  | "fill" | "stroke" | "width" | "height" | "custom";

export interface Keyframe {
  offset: Normalized;                   // §24.5
  value: unknown;
  easing?: Easing;                      // easing INTO this keyframe
}
```

### 24.2 Presets expand to property tracks

A `preset` name is a pure function from parameters to property tracks (doc 04 §22.2), evaluated at build time. Two consequences worth stating in the schema doc:

1. A preset can be **opened** in the timeline UI, converting it to explicit `propertyTracks` the user can edit. That conversion is a normal patch.
2. A clip with both `preset` and `propertyTracks` uses the property tracks; the preset name is retained as provenance so the UI can still say "this started as `blurReveal`".

### 24.3 Sub-targets

`subTarget` addresses a semantic part of a composite element without knowing its geometry:

```text
"node/orchestrator"          // DiagramElement
"edge/orchestrator->layout"
"rank/2"
"series/0"                   // ChartElement
"point/3"
"row/4"                      // TableElement
"line/12-18"                 // CodeElement
"child/el_01JB8Z..."         // GroupElement
```

This is what lets the Motion Agent express "draw the data-flow edges after the agent cluster appears" as intent rather than coordinates (doc 04 §20.6). An unresolvable `subTarget` is validation warning `W130`; the clip is skipped, not fatal.

### 24.4 What `startMs` means — clarified in v1.1

v1.0 left this ambiguous when the trigger was relative.

**`startMs` is an offset from the trigger's resolved time, not an absolute time on the slide timeline.**

```text
resolvedStart(clip) = triggerTime(track.trigger) + clip.startMs + (clip.delayMs ?? 0)
```

Where `triggerTime` is:

| Trigger | Resolved time |
| --- | --- |
| `slideEnter` | 0 |
| `afterPrevious` | end of the previous track in `slide.animations[]` order |
| `withPrevious` | start of the previous track |
| `timer` | previous cursor + `delayMs` |
| `click` / `hover` | segment boundary; resolved at playback, not at build |

Track order within `slide.animations[]` is the sequencing authority — the same single-authority rule as §7.2 and §8.4.

### 24.5 Keyframe offsets are normalized

`Keyframe.offset` is `0..1` **relative to the clip's `durationMs`**, not milliseconds. Keyframes must be sorted ascending; the first should be `0` and the last `1`. A track whose keyframes do not span the full range holds its first/last value at the ends (equivalent to `fill: both` within the clip).

Normalizing means changing a clip's duration rescales its keyframes automatically — dragging a clip's edge in the timeline is one property change, not N.

### 24.6 Conflicts

Two clips animating the same `property` of the same `targetId` over overlapping intervals is a conflict.

**Rule: the later-defined clip wins for the overlapping interval. Values are never blended.**

The editor shows a warning stripe on the timeline (doc 04 §25.3) and the validator emits `W131`. Blending is rejected because blended results are unpredictable and cannot be reproduced by PPTX export or a video renderer.

### 24.7 Reduced motion

Every preset declares a fallback (doc 04 §27.3). The document may override per clip:

```ts
// on AnimationClip
reducedMotionPreset?: string;           // e.g. "fade"
reducedMotionBehavior?: "fallback" | "skip" | "instant";
```

Reduced motion must never mean content fails to appear. `skip` still applies the clip's end state.

---

## 25. Animation Triggers

```ts
export type AnimationTrigger =
  | { type: "slideEnter" }
  | { type: "afterPrevious" }
  | { type: "withPrevious" }
  | { type: "click"; targetId?: Id }
  | { type: "hover"; targetId: Id }
  | { type: "timer"; delayMs: Milliseconds }
  | { type: "marker"; markerId: string };
```

### 25.1 Segments

`click` triggers split a slide's timeline into **segments**. Playback runs to the next segment boundary and waits. This is how click-to-reveal works, and it is what present-mode's arrow keys navigate through before advancing the slide (doc 04 §26.3).

For MVP, `slideEnter` + `afterPrevious` + `withPrevious` are sufficient; `click` is the first addition.

### 25.2 Markers

```ts
// on Slide
timelineMarkers?: { id: string; timeMs: number; label: string }[];
```

Named moments the speaker notes and interactions can reference without hardcoding milliseconds. Also gives the Motion Agent stable anchors to describe intent against ("the architecture is revealed at `architecture-revealed`").

---

## 26. Slide Transitions

```ts
export interface SlideTransition {
  type: "cut" | "fade" | "slide" | "zoom" | "morph" | "mask" | "push" | "custom";
  durationMs: Milliseconds;
  easing?: Easing;
  direction?: "left" | "right" | "up" | "down";
  sharedElements?: SharedElementMapping[];
  autoAdvanceMs?: Milliseconds;         // kiosk mode
}

export interface SharedElementMapping {
  sourceElementId: Id;
  destinationElementId: Id;
  matchMode?: "position" | "positionAndScale" | "full";   // default "positionAndScale"
}
```

### 26.1 Transition ownership

A slide's `transition` describes how the deck moves **into** that slide. This matters for reordering: moving a slide carries its entrance transition with it, which is the behaviour authors expect.

### 26.2 Morph pairing

Explicit `sharedElements` wins. Absent that, the renderer auto-pairs with a scored heuristic (doc 04 §28.2) and labels auto-pairs in the UI so the author can confirm or break them. Never silently morph two unrelated objects.

---

## 27. Interaction Model

```ts
export interface Interaction {
  id: Id;
  trigger:
    | { type: "click"; targetId: Id }
    | { type: "hover"; targetId: Id }
    | { type: "key"; key: string };
  action:
    | { type: "goToSlide"; slideId: Id }
    | { type: "nextSlide" }
    | { type: "previousSlide" }
    | { type: "openUrl"; url: string; newTab?: boolean }
    | { type: "toggleVisibility"; targetId: Id }
    | { type: "runAnimation"; trackId: Id }
    | { type: "seekTimeline"; markerId: string };
  enabledInEditor?: boolean;            // default false
}
```

### 27.1 Precedence with animation triggers — clarified in v1.1

Both `Interaction` and `AnimationTrigger` can respond to a click on the same element. v1.0 did not say which fires.

**Rule, in order:**

1. If a pending animation segment exists on the slide, a click **advances the segment**.
2. Once all segments are complete, a click on an element with a matching `Interaction` fires that interaction.
3. Otherwise, a click advances the slide.

Rationale: click-to-reveal is far more common than click-to-navigate, and a user clicking to reveal the next bullet must never jump to another slide by accident.

`hover` interactions are exempt from this ordering and always fire.

### 27.2 Scope

Interactions run in present mode and in exported HTML. They are inert in the editor unless `enabledInEditor` is set, so clicking a link during editing selects the element rather than navigating away.

`openUrl` targets are checked against the workspace allowlist in the same way as `webEmbed` (§19.6).

---

## 28. Assets

```ts
export interface AssetReference {
  id: Id;                               // "ast_..."
  type: "image" | "video" | "audio" | "font" | "file";
  storageKey: string;                   // §28.1
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  durationMs?: number;                  // video/audio
  checksum?: string;                    // sha256
  altText?: string;
  dominantColor?: ColorValue;
  blurHash?: string;
  focalPoint?: Point;                   // detected, used as ImageElement default
  variants?: AssetVariant[];            // §28.2
  license?: AssetLicense;               // §28.3
  createdBy?: "upload" | "generated" | "import" | "integration";
  metadata?: Record<string, unknown>;
}
```

### 28.1 `storageKey`, not `uri` — changed in v1.1

v1.0 had `uri: string`, which invites storing a signed URL — directly contradicting doc 05 §24 ("do not store transient signed URLs in canonical documents").

`storageKey` is an **opaque, permanent storage identifier** (e.g. `workspaces/ws_.../assets/ast_....png`). Signed URLs are minted at render time and never persisted. A `.mydeck` document must remain valid after every URL it was created with has expired.

### 28.2 Variants

```ts
export interface AssetVariant {
  storageKey: string;
  width: number;
  height: number;
  format: "webp" | "avif" | "jpeg" | "png";
  purpose?: "thumbnail" | "display" | "print";
}
```

Derivatives at 480/960/1920/3840 px feed `srcset` in the editor and full-resolution originals in export (doc 04 §19.3).

### 28.3 License

```ts
export interface AssetLicense {
  kind: "owned" | "stock" | "cc" | "generated" | "unknown";
  attribution?: string;
  sourceUrl?: string;
  embedAllowed?: boolean;               // fonts: may we embed in PDF/PPTX?
  expiresAt?: string;
}
```

`embedAllowed` is load-bearing for font export (doc 04 §18.5): the PDF adapter subsets and embeds when true, outlines glyphs and warns when false.

### 28.4 Referencing rule

Elements reference assets by `id`, never by path or URL. This is what allows an asset to be re-uploaded, re-encoded, or migrated between buckets without touching a single slide.

---

## 29. Data Sources and Bindings

```ts
export interface DataSourceDefinition {
  id: Id;                               // "src_..."
  name?: string;
  type: "inline" | "csv" | "json" | "api" | "github" | "database" | "mcp";
  configuration: Record<string, unknown>;   // §29.2
  refreshPolicy?: RefreshPolicy;
  lastRefreshedAt?: string;
  schema?: Record<string, "string" | "number" | "boolean" | "date">;
}

export type RefreshPolicy =
  | { mode: "manual" }
  | { mode: "onOpen" }
  | { mode: "interval"; ms: number };
```

`"mcp"` is added in v1.1 per doc 04 §47.1.

### 29.1 Credentials are never in the document

A `DataSourceDefinition` holds a **reference** to a workspace-level connection, never a URL with a token, never an API key, never a connection string. Resolution happens server-side under the requesting user's permissions.

A `.mydeck` file must be safe to email.

### 29.2 Configuration by type

```ts
// inline
{ rows: Record<string, unknown>[] }

// csv / json
{ assetId: Id; delimiter?: string; hasHeader?: boolean }

// api
{ connectionId: string; path: string; method?: "GET" | "POST"; params?: Record<string, string> }

// github
{ installationId: string; repository: string; ref?: string; path?: string }

// database
{ connectionId: string; queryId: string; parameters?: Record<string, unknown> }

// mcp
{ serverId: string; tool: string; arguments: Record<string, unknown>; resultPath?: string }
```

### 29.3 Bindings

```ts
export interface DataBinding {
  sourceId: Id;
  path: string;                         // JSONPath into the resolved data
  targetProperty: string;               // §29.4
  transforms?: BindingTransform[];      // §29.5
  fallback?: unknown;                   // used when resolution fails
  cachedValue?: unknown;                // last successful value
  cachedAt?: string;
}
```

`cachedValue` is why a deck still presents correctly when the network is down or a source has been disconnected: the last good value renders with a staleness badge in the editor and no badge in present mode.

### 29.4 `targetProperty` grammar

A dot path into the element, restricted to a documented allowlist per element type:

```text
content.blocks.0.spans.0.text      TextElement
data.rows                          ChartElement, TableElement
assetId                            ImageElement
label                              DiagramNode (via subpath)
style.fill.color                   any element
```

Anything outside the allowlist is validation error `E017`. Unrestricted property paths would let a binding rewrite `id`, `type`, or `children`, which is a structural-integrity hazard.

### 29.5 Transforms — declarative, not an expression language

v1.0 had `transform?: string`, an unspecified expression language. If evaluated client-side that makes a shared deck a code-execution vector, and doc 05 §34 forbids arbitrary code execution in MVP.

v1.1 replaces it with a fixed, chainable allowlist:

```ts
export type BindingTransform =
  | { fn: "number.format"; options: NumberFormat }
  | { fn: "number.round"; options: { decimals: number } }
  | { fn: "number.scale"; options: { factor: number } }
  | { fn: "number.percentChange"; options: { from: string } }
  | { fn: "date.format"; options: { pattern: string; timeZone?: string } }
  | { fn: "date.relative" }
  | { fn: "string.upper" }
  | { fn: "string.lower" }
  | { fn: "string.title" }
  | { fn: "string.truncate"; options: { length: number; ellipsis?: boolean } }
  | { fn: "string.template"; options: { pattern: string } }   // "{value} incidents"
  | { fn: "array.join"; options: { separator: string } }
  | { fn: "array.take"; options: { count: number; from?: "start" | "end" } }
  | { fn: "array.sort"; options: { by?: string; direction?: "asc" | "desc" } }
  | { fn: "math.sum" } | { fn: "math.avg" } | { fn: "math.min" } | { fn: "math.max" }
  | { fn: "math.count" };

export interface NumberFormat {
  style?: "decimal" | "percent" | "currency" | "compact";
  currency?: string;                    // ISO 4217
  decimals?: number;
  locale?: string;
  prefix?: string;
  suffix?: string;
}
```

`string.template` substitutes only the incoming value into `{value}`. It is not a template language and cannot reference other data.

Transforms apply in array order. Every function is pure, total, and has a defined result for wrong-typed input (pass through unchanged and emit warning `W140`) — a binding must never throw during render.

### 29.6 Refresh produces a transaction

Refreshing a binding is a normal document change: it produces a `Transaction` (§31.5) with `source: "system"`. A deck whose numbers change silently between rehearsal and delivery is a product failure, so every data change is visible in history and revertible.

---

## 30. Provenance

```ts
export interface ProvenanceRecord {
  id: Id;                               // "prv_..."
  targetId: Id;                         // element or slide
  sourceType: "github" | "web" | "file" | "user" | "model" | "mcp";
  sourceReference: string;              // repo#path:lines, URL, assetId, tool name
  excerpt?: string;                     // short, for display
  excerptHash?: string;
  confidence?: Normalized;
  agentId?: string;
  createdAt: string;
}
```

`"mcp"` added in v1.1 per doc 04 §47.4.

### 30.1 Why provenance is in the document

Three reasons it belongs here rather than in a side table:

1. **Inspectability** (doc 01 §7.2) — the user can click a claim and see which file produced it, and that must survive export and duplication.
2. **Trust** — a technical audience will ask "where did that number come from" in the room.
3. **Re-grounding** — when a repository changes, the system can identify which slides depended on the changed files.

### 30.2 Privacy

`excerpt` may contain private repository content. It is stored with the document and therefore inherits the document's access controls. Exports strip provenance by default; including it is an explicit option.

---

## 31. Patch and Transaction Model

**This section is the canonical definition of the change lineage.** v1.0's `PresentationPatch`, doc 03 §16's `AgentTransaction`, doc 05 §11's `Transaction`, and doc 04 §29's `EditCommand` were four names for one concept. They now resolve to the three types below; the other documents reference them rather than redefining them.

```text
PatchOperation   atomic change to one path
      |
    Patch        an ordered set of operations + intent
      |
 Transaction     an applied patch + inverse + source + status
```

### 31.1 Patch operations

```ts
export type PatchOperation =
  | { op: "add";     path: PatchPath; value: unknown }
  | { op: "remove";  path: PatchPath }
  | { op: "replace"; path: PatchPath; value: unknown }
  | { op: "move";    from: PatchPath; path: PatchPath }
  | { op: "copy";    from: PatchPath; path: PatchPath }
  | { op: "test";    path: PatchPath; value: unknown };
```

`copy` and `test` are added in v1.1. `test` is the mechanism for optimistic concurrency: an agent that read a value can assert it is unchanged before writing, and the whole patch fails atomically if it is not.

### 31.2 Patch

```ts
export interface Patch {
  id: Id;
  targetPresentationId: Id;
  expectedVersionId?: string;           // optimistic concurrency at patch level
  operations: PatchOperation[];
  intent: string;                       // human-readable summary
  agentMetadata?: AgentChangeMetadata;  // §32
}
```

Patches are **atomic**: all operations apply or none do. A partially applied patch is never a valid state.

### 31.3 Path grammar — id-addressed, new in v1.1

v1.0 used plain JSON Pointer (`/slides/2/elements/7`). Index-addressed paths break whenever an earlier sibling is inserted or removed — which is exactly what agents do, and exactly what happens between an agent's read and its write.

```text
PatchPath := "/" Segment ( "/" Segment )*
Segment   := Key | Index | IdRef | "-"
IdRef     := "id:" Id
```

Examples:

```text
/slides/id:sld_01JB8Z.../elements/id:el_07/transform/x
/slides/id:sld_01JB8Z.../elements/-                       (append)
/slides/id:sld_01JB8Z.../elements/id:el_07/content/blocks/0/spans/0/text
/theme/colors/accent
```

Rules:

1. **Elements, slides, tracks, clips, assets, components, and data sources are addressed by `id:`.** Anything with an `Id` must be addressed by it.
2. **Numeric indices remain valid for arrays whose members have no id** — keyframes, spans, blocks, gradient stops, chart rows.
3. Ids resolve to indices at apply time, atomically with the rest of the patch.
4. An unresolvable `id:` segment fails the whole patch with error `E030` and an actionable message naming the nearest match.
5. `-` appends, as in RFC 6902.
6. `~0` and `~1` escape `~` and `/` in literal keys.

**Agents must emit id-addressed paths.** The editor may emit index paths for local operations where it holds a lock on the document, but anything crossing a process boundary uses ids.

### 31.4 Inverse operations

Inverses are computed at apply time against the pre-state, the only moment the old value is known.

| Operation | Inverse |
| --- | --- |
| `add /p` | `remove /p` |
| `remove /p` | `add /p` with the captured value |
| `replace /p` | `replace /p` with the captured value |
| `move a → b` | `move b → a` |
| `copy a → b` | `remove b` |
| `test` | no-op |

Ordering hazard: a batch touching several array indices applies in descending index order and inverts in ascending order. Id-addressed paths remove most of this hazard, which is a second reason for §31.3.

### 31.5 Transaction

```ts
export interface Transaction {
  id: Id;                               // "txn_..."
  presentationId: Id;
  parentVersionId: string;
  resultVersionId?: string;             // set on apply
  source: "user" | "agent" | "system" | "import";
  agentId?: string;
  clientId?: string;                    // MCP client or app surface
  userInstruction?: string;
  intent: string;
  operations: PatchOperation[];
  inverseOperations: PatchOperation[];
  status: TransactionStatus;            // §31.6
  reason?: string;
  confidence?: Normalized;
  sourceIds?: Id[];                     // provenance
  createdAt: string;
  appliedAt?: string;
  createdBy: string;                    // user id
}

export type TransactionStatus =
  | "pending"      // proposed, awaiting approval
  | "applied"
  | "rejected"
  | "expired"
  | "reverted";
```

### 31.6 Why `status` exists

Doc 01 §11.2 requires proposal-before-apply, and doc 04 §46.2 requires the same for agent edits arriving from outside the app. v1.0 had no representation for a proposed-but-unapplied change, so "preview this AI edit" had nowhere to live.

Lifecycle:

```text
pending ──approve──> applied ──undo──> reverted
   │
   ├──reject──> rejected
   └──24h────> expired
```

A `pending` transaction is validated on creation and re-validated on approval, because the document may have moved underneath it. If re-validation fails, the transaction moves to `expired` with a diff explaining what changed.

### 31.7 Risk tiers

Tier is computed **server-side from the operations**, never declared by the caller (doc 04 §46.1):

| Tier | Definition | Default |
| --- | --- | --- |
| Low | ≤ 3 operations on one slide, no deletions, no theme/viewport change | Auto-apply |
| Medium | One slide restructured, image replaced, slide added | Pending + preview |
| High | > 3 slides touched, any slide deleted, theme or viewport changed | Explicit approval |

### 31.8 Granularity guidance for agents

Agents return patches, not documents. A patch that replaces `/slides/id:sld_04` wholesale destroys ids, breaks animations that referenced them, and makes the change unreviewable. Target the narrowest path that expresses the intent:

```json
{ "op": "replace",
  "path": "/slides/id:sld_04/elements/id:el_12/typography/fontSize",
  "value": 72 }
```

not a slide rewrite that happens to change one number.

---

## 32. Agent Change Metadata

```ts
export interface AgentChangeMetadata {
  agentId: string;
  intent: string;
  reason?: string;
  confidence?: Normalized;
  sourceIds?: Id[];
  alternativesConsidered?: string[];
  criticScoreBefore?: number;
  criticScoreAfter?: number;
  createdAt: string;
}
```

This is what powers AI-specific undo, the agent inspector, audit logs, and change explanation (doc 01 §11.3). `reason` is user-facing and should be a sentence, not a label — "Shortened the headline so it fits at the theme's display size without shrinking" tells the user something; "Optimized text" does not.

---

## 33. Example Minimal Document

```json
{
  "schemaVersion": "1.0.0",
  "id": "doc_01JB8Z9K2QW4RN7F3XG5HTMD6A",
  "metadata": {
    "title": "Autonomous Migration Control Tower",
    "presentationType": "technical",
    "audience": "Engineering leadership",
    "objective": "Show that migration can be observable, agentic and policy-controlled",
    "estimatedDurationSeconds": 480,
    "language": "en"
  },
  "viewport": {
    "width": 1920,
    "height": 1080,
    "unit": "px",
    "aspectRatio": "16:9",
    "safeArea": { "top": 80, "right": 120, "bottom": 80, "left": 120 }
  },
  "theme": {
    "id": "thm_01JB8Z9K2QW4RN7F3XG5HTMD6B",
    "name": "Neo Technical",
    "mode": "dark",
    "colors": {
      "background": "#0B0D12",
      "surface": "#12151C",
      "surfaceAlt": "#1A1E27",
      "overlay": "#0B0D12CC",
      "foreground": "#F7F8FA",
      "foregroundMuted": "#A6AEBF",
      "foregroundSubtle": "#6B7280",
      "accent": "#7C9CFF",
      "accentForeground": "#0B0D12",
      "border": "#242A36",
      "success": "#4ADE80",
      "warning": "#FBBF24",
      "danger": "#F87171",
      "chartSeries": ["#7C9CFF", "#4ADE80", "#FBBF24", "#F87171", "#A78BFA", "#22D3EE"]
    },
    "typography": {
      "display": { "fontFamily": "Inter", "fontSize": 96, "fontWeight": 700, "lineHeight": 1.02, "letterSpacing": -2 },
      "h1":      { "fontFamily": "Inter", "fontSize": 64, "fontWeight": 700, "lineHeight": 1.08, "letterSpacing": -1 },
      "h2":      { "fontFamily": "Inter", "fontSize": 44, "fontWeight": 600, "lineHeight": 1.15 },
      "h3":      { "fontFamily": "Inter", "fontSize": 32, "fontWeight": 600, "lineHeight": 1.2 },
      "body":    { "fontFamily": "Inter", "fontSize": 24, "fontWeight": 400, "lineHeight": 1.45 },
      "bodySmall": { "fontFamily": "Inter", "fontSize": 20, "fontWeight": 400, "lineHeight": 1.45 },
      "caption": { "fontFamily": "Inter", "fontSize": 16, "fontWeight": 400, "lineHeight": 1.4, "color": "token:colors.foregroundMuted" },
      "quote":   { "fontFamily": "Inter", "fontSize": 36, "fontWeight": 400, "fontStyle": "italic", "lineHeight": 1.3 },
      "code":    { "fontFamily": "JetBrains Mono", "fontSize": 20, "fontWeight": 400, "lineHeight": 1.5 },
      "metric":  { "fontFamily": "Inter", "fontSize": 112, "fontWeight": 700, "lineHeight": 1, "fontFeatures": ["tnum"] },
      "scaleRatio": 1.33
    },
    "spacing": { "base": 8, "xs": 4, "sm": 8, "md": 16, "lg": 32, "xl": 64, "xxl": 120,
                 "slideMargin": { "top": 80, "right": 120, "bottom": 80, "left": 120 } },
    "radii": { "none": 0, "sm": 4, "md": 12, "lg": 24, "full": 9999 },
    "shadows": {
      "none": [],
      "sm": [{ "type": "drop", "offsetX": 0, "offsetY": 2, "blur": 8, "color": "#00000040" }],
      "md": [{ "type": "drop", "offsetX": 0, "offsetY": 8, "blur": 24, "color": "#00000059" }],
      "lg": [{ "type": "drop", "offsetX": 0, "offsetY": 24, "blur": 64, "color": "#00000073" }]
    },
    "grid": { "columns": 12, "gutter": 24, "margin": 120, "baseUnit": 8 },
    "motion": {
      "personality": "technical",
      "defaultDurationMs": 400,
      "defaultEasing": "emphasized",
      "staggerMs": 70,
      "maxSlideDurationMs": 2500
    },
    "brandRules": [
      { "id": "br-1", "kind": "must-not", "scope": "typography",
        "statement": "Never use more than three type sizes on one slide",
        "check": { "type": "maxFontSizesPerSlide", "value": 3 } },
      { "id": "br-2", "kind": "must", "scope": "color",
        "statement": "Body text must meet WCAG AA contrast against its background",
        "check": { "type": "minContrastRatio", "value": 4.5 } }
    ]
  },
  "slides": [
    {
      "id": "sld_01JB8Z9K2QW4RN7F3XG5HTMD6C",
      "name": "Title",
      "semanticIntent": "Introduce the system and set the technical frame",
      "keyMessage": "Migration should be observable, agentic and policy-controlled",
      "background": { "paint": { "type": "solid", "color": "token:colors.background" } },
      "elements": [
        {
          "id": "el_01JB8Z9K2QW4RN7F3XG5HTMD6D",
          "type": "text",
          "name": "Headline",
          "semanticRole": "headline",
          "transform": { "x": 160, "y": 380, "width": 1280, "height": 240 },
          "fit": "shrinkToFit",
          "minFontSize": 56,
          "typography": {
            "fontFamily": "token:typography.display.fontFamily",
            "fontSize": 96,
            "fontWeight": 700,
            "lineHeight": 1.02,
            "letterSpacing": -2,
            "color": "token:colors.foreground"
          },
          "paragraph": { "align": "left", "lineBreakStrategy": "balanced" },
          "content": {
            "version": 1,
            "blocks": [
              { "id": "blk_01JB8Z9K2QW4RN7F3XG5HTMD6E", "type": "paragraph",
                "spans": [{ "text": "Autonomous Data Migration Control Tower" }] }
            ]
          }
        },
        {
          "id": "el_01JB8Z9K2QW4RN7F3XG5HTMD6F",
          "type": "text",
          "name": "Subtitle",
          "semanticRole": "subtitle",
          "transform": { "x": 160, "y": 650, "width": 900, "height": 90 },
          "fit": "autoHeight",
          "typography": {
            "fontFamily": "token:typography.h3.fontFamily",
            "fontSize": 32,
            "fontWeight": 400,
            "color": "token:colors.foregroundMuted"
          },
          "content": {
            "version": 1,
            "blocks": [
              { "id": "blk_01JB8Z9K2QW4RN7F3XG5HTMD6G", "type": "paragraph",
                "spans": [{ "text": "Six agents, one policy boundary, verifiable evidence" }] }
            ]
          },
          "constraints": [
            { "type": "align", "axis": "left", "targetId": "el_01JB8Z9K2QW4RN7F3XG5HTMD6D" },
            { "type": "distance", "edge": "top",
              "targetId": "el_01JB8Z9K2QW4RN7F3XG5HTMD6D", "targetEdge": "bottom", "value": 32 }
          ]
        }
      ],
      "animations": [
        {
          "id": "anm_01JB8Z9K2QW4RN7F3XG5HTMD6H",
          "targetId": "el_01JB8Z9K2QW4RN7F3XG5HTMD6D",
          "trigger": { "type": "slideEnter" },
          "clips": [
            { "id": "clp_01JB8Z9K2QW4RN7F3XG5HTMD6J",
              "preset": "blurReveal", "startMs": 150, "durationMs": 700, "easing": "easeOut" }
          ]
        },
        {
          "id": "anm_01JB8Z9K2QW4RN7F3XG5HTMD6K",
          "targetId": "el_01JB8Z9K2QW4RN7F3XG5HTMD6F",
          "trigger": { "type": "afterPrevious" },
          "clips": [
            { "id": "clp_01JB8Z9K2QW4RN7F3XG5HTMD6L",
              "preset": "fade", "startMs": -300, "durationMs": 500 }
          ]
        }
      ],
      "transition": { "type": "fade", "durationMs": 300 },
      "speakerNotes": "Open with the cost of an unobserved migration."
    }
  ],
  "assets": [],
  "components": [],
  "dataSources": [],
  "variables": {},
  "createdAt": "2026-09-05T00:00:00Z",
  "updatedAt": "2026-09-05T00:00:00Z"
}
```

### 33.1 What the example demonstrates

- Tokens rather than literals throughout the elements (`token:colors.foreground`), so the deck re-themes.
- `shrinkToFit` with a `minFontSize` floor on the headline — the AI-generated-title-too-long case, handled at authoring time.
- Constraints tying the subtitle to the headline, so lengthening the headline moves the subtitle rather than overlapping it.
- A negative `startMs` on the second clip: `afterPrevious` with a −300 ms offset makes the subtitle begin before the headline finishes, which is what a designed sequence looks like versus a queue.
- Brand rules with machine-checkable forms alongside their human statements.

---

## 34. Schema Validation

### 34.1 Levels

| Level | When | Blocking |
| --- | --- | --- |
| **Structural** | Parse/load, every patch | Yes — invalid documents are never rendered |
| **Referential** | After structural | Yes for `E` codes |
| **Semantic** | On demand, after render | No — produces warnings |
| **Brand** | On demand | No — Critic input |

Doc 04 §6.4 is explicit that a document failing structural validation is not rendered at all. Rendering a partially valid document produces bugs that are far harder to diagnose than a clear failure.

### 34.2 What a validator must reject

Duplicate ids; missing referenced elements; negative or zero dimensions; `NaN`/`Infinity`; invalid animation target ids; invalid asset references; broken constraint references; unresolvable theme tokens; constraint cycles among `required` constraints; element types unsupported by the current schema version; patch paths that do not resolve.

The complete catalog with codes is §42.

### 34.3 Patch validation

Every patch is validated **before** application:

```text
1. Parse and resolve every path (id: segments -> indices)
2. Apply to a copy
3. Run structural + referential validation on the result
4. Compute inverse operations
5. Compute risk tier (§31.7)
6. Return a diff summary
```

Only then is it applied. This is also exactly what `deckastra_validate_patch` and `deckastra_preview_patch` expose over MCP (doc 04 §43.3).

### 34.4 Implementation approach

```text
TypeScript interfaces (normative)
        |
   Zod schemas  ──────> runtime validation, patch checking
        |
  JSON Schema   ──────> external tooling, MCP tool inputSchema, docs
        |
  Test fixtures ──────> valid + invalid corpus, one per rule code
```

Generate downward; never hand-maintain two of these in parallel. The MCP server reuses the same Zod schemas for tool input validation (doc 04 §43.1), which is the strongest argument for keeping `packages/presentation-schema` in TypeScript.

### 34.5 Validation is a product surface, not just a dev tool

The report is consumed by the editor (inline badges), the Critic Agent (issue routing), the export adapters (pre-flight), and the MCP surface (`deckastra_validate_document`). It therefore has a stable, documented shape:

```ts
export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  checkedAt: string;
}

export interface ValidationIssue {
  code: string;                         // "E001", "W203"
  severity: "error" | "warning" | "info";
  path: string;                         // patch path to the offending node
  message: string;                      // actionable
  targetIds?: Id[];
  suggestedFix?: PatchOperation[];      // when mechanically derivable
}
```

`suggestedFix` is what turns "this text overflows" into a one-click repair, and what lets an agent correct itself without another model round-trip.

---

## 35. Schema Versioning and Migrations

### 35.1 Version semantics

```text
MAJOR.MINOR.PATCH
```

| Change | Bump |
| --- | --- |
| Add an optional property | PATCH |
| Add an element type, enum value, or preset | MINOR |
| Rename or remove a property; change a type; change semantics | MAJOR |
| Change a default that alters rendering | MINOR + migration |

Every document carries `schemaVersion`. A document without one is treated as `1.0.0` and migrated on first save.

### 35.2 Migration API

```ts
migrateDocument(document: unknown, targetVersion: string): MigrationResult;

interface MigrationResult {
  document: PresentationDocument;
  applied: string[];                    // ["1.0.0->1.0.1", "1.0.1->1.1.0"]
  warnings: string[];
  lossy: boolean;
}
```

Migrations are registered as ordered, individually tested steps and composed. Never write a migration that jumps two versions.

### 35.3 Migrations in v1.1

| Step | Change |
| --- | --- |
| `1.0.0 → 1.0.1` | Sort `slides[]` by the legacy `order` field, then delete `order` (§7.2) |
| `1.0.1 → 1.0.2` | Normalize `zIndex`: where it duplicates array order, remove it (§8.4) |
| `1.0.2 → 1.0.3` | Convert `content: { text }` and bare strings to `RichTextDocument` (§12.1) |
| `1.0.3 → 1.0.4` | Rename `AssetReference.uri` → `storageKey`; strip any signed query strings (§28.1) |
| `1.0.4 → 1.0.5` | Rename theme `typography.*.family/weight` → `fontFamily/fontWeight` (§22.3) |
| `1.0.5 → 1.0.6` | Convert `DataBinding.transform` strings to `transforms[]` where the string matches a known pattern; drop and warn otherwise (§29.5) |

The `1.0.6` step is deliberately lossy and says so. A free-form expression that cannot be mapped to the allowlist is removed with a warning naming the element, rather than silently retained as an unevaluable string.

### 35.4 Compatibility policy

- Readers support all versions within their major, plus the previous major in read-only mode.
- A document with a higher **major** version is refused with a clear message, not partially parsed.
- A document with a higher **minor** version within the same major is opened, with unknown fields preserved (§0.8) and a notice that some features may not render.
- Every migration has a round-trip test: migrate, render, compare against a golden image from before the migration. A migration that changes rendering is a bug unless it was intended and documented.

---

## 36. Import / Export Philosophy

### 36.1 Import

Possible sources: PPTX, Google Slides, PDF (as reference imagery), HTML, Markdown, plain outline text.

Imports produce best-effort structured objects. Principles:

1. **Never import into an image.** A PPTX text box becomes a `TextElement`, not a screenshot. If a feature cannot be represented, represent what can be and flag the rest.
2. **Assign semantic roles heuristically and mark them as inferred.** A PPTX title placeholder → `semanticRole: "headline"` with `metadata.createdBy: "import"`.
3. **Report what was lost.** An import produces the same shape of report as an export (§36.3).
4. **Sanitize.** Imported SVG, HTML, and path data are untrusted input (§13.2, doc 04 §19.5).

Markdown import is the highest-value and lowest-cost: an outline maps cleanly to slides, headings to headlines, bullets to body blocks, fenced code to `CodeElement`, and tables to `TableElement`.

### 36.2 Export

```text
PresentationDocument
        |
        +--> Web renderer / present mode
        +--> PDF exporter
        +--> PPTX exporter
        +--> Image exporter
        +--> Video renderer (V2+)
        +--> HTML package (V2)
```

**No export adapter mutates the canonical document.** Adapters read a pre-resolved `IntermediateScene` (doc 04 §32.1) so that layout cannot differ between targets.

### 36.3 Round-trip is not a goal

PPTX export followed by PPTX import will not reproduce the original `.mydeck`. Constraints, container layouts, semantic roles, data bindings, provenance, and timeline animation have no PPTX equivalent.

This is stated so no one designs against it. PPTX is a **compatibility target** (doc 01 §14). The web-native document remains the source of truth, and the product's positioning depends on not shrinking the model to what PowerPoint can hold.

---

## 37. MVP Subset

### 37.1 Element types — reconciled with doc 01

v1.0's MVP list and doc 01 §8.3 disagreed: doc 01 listed `icon` as MVP, doc 02 omitted it, and `table` was absent from doc 01 entirely. This is the single canonical list; doc 01 §8.3 should reference it rather than restate it.

| Type | Schema | Renderer | Editor UI | Note |
| --- | --- | --- | --- | --- |
| `text` | v1 | v1 | v1 | — |
| `shape` | v1 | v1 | v1 | Primitives; `customPath` behind an import path only |
| `line` | v1 | v1 | v1 | Anchored connectors included |
| `image` | v1 | v1 | v1 | Crop + focal point |
| `icon` | v1 | v1 | v1 | Curated set; custom upload Phase 2 |
| `group` | v1 | v1 | v1 | Container layouts included |
| `chart` | v1 | v1 | v1 | bar/column/line/area/pie |
| `diagram` | v1 | v1 | v1 | flow + architecture; others Phase 2 |
| `table` | v1 | v1 | v1 | **Added to MVP** |
| `code` | v1 | v1 | v1 | — |
| `componentInstance` | v1 | Phase 2 | Phase 2 | Schema defined now so decks are forward-compatible |
| `video` | v1 | Phase 2 | Phase 2 | — |
| `audio` | v1 | Phase 2 | Phase 2 | — |
| `webEmbed` | v1 | Phase 3 | Phase 3 | Needs allowlist infrastructure |

### 37.2 Feature subset

**In MVP:** absolute layout, container layouts, `align`/`distance`/`anchor`/`containment` constraints, full theme tokens, motion presets with timeline sequencing, slide transitions (cut/fade/slide/zoom), speaker notes, agent patches with transactions and pending status, provenance, inline and file data sources.

**Schema-defined, deferred in implementation:** components and variables, `equalSize`/`aspectRatio` constraints, morph transitions, interactions beyond `goToSlide`, live API/database/MCP data sources, `blendMode`, `filters`, `backdropFilters`.

### 37.3 The rule for deferred features

The schema may define a concept before the renderer implements it, but **unsupported properties must be handled safely** — preserved on round-trip (§0.8), ignored by the renderer, and never a validation error. This is what lets Phase 2 ship without a migration.

---

## 38. Acceptance Criteria

**Representation**
- [ ] a 20-slide deck serializes and deserializes without loss
- [ ] ids remain stable across saves, reorders, and group operations
- [ ] every MVP-editable object is representable (§37.1)
- [ ] unknown properties survive a round-trip through an older reader
- [ ] a document containing every element type validates

**Separation**
- [ ] layout can be modified without rewriting content
- [ ] content can be modified without rewriting layout
- [ ] theme can be swapped without touching any slide
- [ ] no editor state appears anywhere in the document
- [ ] no credential, token, or signed URL appears anywhere in the document

**Change model**
- [ ] animations target stable element ids
- [ ] an agent patch can change a single property
- [ ] every patch produces a correct inverse (property test: `apply(inverse(apply(d,p)),p) === d`)
- [ ] a pending transaction can be created, previewed, approved, and reverted
- [ ] id-addressed paths resolve correctly after a concurrent insertion

**Interoperability**
- [ ] a rendered deck exports to web, PDF, and PPTX
- [ ] each export produces a degradation report rather than silent loss
- [ ] migrations run 1.0.0 → current with a round-trip render test

**Validation**
- [ ] every rule code in §42 has a passing and a failing fixture
- [ ] validation catches invalid references, cycles, and unresolvable tokens
- [ ] `suggestedFix` is produced for every mechanically repairable rule

---

## 39. Core Architectural Rule

> The `.mydeck` model is the product's source of truth.

React components, canvas objects, DOM nodes, animation timelines, exported PPTX shapes, rendered previews, and AI prompts are all temporary representations derived from — or applied to — this model.

Two corollaries worth stating explicitly:

1. **If a fact about the presentation is not in the document, it does not exist.** A feature that requires the renderer to remember something between sessions is a schema gap, not a renderer feature.
2. **If a fact is in the document but no one can agree on it, it does not belong there.** Camera position, selection, and hover state fail this test, which is why they live in editor state (§4.1).

---

## 40. Component and Variable System

**New in v1.1.** v1.0 declared `PresentationDocument.components: ComponentDefinition[]` and never defined the type, leaving design goal #2.8 ("composable") unmet and doc 04's pipeline stage 4 ("resolve component instances") with nothing to resolve.

### 40.1 What components are for

| Use | Example |
| --- | --- |
| Repeated structure with varying content | KPI card, team member card, feature tile |
| Brand furniture | Title block, footer with logo and page number, section divider |
| Agent-safe building blocks | The Layout Agent instantiates a known-good component instead of composing five elements and hoping |
| Deck-wide consistency | Change the component, every instance updates |

The last row is the point. A 40-slide deck with 30 hand-built cards cannot be restyled; the same deck with 30 instances can.

### 40.2 Definition

```ts
export interface ComponentDefinition {
  id: Id;                               // "cmp_..."
  name: string;
  description?: string;
  version: string;                      // semver; instances pin to it
  category?: string;                    // "cards", "headers", "data"
  parameters: ComponentParameter[];     // §40.3
  slots?: ComponentSlot[];              // §40.5
  template: PresentationElement;        // usually a GroupElement
  defaultSize?: Size;
  resizeBehavior?: GroupResizeMode;
  previewAssetId?: Id;
  scope?: "document" | "workspace";     // workspace components are shared
}
```

### 40.3 Parameters and bindings — no expression language

```ts
export interface ComponentParameter {
  name: string;                         // "title", "value", "accentColor"
  label?: string;                       // UI label
  type: "text" | "richText" | "number" | "boolean" | "color" | "image" | "icon" | "enum";
  default?: unknown;
  options?: { value: unknown; label: string }[];   // enum
  required?: boolean;
  targets: ParameterTarget[];           // where this parameter lands
}

export interface ParameterTarget {
  elementPath: string;                  // path within the template, e.g. "children/0"
  property: string;                     // allowlisted, as §29.4
}
```

A parameter is wired to concrete places in the template rather than substituted into a template string. Same reasoning as §29.5: no expression language anywhere in a shareable document.

### 40.4 Instances

```ts
export interface ComponentInstanceElement extends BaseElement {
  type: "componentInstance";
  componentId: Id;
  componentVersion: string;             // pinned
  parameters: Record<string, unknown>;
  slotContent?: Record<string, PresentationElement[]>;
  overrides?: ComponentOverride[];      // §40.7
  detachedFrom?: Id;                    // set when a former instance was detached
}

export interface ComponentOverride {
  elementPath: string;                  // path within the resolved instance
  property: string;
  value: unknown;
}
```

An instance carries no children in the document. Children are produced by resolution (doc 04 §6, stage 4), which is why they must never be persisted back into the instance.

### 40.5 Slots

```ts
export interface ComponentSlot {
  name: string;
  label?: string;
  accepts?: ElementType[];              // default: any
  maxItems?: number;
  containerLayout?: ContainerLayout;
}
```

Slots hold arbitrary child elements — a card component with a `body` slot lets one instance contain a chart and another contain text, without two component definitions.

### 40.6 Variables

```ts
export interface VariableDefinition {
  type: "string" | "number" | "boolean" | "date" | "color";
  value: unknown;
  label?: string;
  description?: string;
  bindingSourceId?: Id;                 // optionally driven by a data source
}
```

Document-scoped named values referenced from `TextSpan.variableRef` (§12.1) and component parameters. Typical: client name, quarter, presenter, product version, date.

Resolution order:

```text
explicit element value
  > component override
  > component parameter value
  > variable value
  > component parameter default
  > empty (render the variable name in a placeholder style)
```

Slide-scoped variables are deliberately excluded from v1 — they invite the shadowing bugs that make templating systems hard to reason about.

### 40.7 Precedence within an instance

```text
template default  <  parameter value  <  explicit override
```

Overrides are per-property and survive component updates as long as the targeted path still exists. When it does not, the override is dropped with warning `W150` naming the instance and the lost property — visible, not silent.

### 40.8 Component versioning

Instances pin `componentVersion`. Updating a component does not retroactively change instances; the editor offers "update instances to v2" as an explicit, previewable, revertible transaction. Silent propagation of a definition change across 40 slides is exactly the kind of unreviewable edit doc 01 §4.2 exists to prevent.

### 40.9 Detach

Detaching converts an instance into a plain `GroupElement` containing the resolved children, with `metadata.detachedFrom` recording the origin. The operation is one-way and is the escape hatch for "this instance needs to be different in a way parameters do not cover".

---

## 41. Serialization: Package Form and Document Form

**New in v1.1.** §3 shows a multi-file package; §4 shows a single embedded document. v1.0 did not say how they relate, so two implementations could reasonably diverge.

### 41.1 The rule

**The single in-memory `PresentationDocument` (§4) is normative.** The package form is a serialization of it, and the mapping is total and lossless in both directions.

### 41.2 Mapping

| Package file | Document property |
| --- | --- |
| `manifest.json` | `{ schemaVersion, id, createdAt, updatedAt, appVersion, fileFormatVersion }` |
| `presentation.json` | `{ metadata, viewport, slides, variables }` |
| `theme.json` | `theme` |
| `animations.json` | Extracted `slides[].animations`, keyed by slide id |
| `components.json` | `components` |
| `data/` | `dataSources` with inline rows externalized to files |
| `assets/` | Binary content for `assets[].storageKey` |
| `metadata/sources.json` | `provenance` |
| `metadata/versions.json` | Transaction log (not part of the document proper) |

### 41.3 Why animations are extractable

Splitting `slides[].animations` into a separate file is not arbitrary. It makes a deck's motion diffable and reviewable on its own, and it lets a "remove all animation" operation be a single file removal. On load they are merged back onto their slides by id; a track referencing a missing slide is dropped with a warning.

### 41.4 Which form is used when

| Context | Form |
| --- | --- |
| Server storage | Snapshot JSON of the whole document + operation log (doc 05 §22) |
| API responses | Whole document, or slide subsets |
| Download / offline / desktop | Package (zip) |
| Version control by advanced users | Package — small, reviewable, mergeable text files |
| MCP resources | Whole document or slide subsets as JSON (doc 04 §44.1) |

The package form is what makes "presentation as code" (doc 01 §1) more than a slogan: a directory of readable JSON in a git repository, with assets alongside.

---

## 42. Validation Rule Catalog

Stable codes so the editor, agents, exporters, and the MCP surface can all reference the same rule.

### 42.1 Structural errors (`E0xx`)

| Code | Rule |
| --- | --- |
| `E001` | Duplicate id within the document |
| `E002` | Missing required property |
| `E003` | Property has the wrong type |
| `E004` | Unknown `type` for the declared `schemaVersion` major |
| `E005` | Element outside the union (`PresentationElement`) |
| `E006` | `NaN` or `Infinity` in a numeric field |
| `E007` | Negative or zero `width`/`height` |
| `E008` | Group nesting deeper than 8 |
| `E009` | Document exceeds a size limit (§0.9) |
| `E010` | `schemaVersion` missing or unparseable |
| `E011` | `updatedAt` earlier than `createdAt` |
| `E012` | `pathData` contains characters outside the SVG path grammar |

### 42.2 Referential errors (`E1xx`)

| Code | Rule |
| --- | --- |
| `E101` | `AnimationTrack.targetId` does not resolve |
| `E102` | `ImageElement.assetId` does not resolve |
| `E103` | Constraint `targetId` does not resolve |
| `E104` | `SharedElementMapping` references a missing element |
| `E105` | `Interaction.action.slideId` does not resolve |
| `E106` | `DiagramEdge.from`/`to` references a missing node |
| `E107` | `ComponentInstanceElement.componentId` does not resolve |
| `E108` | `DataBinding.sourceId` does not resolve |
| `E109` | Connector `AnchorReference.elementId` does not resolve |
| `E110` | `ChartDataReference` of type `table` references a missing table |

### 42.3 Semantic errors (`E2xx`)

| Code | Rule |
| --- | --- |
| `E201` | Cycle among `required` constraints |
| `E202` | Theme token reference does not resolve (§22.8) |
| `E203` | Two `required` constraints conflict irreconcilably |
| `E204` | Keyframe offsets not sorted ascending, or outside `0..1` |
| `E205` | `AnimationClip.durationMs` ≤ 0 |
| `E206` | `DataBinding.targetProperty` outside the allowlist (§29.4) |
| `E207` | `BindingTransform.fn` not in the allowlist (§29.5) |

### 42.4 Patch errors (`E3xx`)

| Code | Rule |
| --- | --- |
| `E301` | Path does not resolve (`id:` segment not found) |
| `E302` | `test` operation failed |
| `E303` | Patch would produce an invalid document |
| `E304` | `expectedVersionId` does not match current head |
| `E305` | Patch targets a `locked` element or a `layout.locked` slide without the required scope |
| `E306` | Patch targets an `UnknownElement` |

### 42.5 Warnings (`Wxxx`)

| Code | Rule |
| --- | --- |
| `W101` | More than one `headline` on a slide |
| `W102` | Slide has a `keyMessage` but no prominent element expressing it |
| `W103` | Text overflows its box |
| `W104` | Element outside the slide or safe area |
| `W105` | Connector lost its anchor (element deleted) |
| `W110` | Unintended overlap between non-decoration elements |
| `W111` | More than three type sizes on one slide |
| `W130` | `subTarget` does not resolve; clip skipped |
| `W131` | Overlapping animation clips on the same property |
| `W132` | Slide entrance exceeds `motion.maxSlideDurationMs` |
| `W133` | Animation preset has no reduced-motion fallback |
| `W140` | Binding transform received wrong-typed input; value passed through |
| `W141` | Binding is stale beyond its refresh policy |
| `W150` | Component override dropped: target path no longer exists |
| `W203` | Literal color used where a near-equivalent theme token exists |
| `W210` | Contrast below the pair's `minimumRatio` |
| `W220` | Asset missing `altText` |
| `W230` | Document approaching a size limit (80%) |

### 42.6 Rules with mechanical fixes

These produce `suggestedFix` operations: `W103` (switch to `shrinkToFit` or enlarge the box), `W104` (move inside the safe area), `W203` (replace the literal with the token), `W220` (generate alt text), `E204` (sort keyframes), `W131` (trim the earlier clip).

---

## 43. Open Questions

| # | Question | Impact | Recommendation |
| --- | --- | --- | --- |
| 1 | Should `RichTextDocument` back onto ProseMirror/Lexical's model rather than a bespoke one? | Editor implementation (doc 04 §17.2) | Keep bespoke; it is simpler and export-neutral. Revisit if collaborative text editing arrives. |
| 2 | Should components be workspace-scoped from day one, or document-scoped first? | Requires a `components` table (doc 05) | Document-scoped in v1; `scope` field is already present for the upgrade. |
| 3 | Should `variables` support slide scope? | Templating complexity | No. Document scope only; slide scope invites shadowing bugs. |
| 4 | Is `chartSeries` sufficient, or do charts need per-series semantic colors (positive/negative/neutral)? | Chart theming | Both are present; keep and observe usage. |
| 5 | Should provenance be exportable by default? | Privacy vs. trust | Off by default, one-click on. Revisit for regulated customers. |
| 6 | Do we need a `slideMaster`/layout-template concept distinct from components? | Deck consistency | Probably yes in V2. Components plus `SlideLayoutMetadata.templateId` cover MVP. |
| 7 | Should `Transaction` live in this document or in doc 05's data model? | Doc ownership | Type here (it is part of the change model); persistence in doc 05. |
| 8 | Multi-tenant theme inheritance depth — how many levels of `extends`? | Theme resolution cost | Cap at 3; deeper chains are unreadable. |

---

## Appendix A — Type Index

Every type defined in this document, and where.

| Type | § |
| --- | --- |
| `AnchorConstraint` | 20.1 |
| `AnchorPoint`, `AnchorReference` | 14.1 |
| `AnimatableProperty` | 24.1 |
| `AnimationClip`, `AnimationTrack` | 24 |
| `AnimationTrigger` | 25 |
| `AspectRatioConstraint` | 20.1 |
| `AssetLicense`, `AssetReference`, `AssetVariant` | 28 |
| `AudioElement` | 19.5 |
| `AxisStyle` | 17.3 |
| `BackgroundDefinition` | 7.3 |
| `BaseElement` | 8 |
| `BindingTransform` | 29.5 |
| `BlendMode` | 11 |
| `BrandCheck`, `BrandRule` | 22.7 |
| `ChartDataReference` | 17.1 |
| `ChartElement`, `ChartKind` | 17 |
| `ChartEncoding` | 17.2 |
| `ChartStyle` | 17.3 |
| `ChartTheme` | 22.6 |
| `CodeElement` | 19.3 |
| `ColorTokens` | 22.1 |
| `ColorValue` | 0.4 |
| `CommonStyle` | 11 |
| `ComponentDefinition` | 40.2 |
| `ComponentInstanceElement`, `ComponentOverride` | 40.4 |
| `ComponentParameter`, `ParameterTarget` | 40.3 |
| `ComponentSlot` | 40.5 |
| `ConstraintPriority` | 20.1 |
| `ContainerLayout` | 21 |
| `ContainmentConstraint` | 20.1 |
| `ContrastPair` | 22.2 |
| `CornerRadius` | 0.5 |
| `CropDefinition` | 15.1 |
| `DataBinding` | 29.3 |
| `DataSourceDefinition` | 29 |
| `DiagramEdge`, `DiagramNode` | 18.1 |
| `DiagramElement`, `DiagramKind` | 18 |
| `DiagramGroup` | 18.4 |
| `DiagramLayoutHint` | 18.3 |
| `DiagramTheme` | 22.6 |
| `DistanceConstraint` | 20.1 |
| `Easing` | 0.6 |
| `ElementMetadata` | 8.5 |
| `ElementType` | 8.1 |
| `EqualSizeConstraint` | 20.1 |
| `GradientStop` | 0.4 |
| `GridTokens` | 22.5 |
| `GroupElement`, `GroupResizeMode` | 16 |
| `HorizontalAlign`, `VerticalAlign` | 0.7 |
| `Id` | 0.2 |
| `IconElement`, `IconReference` | 19.1 |
| `ImageElement`, `ImageFit` | 15, 0.7 |
| `ImageryTheme` | 22.6 |
| `Insets`, `Point`, `Rect`, `Size` | 0.3 |
| `Interaction` | 27 |
| `Keyframe` | 24.1 |
| `LayoutConstraint` | 20 |
| `LineElement` | 14 |
| `MarkerKind` | 13 |
| `MaskDefinition` | 15.2 |
| `MotionTheme` | 23 |
| `Normalized` | 0.3 |
| `NumberFormat` | 29.5 |
| `Paint` | 0.4 |
| `ParagraphStyle` | 12.3 |
| `Patch`, `PatchOperation`, `PatchPath` | 31 |
| `PresentationDocument` | 4 |
| `PresentationElement` | 8.6 |
| `PresentationMetadata` | 5 |
| `PresentationViewport` | 6 |
| `PropertyTrack` | 24.1 |
| `ProvenanceRecord` | 30 |
| `RadiusTokens` | 22.4 |
| `RefreshPolicy` | 29 |
| `RichTextDocument`, `TextBlock`, `TextSpan` | 12.1 |
| `SemanticRole` | 9 |
| `ShadowStyle`, `ShadowTokens` | 0.5, 22.4 |
| `ShapeElement`, `ShapeKind` | 13 |
| `SharedElementMapping` | 26 |
| `Slide` | 7 |
| `SlideLayoutMetadata` | 7.4 |
| `SlideTransition` | 26 |
| `SpacingTokens` | 22.4 |
| `StrokeStyle` | 0.5 |
| `TableCell`, `TableColumn`, `TableElement`, `TableRow`, `TableStyle` | 19.2 |
| `TextElement`, `TextFit` | 12 |
| `ThemeDefinition` | 22 |
| `Transaction`, `TransactionStatus` | 31.5 |
| `Transform` | 10 |
| `TypographyStyle` | 12.2 |
| `TypographyTokens` | 22.3 |
| `UnknownElement` | 8.7 |
| `ValidationIssue`, `ValidationReport` | 34.5 |
| `VariableDefinition` | 40.6 |
| `VideoElement` | 19.4 |
| `VisualFilter` | 0.5 |
| `WebEmbedElement` | 19.6 |

---

## Appendix B — Changes Implied for Other Documents

| Document | Change | Register item |
| --- | --- | --- |
| `01_PRODUCT_REQUIREMENTS` §8.3 | Replace the element list with a reference to §37.1; `table` is MVP, `icon` is MVP | S2 |
| `01` §11.1 | Keep the six scopes; doc 03 must match | Cross-cutting #1 |
| `03_AGENT_ARCHITECTURE` §6 | Add `"sources"` to `EditScope.type` | **S1** |
| `03` §15 | Tool registry: `presentation.createPatch` emits id-addressed paths (§31.3) | S1 |
| `03` §16 | Replace `AgentTransaction` with a reference to §31.5; add `status` | Cross-cutting #2 |
| `03` §17 | Risk tiers are computed server-side per §31.7 | S2 |
| `04_CANVAS_RENDERING` §6 | Pipeline stage 4 now resolves against §40 | — |
| `04` §29.1 | Id-addressed paths adopted; the recommendation there is now normative | S1 |
| `05_MVP_SYSTEM` §11 | Replace the local `Transaction` type with a reference to §31.5 | Cross-cutting #2 |
| `05` §21 | Add `status`, `parent_version_id`, `result_version_id` to `transactions`; add a `components` table when component scope becomes workspace-level; add a `themes` table (§22, `extends`) | S1/S2 |
| `05` §24 | `AssetReference.storageKey` is the stored form; signed URLs are minted at render time | S2 |
| `05` §33 | Add a fixture corpus with one passing and one failing document per §42 rule code | S3 |

---

## Appendix C — Change Log

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | — | Initial foundation draft, §1–§39 |
| 1.1 | 2026-09-05 | Added §0 conventions and primitives. Declared `PresentationElement` (§8.6) and `UnknownElement` (§8.7). Wired `ContainerLayout` to `GroupElement` (§16.2). Added the component and variable system (§40). Removed `Slide.order` and defined single ordering authority (§7.2, §8.4). Defined id-addressed patch paths and added `test`/`copy` (§31.3). Replaced `DataBinding.transform` with a declarative allowlist (§29.5). Defined `RichTextDocument` (§12.1), `IconElement`, `TableElement`, `VideoElement`, `AudioElement`, `WebEmbedElement` (§19), and all previously undefined referenced types. Expanded theme tokens and unified typography naming (§22). Renamed `AssetReference.uri` to `storageKey` (§28.1). Consolidated the transaction lineage (§31). Defined the package ↔ document mapping (§41). Added the validation rule catalog (§42). Clarified animation timing, keyframe normalization, and conflict rules (§24.4–§24.6). Reconciled the MVP element list with doc 01 (§37.1). Added type index and cross-document change list. |
