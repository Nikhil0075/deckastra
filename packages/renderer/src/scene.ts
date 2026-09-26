import {
  isGroup,
  isKnownElementType,
  textContent,
  type BackgroundDefinition,
  type CommonStyle,
  type PresentationDocument,
  type PresentationElement,
  type Rect,
  type RichTextDocument,
  type Slide,
  type TypographyStyle,
} from "@deckastra/presentation-schema";

import { IDENTITY, localMatrix, multiply, transformedBounds, type Matrix } from "./matrix";
import { paintToCss, resolveTheme, resolveTypography, resolveValue, type ResolvedTheme } from "./theme";
import { shapeGeometry } from "./shapes";
import { contrastRatio, parseColor } from "./semantic";
import {
  defaultTextMeasurer,
  type TextMeasurer,
  type TextMetrics,
} from "./text-metrics";
import { resolveContainer, type LayoutBox } from "@deckastra/layout-engine";
import { buildChartPayload, type ChartPayload } from "./charts";
import { buildDiagramPayload, type DiagramPayload } from "./diagram";

export type { ChartPayload } from "./charts";
export type { DiagramPayload } from "./diagram";
import { ICON_VIEWBOX, findIcon } from "./icons";
import { codeColors, highlight, type CodeColors, type CodeToken } from "./highlight";
import { formatNumber, toNumber } from "./format";
import { Stopwatch, type PhaseTiming } from "./perf";
import {
  describeFontUsage,
  detectFontAvailability,
  fontDigest,
  resolveFontStack,
  type FontAvailability,
  type FontUsage,
} from "./fonts";

/**
 * Scene building — pipeline stage 9 (doc 04 §6, §7).
 *
 * The scene is a render-specific derivation of the document, and every value in
 * it is concrete: tokens flattened, transforms composed, geometry resolved. None
 * of it is ever persisted (doc 02 §4.1).
 *
 * There is a separate scene rather than rendering the document directly for four
 * reasons the spec gives (§7.1), of which the load-bearing one is export parity:
 * the browser renderer, the PDF adapter and the PPTX adapter all consume this
 * same structure, so they cannot drift by each re-deriving layout differently.
 *
 * Phase 1 runs stages 1-3 and 8-9. Component resolution, data bindings, container
 * layout and constraints (stages 4-7) are identity passes for now — they land in
 * Phases 2-3. They are named in the code rather than silently skipped so the gap
 * is visible.
 */

export type SceneLayer = "background" | "vector" | "content" | "fx";

export interface SceneFlags {
  measured: boolean;
  metricsEstimated: boolean;
  overflow: boolean;
  outOfBounds: boolean;
  hidden: boolean;
  locked: boolean;
  /** Which properties the animation runtime will drive. Empty until Phase 7. */
  animatedProperties: string[];
  /** Set when this reader does not know the element type and is drawing a
   *  placeholder instead. Never a reason to drop the element (doc 02 §0.8). */
  unsupported: boolean;
}

export interface ResolvedStyle {
  fill?: string;
  /**
   * A gradient fill, structured, beside its CSS form in `fill`. An SVG shape
   * cannot take a CSS gradient as its `fill` (it silently draws nothing), and
   * PowerPoint needs the stops to write a native gradient, so both read this.
   */
  gradient?: ResolvedGradient;
  stroke?: { color: string; width: number; dash?: number[] };
  cornerRadius?: number;
  opacity: number;
  shadow?: string;
  /** The same shadows, structured, for adapters that cannot read CSS. */
  shadows?: ResolvedShadow[];
  filter?: string;
  /** Applied to what is behind the element: frosted glass is a blur here. */
  backdropFilter?: string;
  blendMode?: string;
}

export interface ResolvedGradient {
  kind: "linear" | "radial";
  /** CSS convention: 0 points up, 90 points right. */
  angle: number;
  stops: { offset: number; color: string }[];
}

export interface ResolvedShadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

export interface SceneNode {
  /** Equals the document element id. Stability here is what lets selection,
   *  animation and provenance survive a rebuild. */
  id: string;
  type: string;
  name?: string;
  semanticRole?: string;
  worldTransform: Matrix;
  localTransform: Matrix;
  /** Axis-aligned world bounds, post-rotation. */
  bounds: Rect;
  /** Pre-rotation, in element space. */
  localBounds: Rect;
  resolvedStyle: ResolvedStyle;
  layer: SceneLayer;
  /** Stable stacking path (doc 04 §8.3). Lexicographic sort gives paint order. */
  zPath: number[];
  children?: SceneNode[];
  renderPayload: RenderPayload;
  a11y: { role: string; label?: string; order: number };
  flags: SceneFlags;
}

export type RenderPayload =
  | { kind: "text"; blocks: TextBlockPayload[]; metrics: TextMetrics; typography: TypographyStyle; align?: string; verticalAlign?: string; padding?: Insets }
  | { kind: "shape"; pathData: string; preferRect: boolean; radius: number; label?: TextBlockPayload[]; labelTypography?: TypographyStyle; labelVerticalAlign?: string; labelPadding?: Insets }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; startMarker?: string; endMarker?: string }
  | { kind: "image"; assetId: string; storageKey?: string; objectFit: string; objectPosition: string; altText?: string }
  | { kind: "code"; code: string; language: string; lines: CodeLine[]; colors: CodeColors; showLineNumbers: boolean; startLineNumber: number; fileName?: string; typography: TypographyStyle }
  | TablePayload
  | ChartPayload
  | DiagramPayload
  | IconPayload
  | { kind: "group"; containerLayout?: unknown }
  | { kind: "placeholder"; label: string; reason: string };

