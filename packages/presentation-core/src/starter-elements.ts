import {
  newId,
  plainText,
  type PresentationElement,
  type ShapeKind,
} from "@deckastra/presentation-schema";

export type StarterElementKind =
  | "text"
  | "shape"
  | "line"
  | "icon"
  | "chart"
  | "diagram"
  | "table"
  | "code"
  | "equation";

export interface StarterElementInput {
  kind: StarterElementKind;
  viewport: { width: number; height: number };
  shape?: ShapeKind;
}

/**
 * Produce useful, schema-valid starter content for toolbar insertion.
 *
 * Asset-backed elements are intentionally absent: inventing an asset id creates a
 * document that can never render. Images enter through the asset picker instead.
 */
export function makeStarterElement(input: StarterElementInput): PresentationElement {
  const size = defaultSize(input.kind);
  const transform = {
    x: Math.round((input.viewport.width - size.width) / 2),
    y: Math.round((input.viewport.height - size.height) / 2),
    ...size,
  };
  const base = { id: newId("el"), transform };

  switch (input.kind) {
    case "text":
      return {
        ...base,
        type: "text",
        content: plainText("New text", newId("blk")),
        typography: {
          fontFamily: "token:typography.body.fontFamily",
          fontSize: 32,
          color: "token:colors.foreground",
        },
        fit: "autoHeight",
        semanticRole: "body",
      } as PresentationElement;
    case "shape": {
      const shape = input.shape ?? "rectangle";
      return {
        ...base,
        type: "shape",
        shape,
        style: {
          fill: { type: "solid", color: "token:colors.accent" },
          cornerRadius: shape === "rectangle" ? 12 : 0,
        },
      } as PresentationElement;
    }
    case "line":
      return {
        ...base,
        type: "line",
        from: { x: 0, y: transform.height / 2 },
        to: { x: transform.width, y: transform.height / 2 },
        routing: "straight",
        endMarker: "arrow",
        style: {
          stroke: {
            paint: { type: "solid", color: "token:colors.foreground" },
            width: 3,
          },
        },
      } as unknown as PresentationElement;
    case "icon":
      return {
        ...base,
        type: "icon",
        icon: { set: "lucide", name: "database" },
        color: "token:colors.accent",
        strokeWidth: 2,
      } as PresentationElement;
    case "chart":
      return {
        ...base,
        type: "chart",
        chartType: "column",
        data: {
          type: "inline",
          rows: [
            { category: "Q1", value: 24 },
            { category: "Q2", value: 38 },
            { category: "Q3", value: 51 },
            { category: "Q4", value: 67 },
          ],
        },
        encoding: { category: "category", value: "value" },
        chartStyle: { showLegend: false, showGridlines: true, showDataLabels: true },
        altText: "Quarterly values",
      } as PresentationElement;
    case "diagram": {
      const first = newId("el");
      const second = newId("el");
      return {
        ...base,
        type: "diagram",
        diagramType: "flow",
        nodes: [
          { id: first, label: "Start", role: "actor" },
          { id: second, label: "Next step", role: "service" },
        ],
        edges: [{ id: newId("el"), from: first, to: second, direction: "forward" }],
        layoutHint: { algorithm: "layered", direction: "LR", mode: "managed" },
      } as PresentationElement;
    }
    case "table":
      return {
        ...base,
        type: "table",
        columns: [
          { id: newId("el"), label: "Item" },
          { id: newId("el"), label: "Value", align: "right" },
        ],
        rows: [
          { id: newId("el"), cells: [{ content: "Alpha" }, { content: "42", align: "right" }] },
          { id: newId("el"), cells: [{ content: "Beta" }, { content: "68", align: "right" }] },
        ],
        headerRow: true,
        tableStyle: { banding: "rows", borders: "horizontal" },
      } as PresentationElement;
    case "code":
      return {
        ...base,
        type: "code",
        language: "typescript",
        code: "const message = \"Hello, Deckastra!\";\nconsole.log(message);",
        fileName: "example.ts",
        showLineNumbers: true,
        wrap: true,
      } as PresentationElement;
    case "equation":
      // A real formula rather than a placeholder, so the first thing on the
      // slide shows what the element is for; the alt text says it in words.
      return {
        ...base,
        type: "equation",
        latex: String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
        display: true,
        // Display maths reads at heading size; the body size the element
        // otherwise inherits is set for paragraphs, not for a formula on its own.
        fontSize: 56,
        altText: "The quadratic formula",
      } as PresentationElement;
  }
}

function defaultSize(kind: StarterElementKind): { width: number; height: number } {
  switch (kind) {
    case "text": return { width: 480, height: 80 };
    case "shape": return { width: 320, height: 200 };
    case "line": return { width: 360, height: 80 };
    case "icon": return { width: 128, height: 128 };
    case "chart": return { width: 640, height: 360 };
    case "diagram": return { width: 680, height: 360 };
    case "table": return { width: 640, height: 300 };
    case "code": return { width: 680, height: 320 };
    case "equation": return { width: 560, height: 160 };
  }
}
