import type { PatchOperation, PresentationDocument, RichTextDocument, TextElement } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { applyPlainTextEdit, richTextToPlain } from "@deckastra/editor";

import { NumberField, Section, Segmented, Select } from "../../ui";
import { ColorField, Hint } from "./controls";

/**
 * A text box's words and typography (manual-authoring review MA-08, MA-14).
 *
 * Every control here writes the element's own properties — never the theme — so
 * a title, a formatted body and a caption can differ on one slide without
 * restyling the whole deck. Formatting inside the words (bold, a list) is done
 * on the canvas, where the selection is; this panel carries what applies to
 * the whole box.
 */

type Edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => void;

const TEXT_STYLES = ["display", "h1", "h2", "h3", "body", "bodySmall", "caption", "quote", "metric"] as const;
const STYLE_LABELS: Record<(typeof TEXT_STYLES)[number], string> = {
  display: "Display",
  h1: "Title",
  h2: "Heading",
  h3: "Subheading",
  body: "Body",
  bodySmall: "Small body",
  caption: "Caption",
  quote: "Quote",
  metric: "Big number",
};

const FAMILIES: { value: string; label: string }[] = [
  { value: "token:typography.h1.fontFamily", label: "Theme heading font" },
  { value: "token:typography.body.fontFamily", label: "Theme body font" },
  { value: "token:typography.code.fontFamily", label: "Theme code font" },
  { value: "Inter", label: "Inter" },
  { value: "Jost", label: "Jost" },
  { value: "Arial", label: "Arial" },
  { value: "Helvetica", label: "Helvetica" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times New Roman" },
  { value: "Verdana", label: "Verdana" },
  { value: "Courier New", label: "Courier New" },
];

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];
const WEIGHT_LABELS: Record<number, string> = {
  300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black",
};