export interface CodeLine {
  number: number;
  tokens: CodeToken[];
}

export interface IconPayload {
  kind: "icon";
  name: string;
  set: string;
  paths: string[];
  circles: [number, number, number][];
  color: string;
  strokeWidth: number;
  viewBox: number;
  /** Set when the icon is not in the curated set; the renderer draws its name. */
  missing?: string;
}

export interface TableCellPayload {
  text: string;
  align?: string;
  fill?: string;
  colSpan?: number;
  rowSpan?: number;
}

export interface TablePayload {
  kind: "table";
  columns: { id: string; label?: string; align?: string; width?: number }[];
  rows: { id: string; cells: TableCellPayload[]; emphasis?: string }[];
  headerRow: boolean;
  headerColumn: boolean;
  typography: TypographyStyle;
  headerTypography: TypographyStyle;
  padding: Insets;
  banding: "none" | "rows" | "columns";
  bandColor?: string;
  borders: "all" | "horizontal" | "outer" | "none";
  borderColor: string;
  headerFill?: string;
  emphasisFill?: string;
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TextBlockPayload {
  id: string;
  type: string;
  indentLevel: number;
  spans: { text: string; bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean; color?: string; link?: string; fontSizeScale?: number }[];
  align?: string;
}

export interface SceneBackground {
  color?: string;
  gradient?: string;
  assetId?: string;
  overlay?: string;
  blur?: number;
}

export interface SceneFontFace {
  family: string;
  assetId: string;
  storageKey?: string;
  mimeType?: string;
  /** A CSS `font-weight` value: one weight, or a "min max" range for a variable font. */
  weight?: string;
  style?: "normal" | "italic";
}

export interface SlideScene {
  slideId: string;
  index: number;
  name?: string;
  keyMessage?: string;
  width: number;
  height: number;
  safeArea?: Insets;
  background?: SceneBackground;
  /** Depth-first, document order. Paint order is `paintOrder`. */
  nodes: SceneNode[];
  /** Node ids sorted by zPath ascending — the order to paint in. */
  paintOrder: string[];
  theme: ResolvedTheme;
  /**
   * The slide's entrance transition, carried whole.
   *
   * It used to be narrowed to type, duration and easing — which silently dropped
   * `direction` and `sharedElements`, the two fields a push and a morph are made
   * of. The transition engine reads a scene, so a fact the scene does not carry
   * is a fact it cannot act on, and a deck whose author had paired elements got
   * a crossfade with nothing anywhere saying why.
   */
  transition?: {
    type: string;
    durationMs: number;
    easing?: string;
    direction?: "left" | "right" | "up" | "down";
    sharedElements?: {
      sourceElementId: string;
      destinationElementId: string;
      matchMode?: "position" | "positionAndScale" | "full";
    }[];
  };
  /**
   * Fonts uploaded to this deck, to be declared with `@font-face` wherever the
   * slide is drawn. A deck carries its own faces the way it carries its
   * pictures: by asset id, resolved to bytes by whoever draws it. Absent when
   * the deck has none.
   */
  fontFaces?: SceneFontFace[];
  speakerNotes?: string;
  /**
   * The notes as authored, when they are rich text; absent for plain notes.
   *
   * `speakerNotes` stays the flattened text, which is what a PDF's notes page
   * and anything reading words need. This carries the structure beside it so a
   * presenter sees the bullets and emphasis the author wrote rather than one
   * run-on paragraph. Pass-through like `transition`: nothing here renders it.
   */
  speakerNotesRich?: RichTextDocument;
  /**
   * The slide's animation tracks, passed through unresolved.
   *
   * Pass-through, not resolution: the renderer does not compile timelines —
   * `@deckastra/animation-engine` does, and it needs both the tracks and the
   * scene. Carrying them here rather than making every consumer also hold the
   * document is the same choice already made for `transition` and
   * `speakerNotes`, and it is what lets present mode, the editor preview and a
   * headless export each drive motion from a scene alone.
   */
  animations?: unknown[];
  /**
   * What each requested font family actually resolved to (doc 04 §18.4).
   *
   * Part of the scene, not a side channel, because font availability changes the
   * pixels. A visual-regression failure that cannot be attributed to a missing
   * face costs an afternoon; this is what makes the attribution immediate.
   */
  fonts: FontUsage[];
}

export interface DocumentScene {
  documentId: string;
  title: string;
  viewport: { width: number; height: number };
  theme: ResolvedTheme;
  slides: SlideScene[];
  fonts: FontUsage[];
  /** Readable, not hashed: "Inter was missing" is the useful failure message. */
  fontDigest: string;
}

/** Which DOM layer an element type belongs to (doc 04 §3.2). An element is
 *  authored into one layer by type, never by per-object preference. */
function layerFor(type: string): SceneLayer {
  switch (type) {
    case "shape":
    case "line":
    case "icon":
    case "diagram":
    case "chart":
      return "vector";
    case "text":
    case "image":
    case "code":
    case "table":
    case "video":
    case "audio":
    case "webEmbed":
      return "content";
    case "group":
      return "content";
    default:
      return "content";
  }
}

/**
 * Accessibility order (doc 04 §8.4).
 *
 * Derived from semantic role priority, deliberately *not* from z-order. A
 * decorative shape painted last must not be the first thing a screen reader
 * reaches, and a headline behind a background image is still the headline.
 */
const ROLE_ORDER: Record<string, number> = {
  eyebrow: 0,
  headline: 1,
  subtitle: 2,
  metric: 3,
  body: 4,
  quote: 5,
  callout: 6,
  evidence: 7,
  primaryChart: 8,
  mainDiagram: 9,
  heroVisual: 10,
  secondaryChart: 11,
  supportingDiagram: 12,
  supportingVisual: 13,
  caption: 14,
  footer: 20,
  pageNumber: 21,
  logo: 22,
  navigation: 23,
  decoration: 99,
};

function a11yOrder(role: string | undefined, fallback: number): number {
  if (role && role in ROLE_ORDER) return ROLE_ORDER[role]! * 100 + fallback;
  return 5000 + fallback;
}

function a11yRole(type: string, semanticRole?: string): string {
  if (semanticRole === "decoration") return "presentation";
  switch (type) {
    case "text":
      return semanticRole === "headline" ? "heading" : "paragraph";
    case "image":
    case "icon":
      return "img";
    case "table":
      return "table";
    case "chart":
    case "diagram":
      return "img";
    case "group":
      return "group";
    default:
      return "presentation";
  }
}

function resolveStyle(
  theme: ResolvedTheme,
  style: CommonStyle | undefined,
  opacity: number,
): ResolvedStyle {
  const out: ResolvedStyle = { opacity };
  if (!style) return out;

  out.fill = paintToCss(theme, style.fill);
  const fill = style.fill as { type?: string; angle?: number; stops?: { offset: number; color: unknown }[] } | undefined;
  if ((fill?.type === "linearGradient" || fill?.type === "radialGradient") && fill.stops?.length) {
    out.gradient = {
      kind: fill.type === "linearGradient" ? "linear" : "radial",
      angle: fill.angle ?? 180,
      stops: fill.stops.map((stop) => ({
        offset: stop.offset,
        color: resolveValue<string>(theme, stop.color) ?? "transparent",
      })),
    };
  }

  if (style.stroke) {
    const color = paintToCss(theme, style.stroke.paint);
    if (color) {
      out.stroke = { color, width: style.stroke.width ?? 1, dash: style.stroke.dash };
    }
  }

  if (style.cornerRadius !== undefined) {
    out.cornerRadius =
      typeof style.cornerRadius === "number"
        ? style.cornerRadius
        : Math.max(
            style.cornerRadius.topLeft,
            style.cornerRadius.topRight,
            style.cornerRadius.bottomRight,
            style.cornerRadius.bottomLeft,
          );
  }

  if (style.shadow?.length) {
    out.shadows = style.shadow.map((s) => ({
      inset: s.type === "inner",
      x: s.offsetX,
      y: s.offsetY,
      blur: s.blur,
      spread: s.spread ?? 0,
      color: resolveValue<string>(theme, s.color) ?? "rgba(0,0,0,0.3)",
    }));
    out.shadow = out.shadows
      .map((s) => `${s.inset ? "inset " : ""}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`)
      .join(", ");
  }

  if (style.filters?.length) out.filter = filtersToCss(style.filters);
  if (style.backdropFilters?.length) out.backdropFilter = filtersToCss(style.backdropFilters);

  if (style.blendMode && style.blendMode !== "normal") out.blendMode = style.blendMode;

  return out;
}

function filtersToCss(filters: NonNullable<CommonStyle["filters"]>): string {
  return filters
      .map((f) => {
        switch (f.type) {
          case "blur":
            return `blur(${f.radius}px)`;
          case "grayscale":
            return `grayscale(${f.amount})`;
          case "sepia":
            return `sepia(${f.amount})`;
          default:
            return `${f.type}(${"amount" in f ? f.amount : 1})`;
        }
      })
      .join(" ");
}

/**
 * A shape label's typography: the theme's body style, the element's overrides,
 * and a colour that reads against the fill when the element names none.
 *
 * The colour is chosen between the theme's own foreground and background, so it
 * is always a colour the deck already uses; a gradient is judged by its first
 * stop. Without this the label inherited the page's colour and disappeared on
 * any card darker or lighter than the page.
 */
function labelTypography(
  theme: ResolvedTheme,
  overrides: Partial<TypographyStyle> | undefined,
  fill: string | undefined,
): TypographyStyle {
  const style = resolveTypography(theme, {
    fontFamily: "token:typography.body.fontFamily",
    fontSize: 20,
    ...(overrides ?? {}),
  } as TypographyStyle);
  if (style.color !== undefined) return style;

  const foreground = String(resolveValue(theme, "token:colors.foreground", "#111111"));
  const background = String(resolveValue(theme, "token:colors.background", "#FFFFFF"));
  const light = parseColor(foreground);
  const dark = parseColor(background);
  if (!light || !dark) return { ...style, color: foreground };
  const first = fill ? (/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i.exec(fill)?.[0] ?? fill) : undefined;
  const solid = parseColor(first);
  if (!solid) return { ...style, color: foreground };
  // A see-through fill (a glass card) is judged as it looks: blended over the
  // theme's background, which is what shows through it. Judged as opaque, a
  // 12% white card on a dark slide read as white and got dark text.
  const alpha = colorAlpha(first);
  const behind = {
    r: solid.r * alpha + dark.r * (1 - alpha),
    g: solid.g * alpha + dark.g * (1 - alpha),
    b: solid.b * alpha + dark.b * (1 - alpha),
  };
  return {
    ...style,
    color: contrastRatio(light, behind) >= contrastRatio(dark, behind) ? foreground : background,
  };
}

function textBlocks(theme: ResolvedTheme, content: unknown, align?: string): TextBlockPayload[] {
  const doc = content as { blocks?: unknown[] } | undefined;
  if (!doc?.blocks) return [];

  return doc.blocks.map((raw) => {
    const block = raw as {
      id: string;
      type: string;
      indentLevel?: number;
      spans?: { text: string; color?: unknown; [k: string]: unknown }[];
      style?: { align?: string };
    };

    return {
      id: block.id,
      type: block.type,
      indentLevel: block.indentLevel ?? 0,
      align: block.style?.align ?? align,
      spans: (block.spans ?? []).map((span) => ({
        text: span.text,
        bold: span.bold as boolean | undefined,
        italic: span.italic as boolean | undefined,
        underline: span.underline as boolean | undefined,
        code: span.code as boolean | undefined,
        color: resolveValue<string>(theme, span.color),
        link: span.link as string | undefined,
        fontSizeScale: span.fontSizeScale as number | undefined,
      })),
    };
  });
}

interface BuildContext {
  theme: ResolvedTheme;
  measurer: TextMeasurer;
  viewport: { width: number; height: number };
  assetKeys: Map<string, string>;
  nodes: SceneNode[];
  counter: { value: number };
  /** Elements on the slide, by id. A chart bound to a table reads it from here. */
  elementsById: Map<string, PresentationElement>;
  /** Every family the slide asked for, so the scene can report what resolved. */
  fontFamilies: Set<string>;
}

function buildNode(
  element: PresentationElement,
  parentWorld: Matrix,
  parentZPath: number[],
  siblingIndex: number,
  ctx: BuildContext,
  /**
   * Position and size assigned by the parent container (stage 6).
   *
   * Present only when the parent lays out. The element's own `x`/`y` become
   * advisory in that case (doc 02 §16.2) — kept in the document so that pulling
   * the child out of the container restores a sensible position, ignored here.
   */
  placement?: LayoutBox,
): SceneNode {
  const transform = placement
    ? {
        ...element.transform,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
      }
    : element.transform;

  const local = localMatrix(transform);
  const world = multiply(parentWorld, local);
  const { width, height } = transform;

  const bounds = transformedBounds(world, width, height);
  const localBounds: Rect = { x: 0, y: 0, width, height };

  // zIndex overrides the sibling index but ties still break on index, so ordering
  // is total and stable (doc 02 §8.4).
  const zPath = [...parentZPath, element.zIndex ?? siblingIndex];

  const opacity = element.opacity ?? 1;
  const resolvedStyle = resolveStyle(ctx.theme, element.style, opacity);

  const flags: SceneFlags = {
    measured: false,
    metricsEstimated: false,
    overflow: false,
    outOfBounds:
      bounds.x + bounds.width < 0 ||
      bounds.y + bounds.height < 0 ||
      bounds.x > ctx.viewport.width ||
      bounds.y > ctx.viewport.height,
    hidden: element.visible === false,
    locked: element.locked === true,
    animatedProperties: [],
    unsupported: !isKnownElementType(element.type),
  };

  const order = ctx.counter.value++;

  const node: SceneNode = {
    id: element.id,
    type: element.type,
    name: element.name,
    semanticRole: element.semanticRole,
    worldTransform: world,
    localTransform: local,
    bounds,
    localBounds,
    resolvedStyle,
    layer: layerFor(element.type),
    zPath,
    renderPayload: buildPayload(element, ctx, flags, transform),
    a11y: {
      role: a11yRole(element.type, element.semanticRole),
      label: element.metadata?.altText ?? element.name,
      order: a11yOrder(element.semanticRole, order),
    },
    flags,
  };

  if (isGroup(element)) {
    const placements = layoutChildren(element, transform, ctx);
    node.children = element.children.map((child, i) =>
      buildNode(child, world, zPath, i, ctx, placements?.get(child.id)),
    );
  }

  ctx.nodes.push(node);
  return node;
}

/**
 * Container layout — pipeline stage 6 (doc 04 §6.1, §15.3).
 *
 * This is the mechanism that keeps generated content robust: four KPI cards
 * emitted as a horizontal container survive a longer label, while the same four
 * emitted as absolute boxes overlap. It is why the Layout Agent is told to emit
 * a container for anything repeated (doc 04 §15.4).
 *
 * Returns `undefined` for a group with no container, or a `free` one — the
 * common case, and the one where a child's own coordinates are authoritative.
 * Returning a map of identity placements instead would work but would make every
 * plain group pay for a layout pass it does not need.
 */
function layoutChildren(
  element: PresentationElement,
  transform: { width: number; height: number },
  ctx: BuildContext,
): Map<string, LayoutBox> | undefined {
  if (!isGroup(element)) return undefined;

  const layout = element.containerLayout;
  if (!layout || layout.type === "free" || element.children.length === 0) return undefined;

  const result = resolveContainer({
    layout,
    box: { width: transform.width, height: transform.height },
    // Natural size is the child's own box. Once text measurement feeds this —
    // a child that grows with its content — the container reflows around it
    // without anything here changing.
    children: element.children.map((child) => ({
      id: child.id,
      width: child.transform.width,
      height: child.transform.height,
    })),
    baseGap: ctx.theme.source.spacing.base,
  });

  return new Map(result.children.map((box) => [box.id, box]));
}

function buildPayload(
  element: PresentationElement,
  ctx: BuildContext,
  flags: SceneFlags,
  /** The laid-out box, which differs from `element.transform` inside a container. */
  transform: { width: number; height: number },
): RenderPayload {
  const { theme } = ctx;
  const { width, height } = transform;

  switch (element.type) {
    case "text": {
      const el = element as unknown as {
        content: never;
        typography: TypographyStyle;
        paragraph?: { align?: string };
        fit?: string;
        minFontSize?: number;
        maxFontSize?: number;
        padding?: Insets;
        verticalAlign?: string;
      };

      const typography = resolveTypography(theme, el.typography);
      const padding = el.padding;
      const innerWidth = width - (padding?.left ?? 0) - (padding?.right ?? 0);
      const innerHeight = height - (padding?.top ?? 0) - (padding?.bottom ?? 0);

      const metrics = ctx.measurer.measure({
        content: el.content,
        typography,
        maxWidth: Math.max(1, innerWidth),
        maxHeight: Math.max(1, innerHeight),
        fit: (el.fit as never) ?? "fixed",
        minFontSize: el.minFontSize,
        maxFontSize: el.maxFontSize,
      });

      flags.measured = true;
      flags.metricsEstimated = metrics.estimated;
      flags.overflow = metrics.overflow;

      return {
        kind: "text",
        blocks: textBlocks(theme, el.content, el.paragraph?.align),
        metrics,
        typography,
        align: el.paragraph?.align,
        verticalAlign: el.verticalAlign,
        padding,
      };
    }

    case "shape": {
      const el = element as unknown as {
        shape: string;
        pathData?: string;
        points?: number;
        innerRadius?: number;
        text?: unknown;
        textPadding?: Insets;
        typography?: Partial<TypographyStyle>;
        paragraph?: { align?: string };
        verticalAlign?: string;
      };

      const geometry = shapeGeometry({
        shape: el.shape,
        width,
        height,
        pathData: el.pathData,
        points: el.points,
        innerRadius: el.innerRadius,
        cornerRadius: element.style?.cornerRadius,
      });

      const radius =
        geometry.radiusOverride ??
        (typeof element.style?.cornerRadius === "number" ? element.style.cornerRadius : 0);

      return {
        kind: "shape",
        pathData: geometry.pathData,
        preferRect: geometry.preferRect,
        radius,
        // Centred, as a shape's label is in every tool people have used: a
        // label that starts at the left edge of a circle looks like a mistake.
        label: el.text ? textBlocks(theme, el.text, el.paragraph?.align ?? "center") : undefined,
        labelTypography: labelTypography(theme, el.typography, paintToCss(theme, element.style?.fill)),
        labelVerticalAlign: el.verticalAlign ?? "middle",
        labelPadding: el.textPadding,
      };
    }

    case "line": {
      const el = element as unknown as { from?: unknown; to?: unknown };
      // Anchors resolve to concrete points at scene-build time (doc 04 §7.2).
      // Phase 1 only handles literal points; anchored connectors need the element
      // index that Phase 3's layout engine builds.
      //
      // Both endpoints are required by the schema and are still checked here,
      // because "required by the schema" and "present in this object" are not the
      // same claim. The unknown-element fallback now rejects known types, but
      // callers can still pass unchecked objects or data saved before that fix.
      // Reading `.x` off a missing endpoint would take the whole deck down; a
      // placeholder contains the damage and names the problem.
      const from = el.from as { x?: number; y?: number } | undefined;
      const to = el.to as { x?: number; y?: number } | undefined;

      if (!from || !to) {
        return {
          kind: "placeholder",
          label: element.name ?? "Line",
          reason: "This line is missing its from/to endpoints",
        };
      }

      return {
        kind: "line",
        x1: from.x ?? 0,
        y1: from.y ?? 0,
        x2: to.x ?? width,
        y2: to.y ?? height,
      };
    }

    case "image": {
      const el = element as unknown as {
        assetId: string;
        fit?: string;
        focalPoint?: { x: number; y: number };
        altText?: string;
      };
      const focal = el.focalPoint ?? { x: 0.5, y: 0.5 };

      return {
        kind: "image",
        assetId: el.assetId,
        storageKey: ctx.assetKeys.get(el.assetId),
        objectFit: el.fit ?? "cover",
        objectPosition: `${(focal.x * 100).toFixed(1)}% ${(focal.y * 100).toFixed(1)}%`,
        altText: el.altText,
      };
    }

    case "code": {
      const el = element as unknown as {
        code: string;
        language: string;
        showLineNumbers?: boolean;
        startLineNumber?: number;
        fileName?: string;
      };

      const typography = resolveTypography(theme, {
        fontFamily: "token:typography.code.fontFamily",
        fontSize: 20,
        lineHeight: 1.5,
      });

      const start = el.startLineNumber ?? 1;
      // Tokenized here, not in the React layer: highlighting is a pure function
      // of the source and the language, so it belongs on the side of the split
      // that the PDF and PPTX adapters also read.
      const lines: CodeLine[] = el.code
        .split("\n")
        .map((line, i) => ({ number: start + i, tokens: highlight(line, el.language) }));

      return {
        kind: "code",
        code: el.code,
        language: el.language,
        lines,
        colors: codeColors(
          String(resolveValue(theme, "token:colors.foreground", "#111")),
          String(resolveValue(theme, "token:colors.foregroundSubtle", "#888")),
          (theme.source.colors.chartSeries ?? []).map((color) =>
            String(resolveValue(theme, color, "#888")),
          ),
        ),
        showLineNumbers: el.showLineNumbers ?? false,
        startLineNumber: start,
        fileName: el.fileName,
        typography,
      };
    }

    case "table":
      return buildTablePayload(element, theme);

    case "chart":
      return buildChartPayload(element as never, width, height, {
        theme,
        tableRows: chartTableRows(element as never, ctx),
      });

    case "diagram":
      return buildDiagramPayload(element as never, width, height, theme);

    case "icon": {
      const el = element as unknown as {
        icon: { set: string; name: string; variant?: string };
        color?: unknown;
        strokeWidth?: number;
      };

      const definition = findIcon(el.icon.name);
      const color = String(
        resolveValue(theme, el.color ?? "token:colors.foreground", "currentColor"),
      );

      return {
        kind: "icon",
        name: el.icon.name,
        set: el.icon.set,
        paths: definition?.paths ?? [],
        circles: definition?.circles ?? [],
        color,
        // Scaled with the box so a large icon keeps its weight rather than
        // turning into a hairline drawing.
        strokeWidth:
          el.strokeWidth ?? Math.max(1, (ICON_VIEWBOX / Math.max(1, Math.min(width, height))) * 2.2),
        viewBox: ICON_VIEWBOX,
        missing: definition
          ? undefined
          : `${el.icon.set}/${el.icon.name} is not in the curated icon set`,
      };
    }

    case "group":
      return {
        kind: "group",
        containerLayout: (element as unknown as { containerLayout?: unknown }).containerLayout,
      };

    default:
      // Everything not yet implemented renders as a labelled placeholder rather
      // than vanishing. This is the same path an UnknownElement from a newer
      // schema takes, which is why it exists before the types that need it.
      return {
        kind: "placeholder",
        label: element.name ?? element.type,
        reason: flags.unsupported
          ? `Element type "${element.type}" is not known to this renderer`
          : `"${element.type}" rendering is not implemented yet`,
      };
  }
}

/**
 * Rows for a chart whose data reference points at a TableElement on the slide.
 *
 * Keeping table and chart in sync is the entire reason that reference exists
 * (doc 02 §17.2); resolving it here means the chart re-derives whenever the
 * table is edited, with no synchronisation step to forget.
 */
function chartTableRows(
  element: { data?: { type?: string; elementId?: string } },
  ctx: BuildContext,
): Record<string, unknown>[] | undefined {
  if (element.data?.type !== "table" || !element.data.elementId) return undefined;

  const table = ctx.elementsById.get(element.data.elementId) as
    | {
        type: string;
        columns: { id: string; label?: string }[];
        rows: { cells: { content: unknown }[] }[];
      }
    | undefined;

  if (!table || table.type !== "table") return undefined;

  return table.rows.map((row) => {
    const record: Record<string, unknown> = {};
    table.columns.forEach((column, index) => {
      const raw = textContent(row.cells[index]?.content as never);
      // Key by both id and label: an encoding may name either, and a chart that
      // silently plots nothing because it named the label is a bad afternoon.
      const value = toNumber(raw) ?? raw;
      record[column.id] = value;
      if (column.label) record[column.label] = value;
    });
    return record;
  });
}

function buildTablePayload(element: PresentationElement, theme: ResolvedTheme): TablePayload {
  const el = element as unknown as {
    columns: { id: string; label?: string; align?: string; width?: number; format?: unknown }[];
    rows: {
      id: string;
      cells: { content: unknown; align?: string; colSpan?: number; rowSpan?: number; style?: CommonStyle }[];
      emphasis?: string;
    }[];
    headerRow?: boolean;
    headerColumn?: boolean;
    columnWidths?: number[];
    tableStyle?: {
      banding?: string;
      borders?: string;
      headerFill?: unknown;
      cellPadding?: Insets;
      compact?: boolean;
    };
  };

  const style = el.tableStyle ?? {};
  const compact = style.compact === true;

  const typography = resolveTypography(theme, {
    fontFamily: "token:typography.bodySmall.fontFamily",
    fontSize: compact ? 18 : 20,
    color: "token:colors.foreground",
  });

  return {
    kind: "table",
    columns: el.columns.map((column, index) => ({
      id: column.id,
      label: column.label,
      align: column.align,
      width: el.columnWidths?.[index] ?? column.width,
    })),
    rows: el.rows.map((row) => ({
      id: row.id,
      emphasis: row.emphasis,
      cells: row.cells.map((cell, index) => {
        const raw = textContent(cell.content as never);
        const format = el.columns[index]?.format;
        const numeric = format ? toNumber(raw) : undefined;

        return {
          // A column that declares a format owns its cells' presentation, so a
          // table and a chart reading the same column agree on what "24.1K" is.
          text: numeric === undefined ? raw : formatNumber(numeric, format as never),
          align: cell.align,
          fill: cell.style?.fill ? paintToCss(theme, cell.style.fill) : undefined,
          colSpan: cell.colSpan,
          rowSpan: cell.rowSpan,
        };
      }),
    })),
    headerRow: el.headerRow ?? true,
    headerColumn: el.headerColumn ?? false,
    typography,
    headerTypography: resolveTypography(theme, {
      fontFamily: "token:typography.bodySmall.fontFamily",
      fontSize: compact ? 18 : 20,
      fontWeight: 600,
      color: "token:colors.foregroundMuted",
    }),
    padding: style.cellPadding ?? {
      top: compact ? 6 : 10,
      right: compact ? 10 : 16,
      bottom: compact ? 6 : 10,
      left: compact ? 10 : 16,
    },
    banding: (style.banding as TablePayload["banding"]) ?? "none",
    bandColor: String(resolveValue(theme, "token:colors.surfaceAlt", "rgba(127,127,127,0.06)")),
    borders: (style.borders as TablePayload["borders"]) ?? "horizontal",
    borderColor: String(resolveValue(theme, "token:colors.border", "rgba(127,127,127,0.3)")),
    headerFill: style.headerFill ? paintToCss(theme, style.headerFill) : undefined,
    emphasisFill: String(resolveValue(theme, "token:colors.surfaceAlt", "rgba(127,127,127,0.08)")),
  };
}

/**
 * Record the families a slide asked for, then rewrite each one as a full stack.
 *
 * A single pass over the finished payloads rather than a hook in every place a
 * typography style is built: there are seven such places today and the eighth
 * would forget. Recording the *requested* family before expansion is what makes
 * the availability report readable — "Inter" rather than the whole stack.
 */
function expandFontStacks(ctx: BuildContext): void {
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    const family = record.fontFamily;
    if (typeof family === "string" && family !== "") {
      ctx.fontFamilies.add(family.split(",")[0]!.trim());
      record.fontFamily = resolveFontStack(family);
    }

    for (const child of Object.values(record)) visit(child, depth + 1);
  };

