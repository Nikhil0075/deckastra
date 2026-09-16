/**
 * Scene nodes to DrawingML (doc 04 §33.2).
 *
 * The rule doc 04 §33.4 states and this file follows: **PPTX export is for
 * compatibility, not fidelity parity.** The user story is "my client needs a
 * .pptx", so text that can be edited matters more than a shadow that renders
 * exactly. When forced to choose, keep the text and degrade the decoration —
 * and say so.
 */

import type { SceneNode, SlideScene } from "@deckastra/renderer";
import type { DegradationLedger } from "@deckastra/export-core";

import { alpha, hex, rotation, shapeName, xml, type Units } from "./units";

/** Deckastra shape kinds that map to a PPTX preset geometry. */
const PRESET_GEOMETRY: Record<string, string> = {
  rectangle: "rect",
  roundedRectangle: "roundRect",
  ellipse: "ellipse",
  circle: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
  pentagon: "pentagon",
  hexagon: "hexagon",
  star: "star5",
  arrow: "rightArrow",
  chevron: "chevron",
  parallelogram: "parallelogram",
  trapezoid: "trapezoid",
  cross: "plus",
  cloud: "cloud",
};

export interface ShapeContext {
  scene: SlideScene;
  units: Units;
  ledger: DegradationLedger;
  /**
   * What to call a shape, when it is half of a shared-element pair.
   *
   * PowerPoint's Morph pairs objects **by name** (doc 04 §33.3), and this
   * exporter derives names from element ids — which is what gives Morph
   * something stable to pair on across an edit. It is not enough on its own: two
   * paired elements are two *different* elements with two different ids, so
   * their names differ and Morph pairs nothing. A slide entered by a morph
   * therefore names its paired shapes after their partners on the previous
   * slide, which is the only thing that makes the pairing real.
   */
  nameOverrides?: ReadonlyMap<string, string>;
  /** Assigned in paint order, because PowerPoint needs unique non-zero ids. */
  nextId(): number;
  /**
   * The document's elements by id.
   *
   * Geometry comes from the scene and only from the scene — that is what keeps
   * PDF and PPTX agreeing about where things sit. But the scene resolves a shape
   * kind into a path, and DrawingML wants the kind back: `prstGeom prst="ellipse"`
   * is editable in PowerPoint where a converted path is not. So semantics are
   * read here, coordinates never are.
   */
  elementsById: Map<string, { type: string; shape?: string }>;
}

/**
 * One scene node as a PPTX shape, or nothing when it cannot be represented.
 *
 * Returning `undefined` is always accompanied by a ledger entry — an element
 * that vanishes from an export without a line in the report is the failure this
 * whole subsystem exists to prevent.
 */
export function shapeFor(node: SceneNode, context: ShapeContext): string | undefined {
  if (node.flags.hidden) return undefined;

  reportUnsupportedStyling(node, context);

  switch (node.renderPayload.kind) {
    case "text":
      return textShape(node, context);
    case "shape":
      return geometryShape(node, context);
    case "line":
      return lineShape(node, context);
    case "group":
      // A group's children are separate scene nodes already flattened into paint
      // order, so the group itself contributes only its own fill and stroke.
      // Doc 04 §33.2 maps groups to `<p:grpSp>`; flattening to absolute
      // positions is the declared degradation, and it is safe here because the
      // scene has already resolved every child's world transform.
      context.ledger.record({
        severity: "info",
        slideId: context.scene.slideId,
        elementId: node.id,
        feature: "group",
        action: "flattened",
        message:
          "Groups are exported as individually positioned shapes, so container " +
          "layout will not re-flow if the text is edited in PowerPoint.",
      });
      return node.resolvedStyle.fill ? geometryShape(node, context) : undefined;

    case "code":
      // Text box with a mono font and one run per line. Highlighting survives as
      // per-run colour; PowerPoint has no code element to map onto.
      return codeShape(node, context);

    case "table":
    case "chart":
    case "diagram":
    case "icon":
    case "image":
    case "placeholder":
    default:
      return unsupported(node, context);
  }
}

// ------------------------------------------------------------------- pieces

function transform(node: SceneNode, units: Units): string {
  const rotate = rotationOf(node);
  const attributes = rotate !== 0 ? ` rot="${rotation(rotate)}"` : "";

  return (
    `<a:xfrm${attributes}>` +
    `<a:off x="${units.px(node.bounds.x)}" y="${units.px(node.bounds.y)}"/>` +
    `<a:ext cx="${units.px(Math.max(1, node.bounds.width))}" cy="${units.px(Math.max(1, node.bounds.height))}"/>` +
    `</a:xfrm>`
  );
}

