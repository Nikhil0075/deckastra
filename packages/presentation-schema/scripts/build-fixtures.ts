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
} from "../src/index.js";

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

function technicalTheme(id: string): ThemeDefinition {
  const mono = "JetBrains Mono";
  const sans = "Inter";
  return {
    id,
    name: "Neo Technical",
    description: "Dark editorial layout with luminous technical accents.",
    mode: "dark",
    colors: {
      background: "#0B0F14",
      surface: "#121821",
      surfaceAlt: "#1A222E",
      overlay: "#000000B3",
      foreground: "#E8EEF5",
      foregroundMuted: "#9FB0C3",
      foregroundSubtle: "#6B7C90",
      accent: "#4CC2FF",
      accentForeground: "#04121C",
      accentMuted: "#1E5F80",
      secondary: "#A78BFA",
      secondaryForeground: "#150C2E",
      border: "#243141",
      borderStrong: "#35485D",
      divider: "#1C2530",
      success: "#3DDC97",
      warning: "#F2C14E",
      danger: "#FF6B6B",
      info: "#4CC2FF",
      chartSeries: ["#4CC2FF", "#A78BFA", "#3DDC97", "#F2C14E", "#FF6B6B", "#7DD3FC"],
      chartPositive: "#3DDC97",
      chartNegative: "#FF6B6B",
      chartNeutral: "#6B7C90",
    },
    typography: {
      display: { fontFamily: sans, fontSize: 96, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 },
      h1: { fontFamily: sans, fontSize: 64, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 },
      h2: { fontFamily: sans, fontSize: 44, fontWeight: 600, lineHeight: 1.15 },
      h3: { fontFamily: sans, fontSize: 32, fontWeight: 600, lineHeight: 1.2 },
      body: { fontFamily: sans, fontSize: 24, fontWeight: 400, lineHeight: 1.45 },
      bodySmall: { fontFamily: sans, fontSize: 20, fontWeight: 400, lineHeight: 1.45 },
      caption: { fontFamily: sans, fontSize: 16, fontWeight: 400, lineHeight: 1.4 },
      quote: { fontFamily: sans, fontSize: 32, fontWeight: 400, fontStyle: "italic", lineHeight: 1.35 },
      code: { fontFamily: mono, fontSize: 20, fontWeight: 400, lineHeight: 1.5 },
      // tabular numerals: without them a numberCount animation makes the slide jitter
      metric: { fontFamily: sans, fontSize: 88, fontWeight: 700, lineHeight: 1, fontFeatures: ["tnum"] },
      scaleRatio: 1.25,
    },
    spacing: {
      base: 8,
      xs: 4,
      sm: 8,
      md: 16,
      lg: 32,
      xl: 64,
      xxl: 96,
      slideMargin: { top: 80, right: 120, bottom: 80, left: 120 },
    },
    radii: { none: 0, sm: 4, md: 12, lg: 24, full: 9999 },
    shadows: {
      none: [],
      sm: [{ type: "drop", offsetX: 0, offsetY: 1, blur: 3, color: "#00000059" }],
      md: [{ type: "drop", offsetX: 0, offsetY: 6, blur: 18, color: "#00000073" }],
      lg: [{ type: "drop", offsetX: 0, offsetY: 18, blur: 48, color: "#00000099" }],
    },
    grid: { columns: 12, gutter: 24, margin: 120, baseUnit: 8, baselineGrid: 8 },
    chart: {
      series: ["#4CC2FF", "#A78BFA", "#3DDC97", "#F2C14E", "#FF6B6B", "#7DD3FC"],
      gridlineColor: "#1C2530",
      axisColor: "#6B7C90",
      showGridlines: true,
      barCornerRadius: 4,
      lineWidth: 3,
      pointSize: 6,
    },
    diagram: {
      nodeFill: { type: "solid", color: "token:colors.surface" },
      nodeStroke: { paint: { type: "solid", color: "token:colors.border" }, width: 1 },
      nodeRadius: 12,
      nodePadding: { top: 16, right: 20, bottom: 16, left: 20 },
      roleStyles: {
        service: { fill: { type: "solid", color: "token:colors.surface" } },
        datastore: { fill: { type: "solid", color: "token:colors.surfaceAlt" } },
        external: {
          fill: { type: "none" },
          stroke: {
            paint: { type: "solid", color: "token:colors.borderStrong" },
            width: 1,
            dash: [6, 4],
          },
        },
      },
    },
    imagery: { treatment: "none", defaultCornerRadius: 12 },
    motion: {
      personality: "technical",
      defaultEntrance: "fadeUp",
      defaultDurationMs: 400,
      defaultEasing: "emphasized",
      staggerMs: 70,
      reducedMotionFallback: "fade",
      maxSlideDurationMs: 2500,
    },
    contrastPairs: [
      { foreground: "colors.foreground", background: "colors.background", minimumRatio: 4.5 },
      { foreground: "colors.accentForeground", background: "colors.accent", minimumRatio: 4.5 },
      { foreground: "colors.foregroundMuted", background: "colors.background", minimumRatio: 3 },
    ],
    brandRules: [
      {
        id: "type-sizes",
        kind: "must-not",
        scope: "typography",
        statement: "Use no more than three type sizes on a single slide.",
        check: { type: "maxFontSizesPerSlide", value: 3 },
      },
      {
        id: "no-literals",
        kind: "should",
        scope: "color",
        statement: "Reference theme tokens rather than literal hex values so the deck re-themes cleanly.",
        check: { type: "forbiddenColorLiterals", value: true },
      },
      {
        id: "whitespace",
        kind: "should",
        scope: "layout",
        statement: "Use whitespace aggressively. A crowded technical slide reads as an unconsidered one.",
      },
    ],
  };
}

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

  return buildDocument({
    id: id("doc"),
    title: "Deckastra Architecture Review",
    theme,
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

  const transitionTarget: Slide = {
    id: id("sld"),
    name: "Transition target",
    semanticIntent: "Receiving slide for transition tests",
    keyMessage: "Transitions belong to the slide being entered",
    elements: [
      {
        id: id("el"),
        type: "text",
        semanticRole: "headline",
        transform: { x: 120, y: 440, width: 1400, height: 200 },
        content: plainText("Entered with a zoom", id("blk")),
        typography: { fontFamily: "token:typography.display.fontFamily", fontSize: 88, fontWeight: 700, color: "token:colors.foreground" },
      },
    ],
    // A slide's transition describes how the deck moves INTO it, so reordering
    // carries the entrance along — which is what authors expect.
    transition: { type: "zoom", durationMs: 500, easing: "emphasized" },
  };

  return buildDocument({
    id: id("doc"),
    title: "Animation Conformance Deck",
    theme,
    slides: [sequenced, transitionTarget],
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