export function TextSection({
  document,
  element,
  edit,
  disabled,
}: {
  document: PresentationDocument;
  element: TextElement;
  edit: Edit;
  disabled: boolean;
}) {
  const typography = element.typography;
  const set = (property: string, value: unknown, label: string) =>
    edit(setPropertyDeep(document, element.id, property, value), label, `inspector:${element.id}:${property}`);

  const family = typography.fontFamily;
  const families = FAMILIES.some((option) => option.value === family)
    ? FAMILIES
    : [{ value: family, label: family.startsWith("token:") ? family.replace(/^token:typography\.|\.fontFamily$/g, "") : family }, ...FAMILIES];
  const weight = typography.fontWeight ?? 400;
  const align = element.paragraph?.align ?? "left";
  const themeTypography = document.theme.typography as Record<string, { fontSize?: number; fontWeight?: number; lineHeight?: number; letterSpacing?: number; textTransform?: string } | undefined>;

  return (
    <Section title="Text" defaultOpen meta={`${typography.fontSize}px`}>
      <label className="dk-label" htmlFor={`text-${element.id}`}>
        Content
      </label>
      <textarea
        id={`text-${element.id}`}
        className="dk-input dk-textarea"
        value={richTextToPlain(element.content)}
        disabled={disabled}
        rows={3}
        onChange={(event) =>
          // Spliced into the rich text, never a replacement of it: one typo
          // fixed here used to flatten every bold run and bullet in the box.
          edit(
            setPropertyDeep(document, element.id, "content", applyPlainTextEdit(element.content as RichTextDocument, event.target.value)),
            "Edit text",
            `inspector:${element.id}:content`,
          )
        }
      />
      <Hint>Formatting is kept. Double-click the text on the slide to make words bold or italic, or to start a list.</Hint>

      <Select
        label="Style"
        value=""
        options={[
          { value: "", label: "Apply a text style…" },
          ...TEXT_STYLES.filter((name) => themeTypography[name]).map((name) => ({ value: name, label: STYLE_LABELS[name] })),
        ]}
        disabled={disabled}
        data-testid="text-style"
        onChange={(name) => {
          const token = themeTypography[name];
          if (!name || !token) return;
          // The theme's style for the role, carried as the element's own values
          // (with the family as a token, so it still re-themes). The colour is
          // the author's and is left alone.
          const next: Record<string, unknown> = {
            ...typography,
            fontFamily: `token:typography.${name}.fontFamily`,
            ...(token.fontSize ? { fontSize: token.fontSize } : {}),
            ...(token.fontWeight ? { fontWeight: token.fontWeight } : {}),
            ...(token.lineHeight ? { lineHeight: token.lineHeight } : {}),
          };
          if (token.letterSpacing !== undefined) next.letterSpacing = token.letterSpacing;
          else delete next.letterSpacing;
          if (token.textTransform) next.textTransform = token.textTransform;
          else delete next.textTransform;
          edit(setPropertyDeep(document, element.id, "typography", next), `Apply ${STYLE_LABELS[name as keyof typeof STYLE_LABELS]} style`);
        }}
      />

      <Select label="Font" value={family} options={families} disabled={disabled} data-testid="font-family" onChange={(v) => set("typography.fontFamily", v, "Change font")} />
      <div className="dk-grid2">
        <Select
          label="Weight"
          value={String(weight)}
          options={WEIGHTS.map((w) => ({ value: String(w), label: WEIGHT_LABELS[w]! }))}
          disabled={disabled}
          data-testid="font-weight"
          onChange={(v) => set("typography.fontWeight", Number(v), "Change font weight")}
        />
        <NumberField label="Size" ariaLabel="Font size" value={typography.fontSize} min={1} max={1000} disabled={disabled} onCommit={(v) => set("typography.fontSize", v, "Change font size")} />
        <NumberField label="Line" ariaLabel="Line spacing" value={typography.lineHeight ?? 1.3} min={0.5} max={4} step={0.1} disabled={disabled} onCommit={(v) => set("typography.lineHeight", v, "Change line spacing")} />
        <NumberField label="Track" ariaLabel="Letter spacing" value={typography.letterSpacing ?? 0} min={-20} max={100} step={0.5} disabled={disabled} onCommit={(v) => set("typography.letterSpacing", v === 0 ? undefined : v, "Change letter spacing")} />
      </div>
      <span className="dk-label">Style</span>
      <Segmented
        label="Italic"
        size="sm"
        value={typography.fontStyle ?? "normal"}
        onChange={(v) => set("typography.fontStyle", v === "normal" ? undefined : v, "Change font style")}
        items={[
          { value: "normal", label: "Upright", disabled },
          { value: "italic", label: "Italic", disabled },
        ]}
      />
      <ColorField
        label="Colour"
        value={typography.color}
        theme={document.theme}
        disabled={disabled}
        data-testid="text-color"
        onChange={(v) => set("typography.color", v, "Change text colour")}
      />
      <span className="dk-label">Align</span>
      <Segmented
        label="Horizontal alignment"
        size="sm"
        value={align}
        onChange={(v) => set("paragraph.align", v === "left" ? undefined : v, "Align text")}
        items={[
          { value: "left", label: "Left", disabled },
          { value: "center", label: "Centre", disabled },
          { value: "right", label: "Right", disabled },
          { value: "justify", label: "Justify", disabled },
        ]}
      />
      <Segmented
        label="Vertical alignment"
        size="sm"
        value={element.verticalAlign ?? "top"}
        onChange={(v) => set("verticalAlign", v === "top" ? undefined : v, "Align text vertically")}
        items={[
          { value: "top", label: "Top", disabled },
          { value: "middle", label: "Middle", disabled },
          { value: "bottom", label: "Bottom", disabled },
        ]}
      />
      <span className="dk-label">Fit mode</span>
      <Segmented
        label="Fit mode"
        size="sm"
        value={String(element.fit ?? "fixed")}
        onChange={(value) => set("fit", value, "Change text fit")}
        items={[
          { value: "fixed", label: "Fixed", disabled },
          { value: "autoHeight", label: "Auto H", disabled },
          { value: "shrinkToFit", label: "Shrink", disabled },
        ]}
      />
      {element.fit === "shrinkToFit" ? (
        <div className="dk-grid2">
          <NumberField
            label="Min"
            ariaLabel="Minimum font size"
            value={Number(element.minFontSize ?? Math.max(12, typography.fontSize * 0.5))}
            min={1}
            disabled={disabled}
            onCommit={(v) => set("minFontSize", v, "Change minimum font size")}
          />
        </div>
      ) : null}
    </Section>
  );
}
