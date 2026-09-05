import {
  isGroup,
  isKnownElementType,
  textContent,
  type BackgroundDefinition,
  type CommonStyle,
  type PresentationDocument,
  type PresentationElement,
  type Rect,
  type Slide,
  type TypographyStyle,
} from "@deckastra/presentation-schema";

import { IDENTITY, localMatrix, multiply, transformedBounds, type Matrix } from "./matrix";
import { resolveTheme, resolveTypography, resolveValue, type ResolvedTheme } from "./theme";
import { shapeGeometry } from "./shapes";
import {
  defaultTextMeasurer,
  type TextMeasurer,
  type TextMetrics,
} from "./text-metrics";

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
  stroke?: { color: string; width: number; dash?: number[] };
  cornerRadius?: number;
  opacity: number;
  shadow?: string;
  filter?: string;
  blendMode?: string;
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
  | { kind: "shape"; pathData: string; preferRect: boolean; radius: number; label?: TextBlockPayload[]; labelTypography?: TypographyStyle }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; startMarker?: string; endMarker?: string }
  | { kind: "image"; assetId: string; storageKey?: string; objectFit: string; objectPosition: string; altText?: string }
  | { kind: "code"; code: string; language: string; showLineNumbers: boolean; startLineNumber: number; fileName?: string; typography: TypographyStyle }
  | { kind: "table"; columns: { id: string; label?: string; align?: string }[]; rows: { id: string; cells: { text: string; align?: string }[]; emphasis?: string }[]; headerRow: boolean; typography: TypographyStyle }
  | { kind: "group"; containerLayout?: unknown }
  | { kind: "placeholder"; label: string; reason: string };

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
  transition?: { type: string; durationMs: number; easing?: string };
  speakerNotes?: string;
}