/**
 * The node's rotation, recovered from its world matrix.
 *
 * The scene stores a composed matrix rather than an angle, and PPTX wants an
 * angle. `atan2(b, a)` is exact for the rotate-and-translate matrices the
 * composer produces; a matrix carrying skew would not round-trip, which is why
 * the schema has no skew.
 */
function rotationOf(node: SceneNode): number {
  const { a, b } = node.worldTransform;
  const radians = Math.atan2(b, a);
  const degrees = (radians * 180) / Math.PI;
  return Math.abs(degrees) < 0.01 ? 0 : Number(degrees.toFixed(3));
}

function fillFor(node: SceneNode): string {
  const fill = node.resolvedStyle.fill;
  if (!fill) return "<a:noFill/>";

  const transparency = alpha(node.resolvedStyle.opacity);
  const inner = transparency === undefined ? "" : `<a:alpha val="${transparency}"/>`;
  return `<a:solidFill><a:srgbClr val="${hex(fill)}">${inner}</a:srgbClr></a:solidFill>`;
}

function strokeFor(node: SceneNode, units: Units): string {
  const stroke = node.resolvedStyle.stroke;
  if (!stroke || !stroke.color) return "<a:ln><a:noFill/></a:ln>";

  const width = units.px(stroke.width ?? 1);
  return `<a:ln w="${width}"><a:solidFill><a:srgbClr val="${hex(stroke.color)}"/></a:solidFill></a:ln>`;
}

function nonVisual(node: SceneNode, id: number, names?: ReadonlyMap<string, string>): string {
  // The name is derived from the element id, not from a counter: PowerPoint's
  // Morph pairs by name, and a counter re-numbers whenever a slide gains an
  // element (doc 04 §33.3). `names` is how a paired element borrows its
  // partner's id, which is what makes that pairing possible at all.
  return (
    `<p:nvSpPr>` +
    `<p:cNvPr id="${id}" name="${xml(shapeName(names?.get(node.id) ?? node.id))}"${describe(node)}/>` +
    `<p:cNvSpPr${node.renderPayload.kind === "text" ? ' txBox="1"' : ""}/>` +
    `<p:nvPr/>` +
    `</p:nvSpPr>`
  );
}

/** The a11y label, carried across so a screen reader in PowerPoint has one. */
function describe(node: SceneNode): string {
  const label = node.a11y.label;
  return label ? ` descr="${xml(label.slice(0, 300))}"` : "";
}

// -------------------------------------------------------------------- text