  for (const node of ctx.nodes) visit(node.renderPayload, 0);
}

function buildBackground(
  theme: ResolvedTheme,
  background: BackgroundDefinition | undefined,
): SceneBackground | undefined {
  // No background of its own means the theme's, not "transparent". Transparent
  // let whatever was behind the slide show through, which is black in present
  // mode and the chrome in the editor, so a light theme applied to such a
  // slide never reached it.
  if (!background) {
    const color = resolveValue<string>(theme, "token:colors.background");
    return typeof color === "string" ? { color } : undefined;
  }

  const paint = paintToCss(theme, background.paint);
  const isGradient = paint?.includes("gradient");

  return {
    color: isGradient ? undefined : paint,
    gradient: isGradient ? paint : undefined,
    assetId: background.assetId,
    overlay: paintToCss(theme, background.overlay),
    blur: background.blur,
  };
}

function comparePaths(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

export interface BuildSceneOptions {
  measurer?: TextMeasurer;
  /**
   * Which font families the host has. Omit and the renderer probes the document
   * it is running in; in Node there is nothing to probe, and the result says
   * "unknown" rather than claiming every family is missing.
   */
  fonts?: FontAvailability;
  /**
   * The theme this document's theme extends (doc 02 §22.8).
   *
   * `extends` is an id, and the renderer has no theme registry — resolving it is
   * the caller's job, because only the caller knows the workspace. Passing the
   * parent here is what makes the inheritance step of the resolution order real
   * instead of documented.
   */
  parentTheme?: Parameters<typeof resolveTheme>[0];
  /**
   * Collects phase timings for the scene build (doc 04 §31.5).
   *
   * Passed in rather than always collected so the caller owns the report, and
   * so a build inside a tight loop is not forced to allocate one.
   */
  timings?: PhaseTiming[];
}

export function buildSlideScene(
  document: PresentationDocument,
  slide: Slide,
  index: number,
  theme: ResolvedTheme,
  options: BuildSceneOptions = {},
): SlideScene {
  const elementsById = new Map<string, PresentationElement>();
  const indexElements = (elements: readonly PresentationElement[]): void => {
    for (const element of elements) {
      elementsById.set(element.id, element);
      if (isGroup(element)) indexElements(element.children);
    }
  };
  indexElements(slide.elements);

  const ctx: BuildContext = {
    theme,
    measurer: options.measurer ?? defaultTextMeasurer,
    viewport: { width: document.viewport.width, height: document.viewport.height },
    assetKeys: new Map(document.assets.map((a) => [a.id, a.storageKey])),
    nodes: [],
    counter: { value: 0 },
    elementsById,
    fontFamilies: new Set<string>(),
  };

  const roots = slide.elements.map((element, i) => buildNode(element, IDENTITY, [], i, ctx));

  const availability = options.fonts ?? detectFontAvailability();
  expandFontStacks(ctx);

  const paintOrder = [...ctx.nodes]
    .sort((a, b) => comparePaths(a.zPath, b.zPath))
    .map((node) => node.id);

  return {
    slideId: slide.id,
    index,
    name: slide.name,
    keyMessage: slide.keyMessage,
    width: document.viewport.width,
    height: document.viewport.height,
    safeArea: document.viewport.safeArea,
    background: buildBackground(theme, slide.background),
    ...(fontFacesOf(document).length ? { fontFaces: fontFacesOf(document) } : {}),
    nodes: roots,
    paintOrder,
    theme,
    transition: slide.transition
      ? {
          type: slide.transition.type,
          durationMs: slide.transition.durationMs,
          easing: slide.transition.easing,
          direction: slide.transition.direction,
          sharedElements: slide.transition.sharedElements?.map((mapping) => ({
            sourceElementId: mapping.sourceElementId,
            destinationElementId: mapping.destinationElementId,
            matchMode: mapping.matchMode,
          })),
        }
      : undefined,
    speakerNotes:
      typeof slide.speakerNotes === "string"
        ? slide.speakerNotes
        : slide.speakerNotes
          ? textContent(slide.speakerNotes)
          : undefined,
    speakerNotesRich: slide.speakerNotes && typeof slide.speakerNotes !== "string" ? slide.speakerNotes : undefined,
    animations: slide.animations,
    fonts: describeFontUsage([...ctx.fontFamilies], availability),
  };
}

export function buildDocumentScene(
  document: PresentationDocument,
  options: BuildSceneOptions = {},
): DocumentScene {
  const watch = new Stopwatch();
  const theme = resolveTheme(document.theme, options.parentTheme);
  watch.mark("theme");

  const slides = document.slides.map((slide, i) =>
    buildSlideScene(document, slide, i, theme, options),
  );
  watch.mark("slides");

  // One report for the document, deduplicated: a font is missing for the whole
  // render or not at all, and repeating it per slide buries the signal.
  const seen = new Map<string, FontUsage>();
  for (const slide of slides) for (const usage of slide.fonts) seen.set(usage.family, usage);
  const fonts = [...seen.values()].sort((a, b) => a.family.localeCompare(b.family));
  watch.mark("fonts");

  if (options.timings) options.timings.push(...watch.report().phases);

  return {
    documentId: document.id,
    title: document.metadata.title,
    viewport: { width: document.viewport.width, height: document.viewport.height },
    theme,
    slides,
    fonts,
    fontDigest: fontDigest(fonts),
  };
}

/** Flatten a slide scene to every node, depth-first in document order. */
export function flattenScene(scene: SlideScene): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(scene.nodes);
  return out;
}

