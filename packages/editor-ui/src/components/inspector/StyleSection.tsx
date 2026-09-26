import type {
  PatchOperation,
  PresentationDocument,
  PresentationElement,
  RichTextDocument,
  StrokeStyle,
} from "@deckastra/presentation-schema";
import { newId, plainText } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { applyPlainTextEdit, richTextToPlain } from "@deckastra/editor";

import { NumberField, Section, Select } from "../../ui";
import { ColorField, Hint } from "./controls";

/**
 * Fill, stroke and corners (manual-authoring review MA-15), and a shape's label
 * (MA-20).
 *
 * Opacity and a shape picker alone cannot author an ordinary diagram: two boxes
 * have to be able to differ in colour, a connector has to be dashed, a card has
 * to lose its outline. Each control writes the element's own `style` through
 * `setPropertyDeep`, so the first stroke a shape ever gets is one `add` whose
 * inverse removes exactly it.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

const DASHES: Record<string, number[] | undefined> = { solid: undefined, dashed: [8, 6], dotted: [2, 4] };
const MARKERS = ["none", "arrow", "openArrow", "dot", "square", "diamond"];
const MARKER_LABELS: Record<string, string> = {
  none: "None", arrow: "Arrow", openArrow: "Open arrow", dot: "Dot", square: "Square", diamond: "Diamond",
};

function dashName(dash: readonly number[] | undefined): string {
  if (!dash || dash.length === 0) return "solid";
  for (const [name, pattern] of Object.entries(DASHES)) {
    if (pattern && pattern.length === dash.length && pattern.every((v, i) => v === dash[i])) return name;
  }
  return "custom";
}

export function StyleSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: PresentationElement;
  edit: Edit;
  disabled: boolean;
}) {
  const style = element.style ?? {};
  const set = (property: string, value: unknown, label: string) =>
    edit(setPropertyDeep(document, element.id, property, value), label, `inspector:${element.id}:${property}`);

  const isLine = element.type === "line";
  // Text boxes are not offered a fill: the renderer does not paint one, and a
  // control whose change never appears is worse than no control.
  const fillable = element.type === "shape" || element.type === "group";
  const fill = style.fill;
  const fillColor = fill?.type === "solid" ? fill.color : undefined;
  const stroke = style.stroke as StrokeStyle | undefined;
  const strokeColor = stroke?.paint.type === "solid" ? stroke.paint.color : undefined;
  const hasStroke = stroke !== undefined && stroke.paint.type !== "none";
  const el = element as PresentationElement & Record<string, unknown>;

  return (
    <Section title={isLine ? "Line" : "Fill & outline"} defaultOpen>
      {fillable ? (
        <>
          {fill && fill.type !== "solid" && fill.type !== "none" ? (
            <Hint>This object has a {fill.type === "image" ? "picture" : "gradient"} fill. Choosing a colour replaces it; Undo brings it back.</Hint>
          ) : null}
          <ColorField
            label="Fill"
            value={fillColor}
            theme={document.theme}
            allowNone
            disabled={disabled}
            data-testid="fill-color"
            onChange={(color) =>
              set("style.fill", color ? { type: "solid", color } : element.type === "shape" ? { type: "none" } : undefined, color ? "Change fill" : "Remove fill")
            }
          />
        </>
      ) : null}

      <ColorField
        label={isLine ? "Colour" : "Outline"}
        value={hasStroke ? strokeColor : undefined}
        theme={document.theme}
        allowNone={!isLine}
        disabled={disabled}
        data-testid="stroke-color"
        onChange={(color) => {
          if (!color) {
            set("style.stroke", undefined, "Remove outline");
            return;
          }
          const next: StrokeStyle = { ...(stroke ?? { width: 2 }), paint: { type: "solid", color }, width: stroke?.width ?? 2 };
          set("style.stroke", next, isLine ? "Change line colour" : "Change outline");
        }}
      />
      {hasStroke || isLine ? (
        <div className="dk-grid2">
          <NumberField
            label="Width"
            ariaLabel={isLine ? "Line width" : "Outline width"}
            value={stroke?.width ?? (isLine ? 2 : 0)}
            min={0}
            max={200}
            disabled={disabled || !stroke}
            onCommit={(v) => set("style.stroke.width", v, "Change stroke width")}
          />
          <Select
            label="Dash"
            value={dashName(stroke?.dash)}
            options={[
              { value: "solid", label: "Solid" },
              { value: "dashed", label: "Dashed" },
              { value: "dotted", label: "Dotted" },
              ...(dashName(stroke?.dash) === "custom" ? [{ value: "custom", label: "Custom" }] : []),
            ]}
            disabled={disabled || !stroke}
            data-testid="stroke-dash"
            onChange={(v) => {
              if (v === "custom") return;
              set("style.stroke.dash", DASHES[v], "Change dash");
            }}
          />
        </div>
      ) : null}

      {(element.type === "shape" && el.shape === "rectangle") || element.type === "group" ? (
        <div className="dk-grid2">
          <NumberField
            label="Radius"
            ariaLabel="Corner radius"
            value={typeof style.cornerRadius === "number" ? style.cornerRadius : 0}
            min={0}
            max={1000}
            disabled={disabled || (style.cornerRadius !== undefined && typeof style.cornerRadius !== "number")}
            onCommit={(v) => set("style.cornerRadius", v === 0 ? undefined : v, "Change corner radius")}
          />
        </div>
      ) : null}

      {isLine ? (
        <div className="dk-grid2">
          <Select label="Start" value={String(el.startMarker ?? "none")} options={MARKERS.map((m) => ({ value: m, label: MARKER_LABELS[m]! }))} disabled={disabled} onChange={(v) => set("startMarker", v === "none" ? undefined : v, "Change line start")} />
          <Select label="End" value={String(el.endMarker ?? "none")} options={MARKERS.map((m) => ({ value: m, label: MARKER_LABELS[m]! }))} disabled={disabled} onChange={(v) => set("endMarker", v === "none" ? undefined : v, "Change line end")} />
          <Select label="Routing" value={String(el.routing ?? "straight")} options={[{ value: "straight", label: "Straight" }, { value: "orthogonal", label: "Elbow" }, { value: "curved", label: "Curved" }]} disabled={disabled} onChange={(v) => set("routing", v, "Change line routing")} />
        </div>
      ) : null}

      {element.type === "icon" ? (
        <ColorField label="Icon colour" value={el.color as string | undefined} theme={document.theme} disabled={disabled} onChange={(v) => set("color", v, "Change icon colour")} />
      ) : null}
    </Section>
  );
}

/**
 * A shape's label (MA-20), editable here as well as by double-clicking the
 * shape. The label is part of the shape — one element, one animation target —
 * so editing it never splits the shape into a box and a text box.
 */
export function ShapeLabelSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: PresentationElement;
  edit: Edit;
  disabled: boolean;
}) {
  const label = (element as { text?: RichTextDocument }).text;
  return (
    <Section title="Label" defaultOpen={label !== undefined}>
      <label className="dk-label" htmlFor={`label-${element.id}`}>
        Text in the shape
      </label>
      <textarea
        id={`label-${element.id}`}
        className="dk-input dk-textarea"
        value={label ? richTextToPlain(label) : ""}
        placeholder="Type a label"
        disabled={disabled}
        rows={2}
        data-testid="shape-label"
        onChange={(event) => {
          const value = event.target.value;
          const next = value === "" ? undefined : label ? applyPlainTextEdit(label, value) : plainText(value, newId("blk"));
          edit(setPropertyDeep(document, element.id, "text", next), "Edit shape label", `inspector:${element.id}:text`);
        }}
      />
      <Hint>Or double-click the shape on the slide to type in it.</Hint>
    </Section>
  );
}
