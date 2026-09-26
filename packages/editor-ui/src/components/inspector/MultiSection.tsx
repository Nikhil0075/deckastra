import type { PatchOperation, PresentationDocument, PresentationElement, ShadowStyle, StrokeStyle } from "@deckastra/presentation-schema";

import {
  canFill,
  canOutline,
  canRound,
  canShadow,
  hasText,
  isIcon,
  isText,
  matchSize,
  setForAll,
  sharedValue,
} from "../../lib/multi-edit";
import { Button, NumberField, Section, Select } from "../../ui";
import { ColorField, Hint } from "./controls";
import { FontPicker } from "./FontPicker";
import { SHADOW_PRESETS, shadowPresetOf } from "./paint";

type Edit = (operations: PatchOperation[], label: string) => void;

/**
 * The inspector for a multi-selection (design review, 2026-09-27): the
 * properties the selected objects share, each showing the common value or
 * "Mixed", and each change written to all of them in one patch.
 *
 * A control appears only when some selected object has that property, and it
 * changes only those; its hint says how many that is, because "Fill" changing
 * two of five selected objects without saying so would look like a bug.
 */
export function MultiSection({
  document,
  elements,
  edit,
}: {
  document: PresentationDocument;
  /** The selected objects that are not locked. */
  elements: readonly PresentationElement[];
  edit: Edit;
}) {
  const n = elements.length;
  const of = (count: number, noun = "object") => (count === n ? "" : `Changes ${count} of the ${n} selected ${noun}s.`);
  const write = (subset: readonly PresentationElement[], property: string, value: unknown | ((element: PresentationElement) => unknown), label: string) =>
    edit(setForAll(document, subset, property, value), subset.length > 1 ? `${label} of ${subset.length} objects` : label);

  const fillable = elements.filter(canFill);
  const outlined = elements.filter(canOutline);
  const rounded = elements.filter(canRound);
  const shadowed = elements.filter(canShadow);
  const texts = elements.filter(hasText);
  const textBoxes = elements.filter(isText);
  const icons = elements.filter(isIcon);

  const fill = sharedValue(fillable, (element) => {
    const paint = element.style?.fill;
    return paint?.type === "solid" ? paint.color : paint?.type ?? undefined;
  });
  const stroke = sharedValue(outlined, (element) => {
    const s = element.style?.stroke as StrokeStyle | undefined;
    return s && s.paint.type === "solid" ? s.paint.color : undefined;
  });
  const strokeWidth = sharedValue(outlined, (element) => (element.style?.stroke as StrokeStyle | undefined)?.width);
  const radius = sharedValue(rounded, (element) => (typeof element.style?.cornerRadius === "number" ? element.style.cornerRadius : 0));
  const opacity = sharedValue(elements, (element) => Math.round((element.opacity ?? 1) * 100));
  const shadow = sharedValue(shadowed, (element) => shadowPresetOf(element.style?.shadow as ShadowStyle[] | undefined));
  const textColor = sharedValue(texts, (element) => (element as { typography?: { color?: string } }).typography?.color);
  const font = sharedValue(textBoxes, (element) => (element as { typography?: { fontFamily?: string } }).typography?.fontFamily);
  const size = sharedValue(textBoxes, (element) => (element as { typography?: { fontSize?: number } }).typography?.fontSize);
  const iconColor = sharedValue(icons, (element) => (element as { color?: string }).color);

  return (
    <>
      <Section title="Style" meta={`${n} objects`} defaultOpen>
        {fillable.length ? (
          <>
            <ColorField
              label="Fill"
              value={typeof fill.value === "string" && fill.value !== "none" ? fill.value : undefined}
              mixed={fill.mixed}
              theme={document.theme}
              allowNone
              data-testid="multi-fill"
              onChange={(color) => write(fillable, "style.fill", color ? { type: "solid", color } : { type: "none" }, color ? "Change fill" : "Remove fill")}
            />
            {of(fillable.length) ? <Hint>{of(fillable.length)}</Hint> : null}
          </>
        ) : null}

        {outlined.length ? (
          <>
            <ColorField
              label="Outline"
              value={stroke.value}
              mixed={stroke.mixed}
              theme={document.theme}
              allowNone
              data-testid="multi-outline"
              onChange={(color) =>
                write(
                  outlined,
                  "style.stroke",
                  (element: PresentationElement) => {
                    if (!color) return element.type === "line" ? element.style?.stroke : undefined;
                    const current = element.style?.stroke as StrokeStyle | undefined;
                    return { ...(current ?? {}), paint: { type: "solid", color }, width: current?.width ?? 2 };
                  },
                  color ? "Change outline" : "Remove outline",
                )
              }
            />
            <div className="dk-grid2">
              <NumberField
                label="Width"
                ariaLabel="Outline width"
                value={strokeWidth.value ?? 0}
                mixed={strokeWidth.mixed}
                min={0}
                max={200}
                onCommit={(width) =>
                  write(
                    outlined,
                    "style.stroke",
                    (element: PresentationElement) => {
                      const current = element.style?.stroke as StrokeStyle | undefined;
                      if (width === 0) return element.type === "line" ? current : undefined;
                      return { ...(current ?? { paint: { type: "solid", color: "token:colors.foreground" } }), width };
                    },
                    "Change outline width",
                  )
                }
              />
              {rounded.length ? (
                <NumberField
                  label="Radius"
                  ariaLabel="Corner radius"
                  value={radius.value ?? 0}
                  mixed={radius.mixed}
                  min={0}
                  max={1000}
                  onCommit={(value) => write(rounded, "style.cornerRadius", value === 0 ? undefined : value, "Change corner radius")}
                />
              ) : null}
            </div>
          </>
        ) : null}

        <div className="dk-grid2">
          <NumberField
            label="Opacity"
            unit="%"
            integer
            value={opacity.value ?? 100}
            mixed={opacity.mixed}
            min={0}
            max={100}
            onCommit={(value) => write(elements, "opacity", value === 100 ? undefined : value / 100, "Change opacity")}
          />
        </div>

        {shadowed.length ? (
          <Select
            label="Shadow"
            value={shadow.mixed ? "mixed" : (shadow.value ?? "none")}
            data-testid="multi-shadow"
            options={[
              ...(shadow.mixed ? [{ value: "mixed", label: "Mixed" }] : []),
              ...Object.entries(SHADOW_PRESETS).map(([name, entry]) => ({ value: name, label: entry.label })),
              ...(shadow.value === "custom" ? [{ value: "custom", label: "Custom" }] : []),
            ]}
            onChange={(name) => {
              if (name === "mixed" || name === "custom") return;
              const chosen = SHADOW_PRESETS[name]!.shadows;
              write(shadowed, "style.shadow", () => (chosen.length ? structuredClone(chosen) : undefined), chosen.length ? "Change shadow" : "Remove shadow");
            }}
          />
        ) : null}

        {icons.length ? (
          <ColorField
            label="Icon colour"
            value={iconColor.value}
            mixed={iconColor.mixed}
            theme={document.theme}
            onChange={(color) => write(icons, "color", color, "Change icon colour")}
          />
        ) : null}
      </Section>

      {texts.length ? (
        <Section title="Text" meta={texts.length === n ? undefined : `${texts.length} of ${n}`} defaultOpen>
          <ColorField
            label="Text colour"
            value={textColor.value}
            mixed={textColor.mixed}
            theme={document.theme}
            data-testid="multi-text-color"
            onChange={(color) => write(texts, "typography.color", color, "Change text colour")}
          />
          {textBoxes.length ? (
            <>
              <FontPicker
                label="Font"
                value={font.mixed ? "" : (font.value ?? "")}
                document={document}
                onChange={(family) => write(textBoxes, "typography.fontFamily", family || undefined, "Change font")}
              />
              <div className="dk-grid2">
                <NumberField
                  label="Size"
                  ariaLabel="Font size"
                  unit="px"
                  value={size.value ?? 0}
                  mixed={size.mixed || size.value === undefined}
                  min={6}
                  max={400}
                  onCommit={(value) => write(textBoxes, "typography.fontSize", value, "Change font size")}
                />
              </div>
            </>
          ) : null}
          {of(texts.length, "object") ? <Hint>{of(texts.length, "object")}</Hint> : null}
        </Section>
      ) : null}

      <Section title="Size" defaultOpen>
        <div className="dk-grid2">
          <Button size="sm" onClick={() => edit(matchSize(document, elements, "width"), `Match width of ${n} objects`)} data-testid="equal-width">
            Equal width
          </Button>
          <Button size="sm" onClick={() => edit(matchSize(document, elements, "height"), `Match height of ${n} objects`)} data-testid="equal-height">
            Equal height
          </Button>
        </div>
        <Hint>Matches the first object you selected.</Hint>
      </Section>
    </>
  );
}
