import type { CSSProperties, ReactNode } from "react";

import { toCss } from "../matrix";
import type {
  ChartPayload,
  DiagramPayload,
  IconPayload,
  SceneNode,
  TablePayload,
  TextBlockPayload,
} from "../scene";
import type { TypographyStyle } from "@deckastra/presentation-schema";

/**
 * Element renderers.
 *
 * Every component here does nothing but emit markup from numbers the scene has
 * already resolved. No layout logic, no measurement, no token lookups — those all
 * happened in `buildScene`. That separation is what makes the same slide render
 * identically in the editor, in a PNG and in a PDF (doc 04 §7.2).
 */

function typographyToCss(t: TypographyStyle, overrideSize?: number): CSSProperties {
  return {
    fontFamily: t.fontFamily,
    fontSize: overrideSize ?? t.fontSize,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    lineHeight: t.lineHeight ?? 1.3,
    letterSpacing: t.letterSpacing ? `${t.letterSpacing}px` : undefined,
    color: t.color,
    textTransform: t.textTransform as CSSProperties["textTransform"],
    textDecoration: t.textDecoration === "lineThrough" ? "line-through" : t.textDecoration,
    fontFeatureSettings: t.fontFeatures?.map((f) => `"${f}"`).join(", "),
  };
}

function Spans({ block, baseSize }: { block: TextBlockPayload; baseSize: number }): ReactNode {
  return (
    <>
      {block.spans.map((span, i) => {
        const style: CSSProperties = {
          fontWeight: span.bold ? 700 : undefined,
          fontStyle: span.italic ? "italic" : undefined,
          textDecoration: span.underline ? "underline" : undefined,
          color: span.color,
          // Relative, never absolute: shrink-to-fit scales one number and every
          // span keeps its relative emphasis (doc 02 §12.1).
          fontSize: span.fontSizeScale ? baseSize * span.fontSizeScale : undefined,
          fontFamily: span.code ? "ui-monospace, monospace" : undefined,
        };

        if (span.link) {
          return (
            <a key={i} href={span.link} style={style} rel="noreferrer noopener">
              {span.text}
            </a>
          );
        }
        return (
          <span key={i} style={style}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}

function TextBlocks({
  blocks,
  typography,
  appliedFontSize,
}: {
  blocks: TextBlockPayload[];
  typography: TypographyStyle;
  appliedFontSize: number;
}): ReactNode {
  return (
    <>
      {blocks.map((block) => {
        const listed = block.type === "bullet" || block.type === "numbered";
        const style: CSSProperties = {
          margin: 0,
          textAlign: block.align as CSSProperties["textAlign"],
          marginLeft: block.indentLevel ? block.indentLevel * 24 : undefined,
          // `text-wrap: balance` on headings prevents the single-orphan last line
          // that makes generated titles look unconsidered (doc 02 §12.3).
          textWrap: block.type === "heading" ? "balance" : undefined,
          listStyle: listed ? undefined : "none",
          paddingLeft: listed ? 28 : 0,
        };

        if (listed) {
          return (
            <li key={block.id} style={{ ...style, listStyle: block.type === "numbered" ? "decimal" : "disc", marginLeft: 24 + (block.indentLevel ?? 0) * 24 }}>
              <Spans block={block} baseSize={appliedFontSize} />
            </li>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={block.id} style={{ ...style, fontStyle: "italic" }}>
              <Spans block={block} baseSize={appliedFontSize} />
            </blockquote>
          );
        }

        return (
          <p key={block.id} style={style}>
            <Spans block={block} baseSize={appliedFontSize} />
          </p>
        );
      })}
    </>
  );
}

export interface ElementProps {
  node: SceneNode;
  /** Resolves an asset's storageKey to a URL. Signed URLs are minted at render
   *  time and never persisted (doc 02 §28.1), so the renderer asks rather than
   *  reading a URL out of the document. */
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  children?: ReactNode;
}

export function ElementContent({ node, resolveAssetUrl }: ElementProps): ReactNode {
  const payload = node.renderPayload;
  const { width, height } = node.localBounds;

  switch (payload.kind) {
    case "text": {
      const justify =
        payload.verticalAlign === "middle"
          ? "center"
          : payload.verticalAlign === "bottom"
            ? "flex-end"
            : "flex-start";

      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: justify,
            padding: payload.padding
              ? `${payload.padding.top}px ${payload.padding.right}px ${payload.padding.bottom}px ${payload.padding.left}px`
              : undefined,
            // Overflow is visible by default (doc 02 §12): clipping generated text
            // hides the problem instead of surfacing it, and the validator already
            // reports it as W103.
            overflow: "visible",
            ...typographyToCss(payload.typography, payload.metrics.appliedFontSize),
          }}
        >
          <TextBlocks
            blocks={payload.blocks}
            typography={payload.typography}
            appliedFontSize={payload.metrics.appliedFontSize}
          />
        </div>
      );
    }

    case "shape": {
      const { fill, stroke, opacity } = node.resolvedStyle;
      const strokeWidth = stroke?.width ?? 0;

      return (
        <>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
            aria-hidden="true"
          >
            {payload.preferRect ? (
              <rect
                x={strokeWidth / 2}
                y={strokeWidth / 2}
                width={Math.max(0, width - strokeWidth)}
                height={Math.max(0, height - strokeWidth)}
                rx={payload.radius || undefined}
                fill={fill ?? "none"}
                stroke={stroke?.color}
                strokeWidth={strokeWidth || undefined}
                strokeDasharray={stroke?.dash?.join(" ")}
                opacity={opacity}
              />
            ) : (
              <path
                d={payload.pathData}
                fill={fill ?? "none"}
                stroke={stroke?.color}
                strokeWidth={strokeWidth || undefined}
                strokeDasharray={stroke?.dash?.join(" ")}
                strokeLinejoin="round"
                opacity={opacity}
              />
            )}
          </svg>

          {payload.label && payload.labelTypography ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: 16,
                ...typographyToCss(payload.labelTypography),
              }}
            >
              <TextBlocks
                blocks={payload.label}
                typography={payload.labelTypography}
                appliedFontSize={payload.labelTypography.fontSize}
              />
            </div>
          ) : null}
        </>
      );
    }

    case "line": {
      const stroke = node.resolvedStyle.stroke;
      return (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
          aria-hidden="true"
        >
          <line
            x1={payload.x1}
            y1={payload.y1}
            x2={payload.x2}
            y2={payload.y2}
            stroke={stroke?.color ?? "currentColor"}
            strokeWidth={stroke?.width ?? 1}
            strokeDasharray={stroke?.dash?.join(" ")}
            strokeLinecap="round"
          />
        </svg>
      );
    }

    case "image": {
      const src = resolveAssetUrl?.(payload.assetId, payload.storageKey);

      if (!src) {
        // A missing asset URL is a resolution failure, not a document error. Show
        // the gap rather than an empty box, so it is obvious what is missing.
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "grid",
              placeItems: "center",
              background: "rgba(127,127,127,0.12)",
              border: "1px dashed rgba(127,127,127,0.4)",
              borderRadius: node.resolvedStyle.cornerRadius,
              font: "500 14px ui-sans-serif, system-ui, sans-serif",
              color: "rgba(127,127,127,0.9)",
            }}
          >
            {payload.altText ?? "Image unavailable"}
          </div>
        );
      }

      return (
        <img
          src={src}
          alt={payload.altText ?? ""}
          style={{
            width: "100%",
            height: "100%",
            objectFit: payload.objectFit as CSSProperties["objectFit"],
            objectPosition: payload.objectPosition,
            borderRadius: node.resolvedStyle.cornerRadius,
            display: "block",
          }}
        />
      );
    }

    case "code": {
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            overflow: "hidden",
            borderRadius: node.resolvedStyle.cornerRadius ?? 8,
            background: node.resolvedStyle.fill ?? "rgba(127,127,127,0.10)",
            border: node.resolvedStyle.stroke
              ? `${node.resolvedStyle.stroke.width}px solid ${node.resolvedStyle.stroke.color}`
              : "1px solid rgba(127,127,127,0.25)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {payload.fileName ? (
            <div
              style={{
                padding: "8px 16px",
                borderBottom: "1px solid rgba(127,127,127,0.25)",
                fontFamily: payload.typography.fontFamily,
                fontSize: Math.round(payload.typography.fontSize * 0.8),
                fontWeight: 500,
                opacity: 0.7,
              }}
            >
              {payload.fileName}
            </div>
          ) : null}
          <pre
            style={{
              margin: 0,
              padding: 16,
              overflow: "hidden",
              ...typographyToCss(payload.typography),
              color: payload.colors.plain,
              whiteSpace: "pre",
            }}
          >
            {payload.lines.map((line) => (
              <div key={line.number} style={{ display: "flex", gap: 16 }}>
                {payload.showLineNumbers ? (
                  <span
                    style={{
                      color: payload.colors.comment,
                      opacity: 0.6,
                      userSelect: "none",
                      minWidth: "2.5ch",
                      textAlign: "right",
                    }}
                  >
                    {line.number}
                  </span>
                ) : null}
                <span>
                  {line.tokens.length === 0 ? " " : null}
                  {line.tokens.map((token, i) => (
                    <span key={i} style={{ color: payload.colors[token.kind] }}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </pre>
        </div>
      );
    }

    case "table":
      return <TableContent payload={payload} />;

    case "chart":
      return <ChartContent payload={payload} width={width} height={height} />;

    case "diagram":
      return <DiagramContent payload={payload} width={width} height={height} />;

    case "icon":
      return <IconContent payload={payload} width={width} height={height} />;

    case "group":
      // A group paints nothing itself; its children are separate nodes.
      return null;

    case "placeholder":
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
            textAlign: "center",
            background: "rgba(127,127,127,0.08)",
            border: "1px dashed rgba(127,127,127,0.45)",
            borderRadius: 8,
            font: "500 15px ui-sans-serif, system-ui, sans-serif",
            color: "rgba(127,127,127,0.95)",
          }}
        >
          <strong style={{ fontSize: 17 }}>{payload.label}</strong>
          <span style={{ fontSize: 13, opacity: 0.8 }}>{payload.reason}</span>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------- table

function TableContent({ payload }: { payload: TablePayload }): ReactNode {
  const { padding, borders, borderColor } = payload;
  const cellPadding = `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`;

  const horizontalBorder =
    borders === "all" || borders === "horizontal" ? `1px solid ${borderColor}` : undefined;
  const verticalBorder = borders === "all" ? `1px solid ${borderColor}` : undefined;

  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        border: borders === "outer" || borders === "all" ? `1px solid ${borderColor}` : undefined,
        ...typographyToCss(payload.typography),
      }}
    >
      {payload.columns.some((column) => column.width) ? (
        <colgroup>
          {payload.columns.map((column) => (
            <col key={column.id} style={{ width: column.width }} />
          ))}
        </colgroup>
      ) : null}

      {payload.headerRow ? (
        <thead>
          <tr>
            {payload.columns.map((column) => (
              <th
                key={column.id}
                style={{
                  textAlign: (column.align as CSSProperties["textAlign"]) ?? "left",
                  padding: cellPadding,
                  background: payload.headerFill,
                  borderBottom: `2px solid ${borderColor}`,
                  borderRight: verticalBorder,
                  ...typographyToCss(payload.headerTypography),
                }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}

      <tbody>
        {payload.rows.map((row, rowIndex) => (
          <tr
            key={row.id}
            style={{
              background:
                row.emphasis === "total" || row.emphasis === "highlight"
                  ? payload.emphasisFill
                  : payload.banding === "rows" && rowIndex % 2 === 1
                    ? payload.bandColor
                    : undefined,
            }}
          >
            {row.cells.map((cell, columnIndex) => (
              <td
                key={columnIndex}
                colSpan={cell.colSpan}
                rowSpan={cell.rowSpan}
                style={{
                  textAlign:
                    (cell.align as CSSProperties["textAlign"]) ??
                    (payload.columns[columnIndex]?.align as CSSProperties["textAlign"]) ??
                    "left",
                  padding: cellPadding,
                  borderBottom: horizontalBorder,
                  borderRight: verticalBorder,
                  background:
                    cell.fill ??
                    (payload.banding === "columns" && columnIndex % 2 === 1
                      ? payload.bandColor
                      : undefined),
                  // A total row and a header column are both emphasis, and both
                  // come from the document rather than from a guess about content.
                  fontWeight:
                    row.emphasis === "total" || row.emphasis === "subtotal"
                      ? 700
                      : payload.headerColumn && columnIndex === 0
                        ? 600
                        : undefined,
                }}
              >
                {cell.text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------- chart

function Notice({ text }: { text: string }): ReactNode {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
        background: "rgba(127,127,127,0.06)",
        border: "1px dashed rgba(127,127,127,0.35)",
        borderRadius: 10,
        font: "500 18px ui-sans-serif, system-ui, sans-serif",
        color: "rgba(127,127,127,0.95)",
      }}
    >
      {text}
    </div>
  );
}

function ChartContent({
  payload,
  width,
  height,
}: {
  payload: ChartPayload;
  width: number;
  height: number;
}): ReactNode {
  if (payload.notice) return <Notice text={payload.notice} />;

  const labelColor = String(payload.labelTypography.color ?? "currentColor");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
      role="img"
      aria-label={payload.altText}
      fontFamily={payload.labelTypography.fontFamily}
    >
      {payload.altText ? <title>{payload.altText}</title> : null}

      {payload.gridlines.map((line, i) => (
        <line
          key={`g${i}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={labelColor}
          strokeOpacity={0.18}
          strokeWidth={1}
        />
      ))}

      {payload.axisLines.map((line, i) => (
        <line
          key={`a${i}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={labelColor}
          strokeOpacity={0.45}
          strokeWidth={1.5}
        />
      ))}

      {payload.rects.map((rect) => (
        <rect
          key={rect.id}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={rect.radius || undefined}
          fill={rect.fill}
        />
      ))}

      {payload.paths.map((path) => (
        <path
          key={path.id}
          d={path.d}
          fill={path.fill ?? "none"}
          fillOpacity={path.fillOpacity}
          stroke={path.stroke}
          strokeWidth={path.strokeWidth}
          strokeDasharray={path.dash}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {payload.points.map((point) => (
        <circle key={point.id} cx={point.cx} cy={point.cy} r={point.r} fill={point.fill} />
      ))}

      {payload.texts.map((text) => (
        <text
          key={text.id}
          x={text.x}
          y={text.y}
          textAnchor={text.anchor}
          fontSize={text.fontSize}
          fontWeight={text.weight}
          fill={text.fill}
          transform={text.rotate ? `rotate(${text.rotate} ${text.x} ${text.y})` : undefined}
        >
          {text.text}
        </text>
      ))}

      {payload.legend.map((item) => (
        <g key={item.label}>
          <rect
            x={item.swatch.x}
            y={item.swatch.y}
            width={item.swatch.width}
            height={item.swatch.height}
            rx={3}
            fill={item.color}
          />
          <text
            x={item.textX}
            y={item.textY}
            dominantBaseline="middle"
            fontSize={payload.labelTypography.fontSize}
            fill={labelColor}
          >
            {item.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// -------------------------------------------------------------------- diagram

function DiagramContent({
  payload,
  width,
  height,
}: {
  payload: DiagramPayload;
  width: number;
  height: number;
}): ReactNode {
  if (payload.notice) return <Notice text={payload.notice} />;

  // One marker definition per diagram rather than per edge: identical arrowheads,
  // and markup that does not grow with the edge count. The id is derived from a
  // node id so two diagrams on one slide cannot collide in the shared defs scope.
  const markerId = `arrow-${payload.nodes[0]?.id ?? "d"}`;
  const arrowColor = payload.edges[0]?.stroke ?? "currentColor";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
      fontFamily={payload.typography.fontFamily}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={arrowColor} />
        </marker>
      </defs>

      {payload.groups.map((group) => (
        <g key={group.id}>
          <rect
            x={group.x}
            y={group.y}
            width={group.width}
            height={group.height}
            rx={group.radius}
            fill={group.fill ?? "none"}
            stroke={group.stroke}
            strokeWidth={group.strokeWidth}
            strokeDasharray={group.dash}
          />
          {group.label ? (
            <text
              x={group.label.x}
              y={group.label.y}
              fontSize={group.label.size}
              fill={group.label.color}
              letterSpacing={1}
            >
              {group.label.text}
            </text>
          ) : null}
        </g>
      ))}

      {payload.edges.map((edge) => (
        <g key={edge.id}>
          <path
            d={edge.d}
            fill="none"
            stroke={edge.stroke}
            strokeWidth={edge.strokeWidth}
            strokeDasharray={edge.dash}
            markerEnd={edge.markerEnd ? `url(#${markerId})` : undefined}
            markerStart={edge.markerStart ? `url(#${markerId})` : undefined}
          />
          {edge.label ? (
            <text
              x={edge.label.x}
              y={edge.label.y}
              textAnchor="middle"
              fontSize={edge.label.size}
              fill={edge.label.color}
            >
              {edge.label.text}
            </text>
          ) : null}
        </g>
      ))}

      {payload.nodes.map((n) => (
        <g key={n.id} data-diagram-node={n.id} data-role={n.role}>
          <rect
            x={n.x}
            y={n.y}
            width={n.width}
            height={n.height}
            rx={n.radius}
            fill={n.fill}
            stroke={n.stroke}
            strokeWidth={n.strokeWidth}
            strokeDasharray={n.dash}
          />
          <text
            x={n.x + n.width / 2}
            y={n.sublabel ? n.y + n.height / 2 - 2 : n.y + n.height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={n.labelSize}
            fontWeight={600}
            fill={n.labelColor}
          >
            {n.label}
          </text>
          {n.sublabel ? (
            <text
              x={n.x + n.width / 2}
              y={n.y + n.height / 2 + n.sublabelSize + 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={n.sublabelSize}
              fill={n.labelColor}
              opacity={0.65}
            >
              {n.sublabel}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

// ----------------------------------------------------------------------- icon

function IconContent({
  payload,
  width,
  height,
}: {
  payload: IconPayload;
  width: number;
  height: number;
}): ReactNode {
  if (payload.missing) {
    // Named, not blank. A deck that asks for an icon this build does not carry
    // should still say which one it wanted (doc 02 §0.8).
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "grid",
          placeItems: "center",
          border: "1px dashed rgba(127,127,127,0.45)",
          borderRadius: 8,
          font: "500 11px ui-sans-serif, system-ui, sans-serif",
          color: "rgba(127,127,127,0.9)",
          textAlign: "center",
          padding: 4,
          overflow: "hidden",
        }}
        title={payload.missing}
      >
        {payload.name}
      </div>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${payload.viewBox} ${payload.viewBox}`}
      style={{ position: "absolute", inset: 0 }}
      fill="none"
      stroke={payload.color}
      strokeWidth={payload.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={payload.name}
    >
      {payload.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {payload.circles.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}

/**
 * Positioned box for one scene node. Geometry comes from the scene; this only
 * emits it.
 *
 * Groups get their fill, stroke and radius here rather than from a payload,
 * because a group draws no content of its own — its children are separate scene
 * nodes. Without this a card built as a styled group renders as an invisible
 * container and its children float on the slide background.
 */
export function positionStyle(
  node: SceneNode,
  zIndex: number,
  interactive = false,
): CSSProperties {
  const { width, height } = node.localBounds;
  const { fill, stroke, cornerRadius } = node.resolvedStyle;
  const isContainer = node.type === "group";

  return {
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height,
    // The composed world transform, emitted once. Children are never individually
    // re-scaled to fit (doc 04 §4.2).
    transform: toCss(node.worldTransform),
    transformOrigin: "0 0",
    zIndex,
    opacity: node.resolvedStyle.opacity,
    boxShadow: node.resolvedStyle.shadow,
    filter: node.resolvedStyle.filter,
    mixBlendMode: node.resolvedStyle.blendMode as CSSProperties["mixBlendMode"],
    background: isContainer ? fill : undefined,
    border:
      isContainer && stroke ? `${stroke.width}px solid ${stroke.color}` : undefined,
    borderRadius: isContainer ? cornerRadius : undefined,
    // A group is a stacking context, so a child can never paint outside its
    // group's z-band (doc 04 §8.3).
    isolation: isContainer ? "isolate" : undefined,
    // The render layer is inert unless the editor asks for hits: present and
    // export must never let a click land on a rendered element, but the editor
    // resolves selection from `data-element-id` on exactly these boxes, so
    // making them inert there means nothing on the canvas is ever selectable.
    pointerEvents: interactive ? "auto" : "none",
  };
}