export interface DocumentScene {
  documentId: string;
  title: string;
  viewport: { width: number; height: number };
  theme: ResolvedTheme;
  slides: SlideScene[];
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

function paintToCss(theme: ResolvedTheme, paint: unknown): string | undefined {
  if (!paint || typeof paint !== "object") return undefined;
  const p = paint as { type: string; color?: unknown; stops?: { offset: number; color: unknown }[]; angle?: number };

  switch (p.type) {
    case "none":
      return undefined;
    case "solid":
      return resolveValue<string>(theme, p.color);
    case "linearGradient": {
      const stops = (p.stops ?? [])
        .map((s) => `${resolveValue<string>(theme, s.color) ?? "transparent"} ${(s.offset * 100).toFixed(1)}%`)
        .join(", ");
      return `linear-gradient(${p.angle ?? 180}deg, ${stops})`;
    }
    case "radialGradient": {
      const stops = (p.stops ?? [])
        .map((s) => `${resolveValue<string>(theme, s.color) ?? "transparent"} ${(s.offset * 100).toFixed(1)}%`)
        .join(", ");
      return `radial-gradient(circle, ${stops})`;
    }
    default:
      // Unknown paint variants are preserved by the schema and skipped here rather
      // than painted wrong.
      return undefined;
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
    out.shadow = style.shadow
      .map((s) => {
        const color = resolveValue<string>(theme, s.color) ?? "rgba(0,0,0,0.3)";
        const inset = s.type === "inner" ? "inset " : "";
        return `${inset}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread ?? 0}px ${color}`;
      })
      .join(", ");
  }

  if (style.filters?.length) {
    out.filter = style.filters
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

  if (style.blendMode && style.blendMode !== "normal") out.blendMode = style.blendMode;

  return out;
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
}

function buildNode(
  element: PresentationElement,
  parentWorld: Matrix,
  parentZPath: number[],
  siblingIndex: number,
  ctx: BuildContext,
): SceneNode {
  const local = localMatrix(element.transform);
  const world = multiply(parentWorld, local);
  const { width, height } = element.transform;

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
    renderPayload: buildPayload(element, ctx, flags),
    a11y: {
      role: a11yRole(element.type, element.semanticRole),
      label: element.metadata?.altText ?? element.name,
      order: a11yOrder(element.semanticRole, order),
    },
    flags,
  };

  if (isGroup(element)) {
    node.children = element.children.map((child, i) => buildNode(child, world, zPath, i, ctx));
  }

  ctx.nodes.push(node);
  return node;
}

function buildPayload(
  element: PresentationElement,
  ctx: BuildContext,
  flags: SceneFlags,
): RenderPayload {
  const { theme } = ctx;
  const { width, height } = element.transform;

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
        label: el.text ? textBlocks(theme, el.text) : undefined,
        labelTypography: resolveTypography(theme, {
          fontFamily: "token:typography.body.fontFamily",
          fontSize: 20,
        }),
      };
    }

    case "line": {
      const el = element as unknown as { from: unknown; to: unknown };
      // Anchors resolve to concrete points at scene-build time (doc 04 §7.2).
      // Phase 1 only handles literal points; anchored connectors need the element
      // index that Phase 3's layout engine builds.
      const from = el.from as { x?: number; y?: number };
      const to = el.to as { x?: number; y?: number };

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

      return {
        kind: "code",
        code: el.code,
        language: el.language,
        showLineNumbers: el.showLineNumbers ?? false,
        startLineNumber: el.startLineNumber ?? 1,
        fileName: el.fileName,
        typography: resolveTypography(theme, {
          fontFamily: "token:typography.code.fontFamily",
          fontSize: 20,
          lineHeight: 1.5,
        }),
      };
    }

    case "table": {
      const el = element as unknown as {
        columns: { id: string; label?: string; align?: string }[];
        rows: { id: string; cells: { content: unknown; align?: string }[]; emphasis?: string }[];
        headerRow?: boolean;
      };

      return {
        kind: "table",
        columns: el.columns.map((c) => ({ id: c.id, label: c.label, align: c.align })),
        rows: el.rows.map((r) => ({
          id: r.id,
          emphasis: r.emphasis,
          cells: r.cells.map((cell) => ({
            text: textContent(cell.content as never),
            align: cell.align,
          })),
        })),
        headerRow: el.headerRow ?? true,
        typography: resolveTypography(theme, {
          fontFamily: "token:typography.bodySmall.fontFamily",
          fontSize: 20,
        }),
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

function buildBackground(
  theme: ResolvedTheme,
  background: BackgroundDefinition | undefined,
): SceneBackground | undefined {
  if (!background) return undefined;

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
}

export function buildSlideScene(
  document: PresentationDocument,
  slide: Slide,
  index: number,
  theme: ResolvedTheme,
  options: BuildSceneOptions = {},
): SlideScene {
  const ctx: BuildContext = {
    theme,
    measurer: options.measurer ?? defaultTextMeasurer,
    viewport: { width: document.viewport.width, height: document.viewport.height },
    assetKeys: new Map(document.assets.map((a) => [a.id, a.storageKey])),
    nodes: [],
    counter: { value: 0 },
  };

  const roots = slide.elements.map((element, i) => buildNode(element, IDENTITY, [], i, ctx));

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
    nodes: roots,
    paintOrder,
    theme,
    transition: slide.transition
      ? {
          type: slide.transition.type,
          durationMs: slide.transition.durationMs,
          easing: slide.transition.easing,
        }
      : undefined,
    speakerNotes:
      typeof slide.speakerNotes === "string"
        ? slide.speakerNotes
        : slide.speakerNotes
          ? textContent(slide.speakerNotes)
          : undefined,
  };
}

export function buildDocumentScene(
  document: PresentationDocument,
  options: BuildSceneOptions = {},
): DocumentScene {
  const theme = resolveTheme(document.theme);

  return {
    documentId: document.id,
    title: document.metadata.title,
    viewport: { width: document.viewport.width, height: document.viewport.height },
    theme,
    slides: document.slides.map((slide, i) =>
      buildSlideScene(document, slide, i, theme, options),
    ),
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
