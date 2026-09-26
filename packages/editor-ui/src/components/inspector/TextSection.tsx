import type { PatchOperation, PresentationDocument, RichTextDocument, TextElement } from "@deckastra/presentation-schema";
import { setPropertyDeep } from "@deckastra/presentation-core";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import { useState } from "react";

import { uploadFont } from "../../lib/font-file";
import { applyPlainTextEdit, richTextToPlain } from "@deckastra/editor";

import { NumberField, Section, Segmented, Select } from "../../ui";
import { FontPicker, previewFamily } from "./FontPicker";
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
  const client = useWorkspaceClient();
  const [fontMessage, setFontMessage] = useState<string | undefined>();
  const typography = element.typography;
  /** Upload a font and use it here, as one patch: the face is declared and used together. */
  const onUploadFont = async (file: File) => {
    setFontMessage("Uploading font…");
    try {
      const uploaded = await uploadFont(client, { document, file });
      edit(
        [...uploaded.operations, ...setPropertyDeep(document, element.id, "typography.fontFamily", uploaded.family)],
        "Upload font",
      );
      setFontMessage(
        uploaded.fromFile
          ? `Using ${uploaded.family}.`
          : `Using ${uploaded.family} (named from the file, which does not say its family).`,
      );
    } catch (error) {
      setFontMessage(error instanceof Error ? error.message : "That font could not be uploaded.");
    }
  };
  const set = (property: string, value: unknown, label: string) =>
    edit(setPropertyDeep(document, element.id, property, value), label, `inspector:${element.id}:${property}`);

  const family = typography.fontFamily;
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

      <span className="dk-label">Text style</span>
      <div className="dk-textstyles" role="group" aria-label="Text style" data-testid="text-style">
        {TEXT_STYLES.filter((name) => themeTypography[name]).map((name) => {
          const token = themeTypography[name]!;
          const current =
            typography.fontFamily === `token:typography.${name}.fontFamily` && typography.fontSize === token.fontSize;
          const face = (token as { fontFamily?: string }).fontFamily ?? "";
          return (
            <button
              key={name}
              type="button"
              className="dk-textstyle"
              aria-pressed={current}
              disabled={disabled}
              title={`${STYLE_LABELS[name]}: ${token.fontSize ?? ""}px`}
              style={{
                fontFamily: previewFamily(face),
                fontWeight: token.fontWeight,
                fontSize: Math.max(12, Math.min(22, (token.fontSize ?? 24) / 3.2)),
                textTransform: token.textTransform as never,
              }}
              onClick={() => {
                // The theme's style for the role, carried as the element's own
                // values (with the family as a token, so it still re-themes).
                // The colour is the author's and is left alone.
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
                edit(setPropertyDeep(document, element.id, "typography", next), `Apply ${STYLE_LABELS[name]} style`);
              }}
            >
              {STYLE_LABELS[name]}
            </button>
          );
        })}
      </div>

      <FontPicker label="Font" value={family} document={document} disabled={disabled} data-testid="font-family" onChange={(v) => set("typography.fontFamily", v, "Change font")} onUpload={(file) => void onUploadFont(file)} />
      {fontMessage ? <span className="dk-field__hint" role="status" data-testid="font-upload-status">{fontMessage}</span> : null}
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
