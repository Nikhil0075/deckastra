import type { CSSProperties, ReactNode } from "react";

import { toCss } from "../matrix";
import type { SceneNode, TextBlockPayload } from "../scene";
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
      const lines = payload.code.split("\n");
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
                font: "500 14px ui-monospace, monospace",
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
              whiteSpace: "pre",
            }}
          >
            {lines.map((line, i) => (
              <div key={i} style={{ display: "flex", gap: 16 }}>
                {payload.showLineNumbers ? (
                  <span
                    style={{
                      opacity: 0.4,
                      userSelect: "none",
                      minWidth: "2.5ch",
                      textAlign: "right",
                    }}
                  >
                    {payload.startLineNumber + i}
                  </span>
                ) : null}
                <span>{line || " "}</span>
              </div>
            ))}
          </pre>
        </div>
      );
    }

    case "table": {
      const cellPadding = "10px 16px";
      return (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            ...typographyToCss(payload.typography),
          }}
        >
          {payload.headerRow ? (
            <thead>
              <tr>
                {payload.columns.map((col) => (
                  <th
                    key={col.id}
                    style={{
                      textAlign: (col.align as CSSProperties["textAlign"]) ?? "left",
                      padding: cellPadding,
                      borderBottom: "2px solid rgba(127,127,127,0.4)",
                      fontWeight: 600,
                      opacity: 0.85,
                    }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {payload.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    style={{
                      textAlign:
                        (cell.align as CSSProperties["textAlign"]) ??
                        (payload.columns[i]?.align as CSSProperties["textAlign"]) ??
                        "left",
                      padding: cellPadding,
                      borderBottom: "1px solid rgba(127,127,127,0.2)",
                      fontWeight: row.emphasis === "total" ? 700 : undefined,
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

/**
 * Positioned box for one scene node. Geometry comes from the scene; this only
 * emits it.
 *
 * Groups get their fill, stroke and radius here rather than from a payload,
 * because a group draws no content of its own — its children are separate scene
 * nodes. Without this a card built as a styled group renders as an invisible
 * container and its children float on the slide background.
 */
export function positionStyle(node: SceneNode, zIndex: number): CSSProperties {
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
    // Nothing in the render layer is interactive; present mode owns pointer input.
    pointerEvents: "none",
  };
}