/** A colour's alpha, 0 to 1: the last two digits of an 8-digit hex, or an rgba's fourth part. Opaque otherwise. */
function colorAlpha(value: string | undefined): number {
  if (!value) return 1;
  const text = value.trim();
  if (/^#[0-9a-f]{8}$/i.test(text)) return parseInt(text.slice(7, 9), 16) / 255;
  if (/^#[0-9a-f]{4}$/i.test(text)) return parseInt(text[4]! + text[4]!, 16) / 255;
  const rgba = /^rgba\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,/]+([\d.]+)(%?)\s*\)$/i.exec(text);
  if (rgba) return rgba[2] ? Number(rgba[1]) / 100 : Number(rgba[1]);
  return 1;
}

/** The deck's uploaded fonts that name a family, as the renderer declares them. */
function fontFacesOf(document: PresentationDocument): SceneFontFace[] {
  const faces: SceneFontFace[] = [];
  for (const asset of document.assets ?? []) {
    const font = asset as { type?: string; id: string; fontFamily?: string; storageKey?: string; mimeType?: string; fontWeight?: number | string; fontStyle?: "normal" | "italic" };
    if (font.type !== "font" || !font.fontFamily) continue;
    faces.push({
      family: font.fontFamily,
      assetId: font.id,
      ...(font.storageKey ? { storageKey: font.storageKey } : {}),
      ...(font.mimeType ? { mimeType: font.mimeType } : {}),
      ...(font.fontWeight !== undefined ? { weight: String(font.fontWeight) } : {}),
      ...(font.fontStyle ? { style: font.fontStyle } : {}),
    });
  }
  return faces;
}
