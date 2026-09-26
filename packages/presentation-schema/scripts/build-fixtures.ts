/**
 * Builds the three canonical seed documents (doc 05 §35).
 *
 * These are the standing fixture set: every later phase — renderer, editor,
 * export adapters, agent evaluation — tests against them. They are generated
 * rather than hand-written so the schema and the fixtures cannot drift, and the
 * ids are deterministic so a regenerated fixture produces a zero-line diff and
 * visual regression stays meaningful.
 *
 *   npm run fixtures:build --workspace @deckastra/presentation-schema
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_VIEWPORT,
  SCHEMA_VERSION,
  plainText,
  serializeDocument,
  validateDocument,
  type PresentationDocument,
  type PresentationElement,
  type Slide,
  type ThemeDefinition,
} from "../src/index";
import { technicalTheme } from "../src/theme-presets";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures");

const CREATED_AT = "2026-01-01T00:00:00Z";

/**
 * Deterministic id minting. Real ids are ULIDs; fixture ids only have to satisfy
 * the same grammar (26 Crockford base32 characters) and be stable.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function makeIdFactory(namespace: number) {
  let counter = 0;
  return (prefix: string): string => {
    const n = counter++;
    const tail = `${namespace}`.padStart(2, "0") + `${n}`.padStart(4, "0");
    const body = ("01JB8Z9K2QW4RN7F3X" + tail.replace(/\d/g, (d) => ALPHABET[Number(d)]!)).padEnd(
      26,
      "0",
    );
    return `${prefix}_${body.slice(0, 26)}`;
  };
}

// --------------------------------------------------------------------- theme

// The fixtures' theme is the Neo Technical preset, defined once in
// `src/theme-presets.ts`: a fixture and the theme gallery must not drift apart.

// ------------------------------------------------------------------ builders

interface DocInput {
  id: string;
  title: string;
  slides: Slide[];
  theme: ThemeDefinition;
  assets?: PresentationDocument["assets"];
  provenance?: PresentationDocument["provenance"];
  metadata?: Partial<PresentationDocument["metadata"]>;
}

function buildDocument(input: DocInput): PresentationDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    metadata: {
      title: input.title,
      language: "en",
      ...input.metadata,
    },
    viewport: DEFAULT_VIEWPORT,
    theme: input.theme,
    slides: input.slides,
    assets: input.assets ?? [],
    components: [],
    dataSources: [],
    variables: {},
    ...(input.provenance ? { provenance: input.provenance } : {}),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

// ------------------------------------------------- fixture 1: technical deck

function technicalDeck(): PresentationDocument {
  const id = makeIdFactory(1);
  const theme = technicalTheme(id("thm"));

  const titleSlide: Slide = {
    id: id("sld"),
    name: "Title",
    semanticIntent: "Establish what the system is and who built it, in one breath",
    keyMessage: "Deckastra turns repositories into presentations that stay editable",
    background: { paint: { type: "solid", color: "token:colors.background" } },
    elements: [
      {
        id: id("el"),
        type: "text",
        name: "Eyebrow",
        semanticRole: "eyebrow",
        transform: { x: 120, y: 320, width: 800, height: 40 },
        content: plainText("ARCHITECTURE REVIEW", id("blk")),
        typography: {
          fontFamily: "token:typography.caption.fontFamily",
          fontSize: 16,
          letterSpacing: 4,
          color: "token:colors.accent",
          textTransform: "uppercase",
        },
      },
      {
        id: id("el"),
        type: "text",
        name: "Headline",
        semanticRole: "headline",
        transform: { x: 120, y: 380, width: 1300, height: 240 },
        content: plainText("Agents propose. Deterministic engines compose.", id("blk")),
        typography: {
          fontFamily: "token:typography.display.fontFamily",
          fontSize: 96,
          fontWeight: 700,
          lineHeight: 1.05,
          letterSpacing: -2,
          color: "token:colors.foreground",
        },
        fit: "shrinkToFit",
        minFontSize: 56,
        paragraph: { lineBreakStrategy: "balanced" },
      },
      {
        id: id("el"),
        type: "text",
        name: "Subtitle",
        semanticRole: "subtitle",
        transform: { x: 120, y: 650, width: 1000, height: 80 },
        content: plainText("How the .mydeck document model keeps humans in control", id("blk")),
        typography: {
          fontFamily: "token:typography.body.fontFamily",
          fontSize: 24,
          color: "token:colors.foregroundMuted",
        },
      },
    ],
    animations: [],
    transition: { type: "fade", durationMs: 300 },
  };

  // A KPI row emitted as a horizontal container rather than three absolute boxes.
  // This is the difference between a slide that survives real content and one that
  // overlaps the moment a label runs long.
  const kpiCard = (label: string, value: string, x: number): PresentationElement => ({
    id: id("el"),
    type: "group",
    name: `KPI ${label}`,
    groupRole: "kpiCard",
    transform: { x, y: 0, width: 380, height: 240 },
    containerLayout: { type: "vertical", gap: 16, align: "start", padding: { top: 32, right: 32, bottom: 32, left: 32 } },
    resizeMode: "resizeContainer",
    style: {
      fill: { type: "solid", color: "token:colors.surface" },
      cornerRadius: 12,
      stroke: { paint: { type: "solid", color: "token:colors.border" }, width: 1 },
    },
    children: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "metric",
        transform: { x: 0, y: 0, width: 316, height: 100 },
        content: plainText(value, id("blk")),
        typography: {
          fontFamily: "token:typography.metric.fontFamily",
          fontSize: 72,
          fontWeight: 700,
          color: "token:colors.accent",
          fontFeatures: ["tnum"],
        },
      },
      {
        id: id("el"),
        type: "text",
        semanticRole: "caption",
        transform: { x: 0, y: 116, width: 316, height: 56 },
        content: plainText(label, id("blk")),
        typography: {
          fontFamily: "token:typography.caption.fontFamily",
          fontSize: 18,
          color: "token:colors.foregroundMuted",
        },
        fit: "autoHeight",
      },
    ],
  });

  const kpiSlide: Slide = {
    id: id("sld"),
    name: "Budgets",
    semanticIntent: "Show that the performance targets are numbers, not adjectives",
    keyMessage: "Every renderer budget is instrumented, not aspirational",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 120, width: 1200, height: 100 },
        content: plainText("Budgets that are dashboard lines", id("blk")),
        typography: { fontFamily: "token:typography.h1.fontFamily", fontSize: 64, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: id("el"),
        type: "group",
        name: "KPI row",
        groupRole: "kpiRow",
        transform: { x: 120, y: 340, width: 1680, height: 240 },
        containerLayout: { type: "horizontal", gap: 24, distribute: "equal", align: "stretch" },
        resizeMode: "resizeContainer",
        children: [
          kpiCard("Typical slide first paint", "250ms", 0),
          kpiCard("Drag frame time p95", "16ms", 404),
          kpiCard("Slide switch, warm", "120ms", 808),
          kpiCard("60-slide deck memory", "600MB", 1212),
        ],
      },
    ],
    transition: { type: "fade", durationMs: 300 },
  };

  const nodeId = { input: id("nd"), orchestrator: id("nd"), story: id("nd"), layout: id("nd"), critic: id("nd"), store: id("nd") };

  const architectureSlide: Slide = {
    id: id("sld"),
    name: "Architecture",
    semanticIntent: "Explain how a request moves through the agent graph and where the human checkpoint sits",
    keyMessage: "No agent writes to the store; every change goes through the transaction service",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 100, width: 1200, height: 90 },
        content: plainText("The agent graph", id("blk")),
        typography: { fontFamily: "token:typography.h1.fontFamily", fontSize: 64, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: id("el"),
        type: "diagram",
        name: "Agent pipeline",
        semanticRole: "mainDiagram",
        transform: { x: 120, y: 260, width: 1680, height: 620 },
        diagramType: "architecture",
        layoutHint: { algorithm: "layered", direction: "LR", mode: "hybrid", nodeSpacing: 48, rankSpacing: 96 },
        nodes: [
          { id: nodeId.input, label: "User request", role: "external", rank: 0 },
          { id: nodeId.orchestrator, label: "Orchestrator", sublabel: "routes and budgets", role: "service", rank: 1 },
          { id: nodeId.story, label: "Story Architect", role: "service", rank: 2 },
          { id: nodeId.layout, label: "Layout Agent", sublabel: "proposes, never places pixels", role: "service", rank: 2 },
          { id: nodeId.critic, label: "Critic", role: "service", rank: 3 },
          { id: nodeId.store, label: "Transaction service", sublabel: "the only writer", role: "datastore", rank: 4 },
        ],
        edges: [
          { id: id("edg"), from: nodeId.input, to: nodeId.orchestrator },
          { id: id("edg"), from: nodeId.orchestrator, to: nodeId.story },
          { id: id("edg"), from: nodeId.orchestrator, to: nodeId.layout },
          { id: id("edg"), from: nodeId.story, to: nodeId.critic, label: "story plan" },
          { id: id("edg"), from: nodeId.layout, to: nodeId.critic, label: "candidates" },
          { id: id("edg"), from: nodeId.critic, to: nodeId.store, label: "accepted patch" },
          { id: id("edg"), from: nodeId.critic, to: nodeId.layout, label: "revise", kind: "dashed", direction: "forward" },
        ],
        groups: [
          {
            id: id("grp"),
            label: "Model-driven",
            kind: "boundary",
            nodeIds: [nodeId.orchestrator, nodeId.story, nodeId.layout, nodeId.critic],
          },
        ],
      },
    ],
    transition: { type: "fade", durationMs: 300 },
  };

  const tableSlide: Slide = {
    id: id("sld"),
    name: "Export fidelity",
    semanticIntent: "Set expectations about what survives each export target",
    keyMessage: "The model does not shrink to the weakest export target; adapters degrade and report",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 100, width: 1200, height: 90 },
        content: plainText("What survives export", id("blk")),
        typography: { fontFamily: "token:typography.h1.fontFamily", fontSize: 64, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: id("el"),
        type: "table",
        name: "Export capability",
        transform: { x: 120, y: 280, width: 1680, height: 480 },
        headerRow: true,
        columns: [
          { id: id("col"), label: "Property", align: "left" },
          { id: id("col"), label: "PDF", align: "left" },
          { id: id("col"), label: "PPTX", align: "left" },
        ],
        rows: [
          { id: id("row"), cells: [{ content: "Solid and gradient fill" }, { content: "Full" }, { content: "Full" }] },
          { id: id("row"), cells: [{ content: "Per-corner radius" }, { content: "Full" }, { content: "Rasterized" }] },
          { id: id("row"), cells: [{ content: "Blend modes" }, { content: "Partial" }, { content: "Rasterized" }] },
          { id: id("row"), cells: [{ content: "Backdrop filters" }, { content: "Rasterized" }, { content: "Rasterized" }] },
        ],
        tableStyle: { banding: "rows", borders: "horizontal", compact: false },
      },
    ],
    transition: { type: "fade", durationMs: 300 },
  };

  const codeSlide: Slide = {
    id: id("sld"),
    name: "Patch shape",
    semanticIntent: "Show that an AI edit is a narrow, reviewable operation",
    keyMessage: "An agent changes one property, not a whole slide",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 100, width: 1200, height: 90 },
        content: plainText("One property, not a rewrite", id("blk")),
        typography: { fontFamily: "token:typography.h1.fontFamily", fontSize: 64, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: id("el"),
        type: "code",
        name: "Patch example",
        transform: { x: 120, y: 300, width: 1680, height: 320 },
        language: "json",
        fileName: "patch.json",
        showLineNumbers: true,
        code: [
          "{",
          '  "op": "replace",',
          '  "path": "/slides/id:sld_04/elements/id:el_12/typography/fontSize",',
          '  "value": 72',
          "}",
        ].join("\n"),
      },
      {
        id: id("el"),
        type: "text",
        semanticRole: "caption",
        transform: { x: 120, y: 660, width: 1400, height: 60 },
        content: plainText(
          "Id-addressed paths survive a concurrent insertion; index paths do not.",
          id("blk"),
        ),
        typography: { fontFamily: "token:typography.caption.fontFamily", fontSize: 20, color: "token:colors.foregroundMuted" },
      },
    ],
    transition: { type: "fade", durationMs: 300 },
  };

  // The document's own id, taken *before* the image below so it keeps the value
  // it has always had. The counter is shared across prefixes, so minting the
  // image first would have shifted this one — which it did, on the first attempt.
  const documentId = id("doc");

  // An image, minted **after** every other id in this deck.
  //
  // The counter is shared across prefixes, so a new `id()` call anywhere earlier
  // renumbers everything after it — and a fixture whose ids churn makes every
  // visual-regression snapshot fail for no reason. Appended here and pushed onto
  // a slide, rather than written where it reads most naturally.
  //
  // It earns its place the way the rest of this deck does: `technical-deck` is
  // "every MVP element type" and had no image at all, so the scene build's image
  // payload, PPTX's degradation for one, the accessibility alt-text rule and the
  // renderer's unresolved-asset placeholder were between them exercised by
  // nothing. There is no resolver in a headless render, so what the baselines
  // record is that placeholder — which is exactly what an export produces today,
  // and is therefore the honest thing to pin.
  const diagramImage = {
    id: id("ast"),
    type: "image" as const,
    storageKey: "fixtures/architecture-overview.png",
    fileName: "architecture-overview.png",
    mimeType: "image/png",
    byteSize: 148_204,
    width: 1600,
    height: 900,
    // On the manifest entry as well as the element: `W220` asks for it here,
    // because an asset can be cited from more than one slide and the description
    // of what the picture *is* belongs with the picture.
    altText: "The composer pipeline, drawn on a whiteboard",
  };
  architectureSlide.elements.push({
    id: id("el"),
    type: "image",
    name: "Pipeline photograph",
    // The clear band below the diagram, on the same 120px left margin the
    // headline and the diagram use. Placed at 1180,620 first, where it clipped
    // under the "Transaction service" node — the diagram's element box is
    // 1680x620 while its painted content sits in the upper half, so "inside the
    // diagram's bounds" and "over the diagram" are not the same thing and only
    // looking at the render tells you which.
    transform: { x: 120, y: 900, width: 280, height: 158 },
    assetId: diagramImage.id,
    fit: "contain",
    // WCAG 1.1.1, which `accessibility.ts` checks and the three seed decks are
    // required to pass.
    altText: "The composer pipeline, drawn on a whiteboard",
  });

  return buildDocument({
    id: documentId,
    title: "Deckastra Architecture Review",
    theme,
    assets: [diagramImage],
    slides: [titleSlide, kpiSlide, architectureSlide, tableSlide, codeSlide],
    metadata: {
      presentationType: "technical",
      audience: "Engineers joining the project",
      objective: "Explain the document model and why AI edits stay reviewable",
      estimatedDurationSeconds: 600,
      description: "The standing fixture for renderer, editor and export tests.",
    },
  });
}

// ------------------------------------------- fixture 2: repository context

function repositoryDeck(): PresentationDocument {
  const id = makeIdFactory(2);
  const theme = technicalTheme(id("thm"));

  const summaryElementId = id("el");
  const metricElementId = id("el");

  const overview: Slide = {
    id: id("sld"),
    name: "Repository overview",
    semanticIntent: "Say what the repository is before saying anything about how it works",
    keyMessage: "A payments reconciliation service with three external dependencies",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 140, width: 1300, height: 180 },
        content: plainText("ledger-recon", id("blk")),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 96, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: summaryElementId,
        type: "text",
        semanticRole: "body",
        transform: { x: 120, y: 380, width: 1100, height: 200 },
        content: plainText(
          "A Python service that reconciles payment ledgers against processor settlements, flags mismatches, and exposes a review queue.",
          id("blk"),
        ),
        typography: { fontFamily: "token:typography.body.fontFamily", fontSize: 28, lineHeight: 1.45, color: "token:colors.foregroundMuted" },
        fit: "autoHeight",
      },
      {
        id: metricElementId,
        type: "text",
        semanticRole: "metric",
        transform: { x: 1400, y: 380, width: 400, height: 200 },
        content: plainText("34k", id("blk")),
        typography: {
          fontFamily: "token:typography.metric.fontFamily",
          fontSize: 88,
          fontWeight: 700,
          color: "token:colors.accent",
          fontFeatures: ["tnum"],
        },
      },
    ],
    transition: { type: "fade", durationMs: 300 },
  };

  const chartSlide: Slide = {
    id: id("sld"),
    name: "Language mix",
    semanticIntent: "Ground the claim that this is a Python service with a small TypeScript surface",
    keyMessage: "Python dominates; the TypeScript is a thin review UI",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 100, width: 1200, height: 90 },
        content: plainText("Language mix", id("blk")),
        typography: { fontFamily: "token:typography.h1.fontFamily", fontSize: 64, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: id("el"),
        type: "chart",
        name: "Lines by language",
        semanticRole: "primaryChart",
        transform: { x: 120, y: 260, width: 1200, height: 600 },
        chartType: "bar",
        altText: "Bar chart of source lines by language: Python 24100, TypeScript 6400, SQL 2300, Shell 900",
        data: {
          type: "inline",
          rows: [
            { language: "Python", lines: 24100 },
            { language: "TypeScript", lines: 6400 },
            { language: "SQL", lines: 2300 },
            { language: "Shell", lines: 900 },
          ],
        },
        encoding: { category: "language", value: "lines", sort: { by: "value", direction: "desc" } },
        chartStyle: { showLegend: false, showGridlines: true, numberFormat: { style: "compact" } },
      },
    ],
    transition: { type: "fade", durationMs: 300 },
  };

  return buildDocument({
    id: id("doc"),
    title: "ledger-recon — Architecture Walkthrough",
    theme,
    slides: [overview, chartSlide],
    metadata: {
      presentationType: "technical",
      audience: "New engineers onboarding to the payments team",
      objective: "Explain what ledger-recon does and where its boundaries are",
      estimatedDurationSeconds: 480,
      description: "Repository-grounded fixture. Every claim carries a provenance record.",
    },
    // Provenance lives in the document, not a side table: the user must be able to
    // click a claim and see which file produced it, and that has to survive export
    // and duplication.
    provenance: [
      {
        id: id("prv"),
        targetId: summaryElementId,
        sourceType: "github",
        sourceReference: "acme/ledger-recon#README.md:1-24",
        excerpt: "ledger-recon reconciles payment ledgers against processor settlements.",
        confidence: 0.94,
        agentId: "repository",
        createdAt: CREATED_AT,
      },
      {
        id: id("prv"),
        targetId: metricElementId,
        sourceType: "github",
        sourceReference: "acme/ledger-recon#cloc.json",
        excerpt: "total: 33700",
        confidence: 0.81,
        agentId: "repository",
        createdAt: CREATED_AT,
      },
    ],
  });
}

// ----------------------------------------------- fixture 3: animation test

function animationDeck(): PresentationDocument {
  const id = makeIdFactory(3);
  const theme = technicalTheme(id("thm"));

  const headlineId = id("el");
  const cardAId = id("el");
  const cardBId = id("el");
  const metricId = id("el");

  const card = (elementId: string, label: string, x: number): PresentationElement => ({
    id: elementId,
    type: "shape",
    name: label,
    transform: { x, y: 520, width: 480, height: 240 },
    shape: "rectangle",
    // opacity 0, never visible:false — a hidden element is excluded from layout
    // and export, so a fade-in that started from visible:false would break both.
    opacity: 0,
    style: {
      fill: { type: "solid", color: "token:colors.surface" },
      cornerRadius: 12,
      stroke: { paint: { type: "solid", color: "token:colors.border" }, width: 1 },
    },
    text: plainText(label, id("blk")),
    textPadding: { top: 32, right: 32, bottom: 32, left: 32 },
  });

  const sequenced: Slide = {
    id: id("sld"),
    name: "Sequenced entrance",
    semanticIntent: "Exercise slideEnter, afterPrevious and withPrevious in one timeline",
    keyMessage: "Motion reinforces narrative order",
    elements: [
      {
        id: headlineId,
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 200, width: 1400, height: 180 },
        opacity: 0,
        content: plainText("Motion reinforces order", id("blk")),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 88, fontWeight: 700, color: "token:colors.foreground" },
      },
      card(cardAId, "Proposed", 120),
      card(cardBId, "Applied", 640),
      {
        id: metricId,
        type: "text",
        semanticRole: "metric",
        transform: { x: 1240, y: 520, width: 560, height: 240 },
        opacity: 0,
        content: plainText("0", id("blk")),
        typography: {
          fontFamily: "token:typography.metric.fontFamily",
          fontSize: 88,
          fontWeight: 700,
          color: "token:colors.accent",
          fontFeatures: ["tnum"],
        },
      },
    ],
    animations: [
      {
        id: id("anm"),
        targetId: headlineId,
        trigger: { type: "slideEnter" },
        label: "Headline fade up",
        clips: [
          {
            id: id("clp"),
            preset: "fadeUp",
            startMs: 0,
            durationMs: 400,
            easing: "emphasized",
            reducedMotionPreset: "fade",
            propertyTracks: [
              { property: "opacity", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] },
              { property: "y", keyframes: [{ offset: 0, value: 24 }, { offset: 1, value: 0 }] },
            ],
          },
        ],
      },
      {
        id: id("anm"),
        targetId: cardAId,
        trigger: { type: "afterPrevious" },
        label: "First card",
        clips: [
          {
            id: id("clp"),
            preset: "fadeUp",
            startMs: 0,
            durationMs: 400,
            easing: "emphasized",
            reducedMotionPreset: "fade",
            propertyTracks: [
              { property: "opacity", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] },
            ],
          },
        ],
      },
      {
        id: id("anm"),
        targetId: cardBId,
        // withPrevious plus a startMs offset is how a stagger is expressed: the
        // trigger resolves to the previous track's START, and startMs is added.
        trigger: { type: "withPrevious" },
        label: "Second card, staggered",
        clips: [
          {
            id: id("clp"),
            preset: "fadeUp",
            startMs: 70,
            durationMs: 400,
            easing: "emphasized",
            reducedMotionPreset: "fade",
            propertyTracks: [
              { property: "opacity", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 1 }] },
            ],
          },
        ],
      },
      {
        id: id("anm"),
        targetId: metricId,
        trigger: { type: "afterPrevious" },
        label: "Count up",
        clips: [
          {
            id: id("clp"),
            preset: "numberCount",
            presetParams: { from: 0, to: 128 },
            startMs: 0,
            durationMs: 700,
            easing: "easeOut",
            // Counting is meaningless at reduced motion; land on the end value.
            reducedMotionBehavior: "instant",
            propertyTracks: [
              { property: "numberValue", keyframes: [{ offset: 0, value: 0 }, { offset: 1, value: 128 }] },
            ],
          },
        ],
      },
    ],
    timelineMarkers: [{ id: "evidence-revealed", timeMs: 1200, label: "Evidence revealed" }],
    transition: { type: "fade", durationMs: 300 },
  };

  // Click triggers, a staggered group and a drawn path. Without these the deck
  // claims in its own metadata to exercise every MVP trigger and preset shape
  // while covering neither segments nor stagger — and segments are the half of
  // the playback engine a presenter actually drives.
  const groupId = id("el");
  const bulletIds = [id("el"), id("el"), id("el")];
  const arrowId = id("el");

  const bullet = (elementId: string, label: string, y: number): PresentationElement => ({
    id: elementId,
    type: "text",
    semanticRole: "body",
    transform: { x: 0, y, width: 900, height: 90 },
    opacity: 0,
    content: plainText(label, id("blk")),
    typography: { fontFamily: "token:typography.body.fontFamily", fontSize: 44, color: "token:colors.foreground" },
  });

  const clickReveal: Slide = {
    id: id("sld"),
    name: "Click to reveal",
    semanticIntent: "Exercise click segments, staggered children and a drawn path",
    keyMessage: "The presenter paces the slide, not the timeline",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 160, width: 1400, height: 140 },
        content: plainText("Revealed on click", id("blk")),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 72, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: groupId,
        type: "group",
        name: "Bullets",
        transform: { x: 120, y: 380, width: 900, height: 300 },
        children: [
          bullet(bulletIds[0]!, "Agents propose", 0),
          bullet(bulletIds[1]!, "Deterministic engines compose", 100),
          bullet(bulletIds[2]!, "Humans stay in control", 200),
        ],
      },
      {
        id: arrowId,
        type: "line",
        transform: { x: 1140, y: 420, width: 560, height: 200 },
        from: { x: 0, y: 0 },
        to: { x: 560, y: 200 },
        style: { stroke: { paint: { type: "solid", color: "token:colors.accent" }, width: 6 } },
        endMarker: "arrow",
      },
    ],
    animations: [
      {
        id: id("anm"),
        targetId: groupId,
        // The first click. A click trigger opens a segment: playback runs to the
        // boundary and waits, which is what present mode's arrow key advances.
        trigger: { type: "click" },
        label: "Reveal the bullets",
        clips: [
          {
            id: id("clp"),
            preset: "staggerReveal",
            presetParams: { childPreset: "slide", direction: "up", distance: 32, staggerMs: 90 },
            startMs: 0,
            durationMs: 350,
            easing: "emphasized",
          },
        ],
      },
      {
        id: id("anm"),
        targetId: arrowId,
        trigger: { type: "click" },
        label: "Draw the arrow",
        clips: [
          {
            id: id("clp"),
            preset: "drawPath",
            startMs: 0,
            durationMs: 500,
            easing: "easeInOut",
            // A path that fades in says something different from one that draws;
            // under reduced motion the honest answer is the finished path.
            reducedMotionBehavior: "instant",
          },
        ],
      },
    ],
    transition: { type: "slide", durationMs: 400, direction: "left" },
  };

  // Captured rather than inlined: the morph slide below pairs against it, and a
  // shared-element mapping names ids. Declared at the same call position so
  // every id after it keeps the value it already had.
  const zoomHeadlineId = id("el");
  const zoomBadgeId = id("el");

  const transitionTarget: Slide = {
    id: id("sld"),
    name: "Transition target",
    semanticIntent: "Receiving slide for transition tests",
    keyMessage: "Transitions belong to the slide being entered",
    elements: [
      {
        id: zoomHeadlineId,
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 440, width: 1400, height: 200 },
        content: plainText("Entered with a zoom", id("blk")),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 88, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: zoomBadgeId,
        type: "shape",
        shape: "pill",
        semanticRole: "decoration",
        transform: { x: 1500, y: 180, width: 220, height: 120 },
        style: { fill: { type: "solid", color: "token:colors.accent" } },
      },
    ],
    // A slide's transition describes how the deck moves INTO it, so reordering
    // carries the entrance along — which is what authors expect.
    transition: { type: "zoom", durationMs: 500, easing: "emphasized" },
  };

  /**
   * The shared-element morph (doc 02 §26, doc 04 §33.3).
   *
   * Here because the conformance deck is where a transition the product can
   * draw has to be exercised, and until this existed no fixture carried a morph
   * or a single `sharedElements` mapping — so nothing in the repository touched
   * the pairing, the deltas or the two-stage present path that draws them.
   *
   * Both mappings are deliberate. The headline moves *and* resizes, which is the
   * case centre-to-centre deltas exist for: corner-to-corner would drift
   * sideways as the box grows. The badge is paired `position` only, so an author
   * deciding that two sizes differ for a reason is a permission the engine has
   * to honour rather than a hint it may override.
   */
  const morphHeadlineId = id("el");
  const morphBadgeId = id("el");

  const morphTarget: Slide = {
    id: id("sld"),
    name: "Morph target",
    semanticIntent: "Receiving slide for a shared-element morph",
    keyMessage: "Paired elements travel; everything else crossfades",
    elements: [
      {
        id: morphHeadlineId,
        type: "text",
        semanticRole: "headline",
        // Moved and much larger than its partner, so the delta is unmistakable
        // in a rendered frame rather than a rounding difference. The box is
        // sized for two lines at this face: the first attempt overflowed, which
        // the scene digest caught and a conformance deck must never ship.
        transform: { x: 200, y: 120, width: 1520, height: 420 },
        content: plainText("The same headline, moved", id("blk")),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 132, fontWeight: 700, color: "token:colors.foreground" },
      },
      {
        id: morphBadgeId,
        type: "shape",
        shape: "pill",
        semanticRole: "decoration",
        transform: { x: 200, y: 760, width: 220, height: 120 },
        style: { fill: { type: "solid", color: "token:colors.accent" } },
      },
    ],
    transition: {
      type: "morph",
      durationMs: 600,
      easing: "emphasized",
      sharedElements: [
        { sourceElementId: zoomHeadlineId, destinationElementId: morphHeadlineId, matchMode: "positionAndScale" },
        { sourceElementId: zoomBadgeId, destinationElementId: morphBadgeId, matchMode: "position" },
      ],
    },
  };

  return buildDocument({
    id: id("doc"),
    title: "Animation Conformance Deck",
    theme,
    slides: [sequenced, clickReveal, transitionTarget, morphTarget],
    metadata: {
      presentationType: "technical",
      audience: "The animation engine test suite",
      objective: "Exercise every MVP trigger, preset shape and reduced-motion path",
      estimatedDurationSeconds: 120,
      description: "Seek/play parity and reduced-motion fixtures live here.",
    },
  });
}

// ------------------------------------------------------------------- write

const FIXTURES: { file: string; build: () => PresentationDocument }[] = [
  { file: "technical-deck.mydeck.json", build: technicalDeck },
  { file: "repository-context.mydeck.json", build: repositoryDeck },
  { file: "animation-test.mydeck.json", build: animationDeck },
];

function main(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  let failed = false;

  for (const { file, build } of FIXTURES) {
    const doc = build();
    const report = validateDocument(doc);

    if (!report.valid) {
      failed = true;
      console.error(`\n${file} is INVALID:`);
      for (const e of report.errors) console.error(`  ${e.code} ${e.path}: ${e.message}`);
      continue;
    }

    writeFileSync(join(FIXTURE_DIR, file), JSON.stringify(doc, null, 2) + "\n", "utf8");
    const warn = report.warnings.length ? ` (${report.warnings.length} warnings)` : "";
    console.log(`  wrote ${file}${warn}`);
    for (const w of report.warnings) console.log(`      ${w.code} ${w.path}: ${w.message}`);
  }

  if (failed) process.exit(1);
}

main();