function textShape(node: SceneNode, context: ShapeContext): string {
  const payload = node.renderPayload;
  if (payload.kind !== "text") return "";

  const { units } = context;
  const paragraphs = payload.blocks
    .map((block) => paragraph(block, payload.typography, units, payload.align))
    .join("");

  return (
    `<p:sp>${nonVisual(node, context.nextId(), context.nameOverrides)}` +
    `<p:spPr>${transform(node, units)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `${node.resolvedStyle.fill ? fillFor(node) : "<a:noFill/>"}${strokeFor(node, units)}</p:spPr>` +
    `<p:txBody>` +
    // `spAutoFit` off and `wrap="square"`: the scene already decided where the
    // lines break, and letting PowerPoint re-fit would move text that the author
    // positioned deliberately.
    `<a:bodyPr wrap="square" ${insets(payload.padding, units)} anchor="${anchor(payload.verticalAlign)}"><a:noAutofit/></a:bodyPr>` +
    `<a:lstStyle/>${paragraphs || "<a:p/>"}` +
    `</p:txBody></p:sp>`
  );
}

function insets(padding: { top: number; right: number; bottom: number; left: number } | undefined, units: Units): string {
  const box = padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return (
    `lIns="${units.px(box.left)}" tIns="${units.px(box.top)}" ` +
    `rIns="${units.px(box.right)}" bIns="${units.px(box.bottom)}"`
  );
}

function anchor(vertical: string | undefined): string {
  if (vertical === "middle" || vertical === "center") return "ctr";
  if (vertical === "bottom") return "b";
  return "t";
}

function align(value: string | undefined): string {
  switch (value) {
    case "center":
      return ' algn="ctr"';
    case "right":
      return ' algn="r"';
    case "justify":
      return ' algn="just"';
    default:
      return "";
  }
}

interface TextBlockLike {
  type?: string;
  spans: { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; link?: string }[];
  indentLevel?: number;
}

function paragraph(
  block: TextBlockLike,
  typography: { fontFamily?: string; fontSize?: number; color?: string; fontWeight?: number },
  units: Units,
  alignment: string | undefined,
): string {
  const isList = block.type === "bullet" || block.type === "numbered" || block.type === "number";
  const level = isList ? (block.indentLevel ?? 0) : undefined;
  const properties =
    `<a:pPr${align(alignment)}${level !== undefined ? ` lvl="${Math.min(8, level)}"` : ""}` +
    // An explicit "no bullet" for anything that is not a list: PowerPoint's
    // default placeholder style adds one, and a paragraph that grows a bullet in
    // the client's copy is the classic PPTX export complaint.
    (level === undefined ? "><a:buNone/></a:pPr>" : "/>");

  const runs = block.spans
    .map((span) => run(span, typography, units))
    .join("");

  return `<a:p>${properties}${runs}</a:p>`;
}

function run(
  span: TextBlockLike["spans"][number],
  typography: { fontFamily?: string; fontSize?: number; color?: string; fontWeight?: number },
  units: Units,
): string {
  if (!span.text) return "";

  const family = (typography.fontFamily ?? "Inter").split(",")[0]!.trim().replace(/["']/g, "");
  const bold = span.bold || (typography.fontWeight ?? 400) >= 600 ? ' b="1"' : "";
  const italic = span.italic ? ' i="1"' : "";
  const underline = span.underline ? ' u="sng"' : "";
  const colour = hex(span.color ?? typography.color);

  return (
    `<a:r><a:rPr lang="en-US" sz="${units.fontSize(typography.fontSize ?? 18)}"${bold}${italic}${underline}>` +
    `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill>` +
    `<a:latin typeface="${xml(family)}"/><a:cs typeface="${xml(family)}"/>` +
    `</a:rPr><a:t>${xml(span.text)}</a:t></a:r>`
  );
}

// ------------------------------------------------------------------- shapes

function geometryShape(node: SceneNode, context: ShapeContext): string {
  const { units } = context;
  const payload = node.renderPayload;
  const kind = payload.kind === "shape" ? shapeKindOf(node, context) : "rectangle";
  const preset = PRESET_GEOMETRY[kind];

  if (!preset) {
    // Doc 04 §33.2: a custom path maps to `custGeom`. Converting an arbitrary
    // SVG path to DrawingML's path grammar is a real piece of work and gets it
    // subtly wrong on curves, so the honest MVP answer is a rectangle plus a
    // warning rather than a shape that is nearly right.
    context.ledger.record({
      severity: "warning",
      slideId: context.scene.slideId,
      elementId: node.id,
      feature: `shape:${kind}`,
      action: "approximated",
      message: `"${kind}" has no PowerPoint equivalent and was exported as a rectangle.`,
    });
  }

  const radius =
    payload.kind === "shape" && payload.radius > 0
      ? `<a:avLst><a:gd name="adj" fmla="val ${Math.min(50_000, Math.round((payload.radius / Math.max(1, Math.min(node.bounds.width, node.bounds.height))) * 100_000))}"/></a:avLst>`
      : "<a:avLst/>";

  const geometry = preset ?? "rect";
  const label =
    payload.kind === "shape" && payload.label
      ? `<p:txBody><a:bodyPr wrap="square" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
        payload.label
          .map((block) => paragraph(block as TextBlockLike, payload.labelTypography ?? {}, units, "center"))
          .join("") +
        `</p:txBody>`
      : `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>`;

  return (
    `<p:sp>${nonVisual(node, context.nextId(), context.nameOverrides)}` +
    `<p:spPr>${transform(node, units)}` +
    `<a:prstGeom prst="${geometry}">${radius}</a:prstGeom>` +
    `${fillFor(node)}${strokeFor(node, units)}</p:spPr>${label}</p:sp>`
  );
}

function shapeKindOf(node: SceneNode, context: ShapeContext): string {
  return context.elementsById.get(node.id)?.shape ?? "rectangle";
}

function lineShape(node: SceneNode, context: ShapeContext): string {
  const payload = node.renderPayload;
  if (payload.kind !== "line") return "";

  const { units } = context;
  const x = Math.min(payload.x1, payload.x2);
  const y = Math.min(payload.y1, payload.y2);
  const width = Math.max(1, Math.abs(payload.x2 - payload.x1));
  const height = Math.max(1, Math.abs(payload.y2 - payload.y1));

  // `flipH`/`flipV` rather than negative extents: DrawingML has no negative
  // size, and a line drawn right-to-left is expressed as a flip.
  const flipH = payload.x2 < payload.x1 ? ' flipH="1"' : "";
  const flipV = payload.y2 < payload.y1 ? ' flipV="1"' : "";

  const stroke = node.resolvedStyle.stroke;
  const head = payload.startMarker && payload.startMarker !== "none" ? `<a:headEnd type="triangle"/>` : "";
  const tail = payload.endMarker && payload.endMarker !== "none" ? `<a:tailEnd type="triangle"/>` : "";

  return (
    `<p:cxnSp><p:nvCxnSpPr>` +
    `<p:cNvPr id="${context.nextId()}" name="${xml(shapeName(context.nameOverrides?.get(node.id) ?? node.id))}"${describe(node)}/>` +
    `<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr><a:xfrm${flipH}${flipV}>` +
    `<a:off x="${units.px(node.bounds.x + x)}" y="${units.px(node.bounds.y + y)}"/>` +
    `<a:ext cx="${units.px(width)}" cy="${units.px(height)}"/></a:xfrm>` +
    `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
    `<a:ln w="${units.px(stroke?.width ?? 1)}">` +
    `<a:solidFill><a:srgbClr val="${hex(stroke?.color)}"/></a:solidFill>${head}${tail}</a:ln>` +
    `</p:spPr></p:cxnSp>`
  );
}

function codeShape(node: SceneNode, context: ShapeContext): string {
  const payload = node.renderPayload;
  if (payload.kind !== "code") return "";

  const { units } = context;

  context.ledger.record({
    severity: "info",
    slideId: context.scene.slideId,
    elementId: node.id,
    feature: "code",
    action: "flattened",
    message:
      "Code blocks become a monospaced text box. Syntax colours are preserved " +
      "per line, but the block is no longer a code element.",
  });

  // A token carries a *kind*, not a colour — the renderer derives colours from
  // the theme so a code block re-themes with the deck. The export resolves them
  // once here, because PPTX has no theme-aware token concept to defer to.
  const colours = payload.colors as unknown as Record<string, string>;
  const mono = { ...payload.typography, fontFamily: payload.typography.fontFamily ?? "Consolas" };

  const paragraphs = payload.lines
    .map(
      (line) =>
        `<a:p><a:pPr><a:buNone/></a:pPr>` +
        line.tokens
          .map((token) =>
            run({ text: token.text, color: colours[token.kind] ?? colours.plain }, mono, units),
          )
          .join("") +
        `</a:p>`,
    )
    .join("");

  return (
    `<p:sp>${nonVisual(node, context.nextId(), context.nameOverrides)}` +
    `<p:spPr>${transform(node, units)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `${fillFor(node)}${strokeFor(node, units)}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs || "<a:p/>"}</p:txBody>` +
    `</p:sp>`
  );
}

// ------------------------------------------------------------- degradations

/**
 * A placeholder rectangle for anything this adapter cannot yet build natively.
 *
 * A labelled box, never nothing. An element that disappears silently is the one
 * failure mode a compatibility export cannot have: the user hands the file to a
 * client and finds out from them.
 */
function unsupported(node: SceneNode, context: ShapeContext): string {
  const kind = node.renderPayload.kind;

  context.ledger.record({
    severity: "warning",
    slideId: context.scene.slideId,
    elementId: node.id,
    feature: kind,
    // `dropped`, not `rasterized`. "Rasterized" tells a reader the appearance
    // was preserved as an image and only the selectable text was lost — this
    // adapter embeds no image at all, it draws a labelled dashed box. Reporting
    // the friendlier word is the exact failure `DegradationLedger` exists to
    // prevent: the report has to be true about the file it just wrote.
    action: "dropped",
    message:
      `${kind} elements are replaced by a labelled placeholder box in this ` +
      `build — the content is not in the file.`,
  });

  const { units } = context;
  return (
    `<p:sp>${nonVisual(node, context.nextId(), context.nameOverrides)}` +
    `<p:spPr>${transform(node, units)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill/><a:ln w="${units.px(1)}"><a:solidFill><a:srgbClr val="808080"/></a:solidFill>` +
    `<a:prstDash val="dash"/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="1200"><a:solidFill><a:srgbClr val="808080"/></a:solidFill></a:rPr>` +
    `<a:t>${xml(node.name ?? kind)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

/** Effects PPTX cannot carry, reported once per slide per feature. */
function reportUnsupportedStyling(node: SceneNode, context: ShapeContext): void {
  const style = node.resolvedStyle;

  if (style.filter && style.filter.includes("blur")) {
    context.ledger.record({
      severity: "warning",
      slideId: context.scene.slideId,
      elementId: node.id,
      feature: "filter",
      action: "dropped",
      message:
        "PowerPoint has no equivalent for this filter, so it was removed. The " +
        "element is still there, without the effect.",
    });
  }

  if (style.blendMode && style.blendMode !== "normal") {
    context.ledger.record({
      severity: "warning",
      slideId: context.scene.slideId,
      elementId: node.id,
      feature: "blendMode",
      action: "dropped",
      message: `The "${style.blendMode}" blend mode has no PowerPoint equivalent.`,
    });
  }
}
