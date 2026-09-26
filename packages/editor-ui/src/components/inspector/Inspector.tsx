import {
  isGroup,
  type ChartElement,
  type DiagramElement,
  type ImageElement,
  type PatchOperation,
  type PresentationElement,
  type ShadowStyle,
  type TableElement,
  type TextElement,
  type EquationElement,
} from "@deckastra/presentation-schema";
import { resolveElementById, setPropertyDeep } from "@deckastra/presentation-core";

import { altTextFor, altTextProperty, needsAltText } from "../../lib/accessibility";
import { useAssetUrls } from "../../lib/asset-urls";
import { resizeOperations } from "../../lib/resize-operations";
import type { EditorApi } from "../../lib/useEditor";
import {
  Button,
  Icon,
  IconButton,
  Menu,
  NumberField,
  Section,
  Segmented,
  Select,
  StatusChip,
  TextField,
  type IconName,
} from "../../ui";
import { AccessibilityPanel } from "../AccessibilityPanel";
import { ThemePanel } from "../ThemePanel";
import { labelFor } from "./labels";
import { LayersList } from "./LayersList";
import { ArrangeSection } from "./ArrangeSection";
import { ChartSection } from "./ChartSection";
import { DiagramSection } from "./DiagramSection";
import { ImageSection } from "./ImageSection";
import { ShapeLabelSection, StyleSection } from "./StyleSection";
import { EffectsSection } from "./paint";
import { BackgroundSection } from "./BackgroundSection";
import { TableSection } from "./TableSection";
import { TextSection } from "./TextSection";
import { EquationSection } from "./EquationSection";
import { useColorStudio } from "../../lib/color-studio";
import { deckColors, namedColors, resolveColorValue } from "../../lib/colors";

export type ReorderDirection = "forward" | "backward" | "front" | "back";

export interface InspectorProps {
  editor: EditorApi;
  presentationId: string;
  selected?: PresentationElement;
  onReorder: (direction: ReorderDirection) => void;
  onToggle: (flag: "locked" | "visible") => void;
  onGroup: () => void;
  /** Dissolve the selected group (MA-06). */
  onUngroup: () => void;
  onDelete: () => void;
  /** Open the version history drawer (Phase 5). */
  onOpenHistory: () => void;
}

/**
 * The Design-mode right panel (Figma: MAIN SCREEN inspector). The selection's
 * own sections come first and open; deck-wide sections (layers, theme,
 * accessibility, history) follow collapsed, each with a one-line summary so a
 * closed section still says something.
 */
export function Inspector({
  editor,
  presentationId,
  selected,
  onReorder,
  onToggle,
  onGroup,
  onUngroup,
  onDelete,
  onOpenHistory,
}: InspectorProps) {
  const { document: doc, slideIndex, selection } = editor;
  const slide = doc.slides[slideIndex];
  const many = selection.selectedIds.length > 1;
  const objectCount = slide ? countElements(slide.elements) : 0;

  return (
    <div className="dk-inspector">
      {many ? (
        <div className="dk-inspector__head">
          <span className="dk-inspector__name">{selection.selectedIds.length} objects</span>
          <span className="dk-inspector__head-actions">
            <Button size="sm" onClick={onGroup}>
              Group
            </Button>
            <IconButton icon="trash" label="Delete selection" size="sm" onClick={onDelete} />
          </span>
        </div>
      ) : selected ? (
        <ElementHeader
          element={selected}
          onReorder={onReorder}
          onToggle={onToggle}
          onUngroup={onUngroup}
          onDelete={onDelete}
        />
      ) : (
        <p className="dk-inspector__empty">
          Nothing selected. Click an object on the slide, or pick one from Layers.
        </p>
      )}

      {selected && !many ? <ElementSections editor={editor} element={selected} /> : null}
      {/* Open when nothing is selected: clicking the empty slide is how people
          reach for the slide itself. */}
      <BackgroundSection key={`bg-${slide?.id}`} editor={editor} defaultOpen={!selected && !many} />
      <ArrangeSection editor={editor} />

      <Section title="Layers" meta={`${objectCount} object${objectCount === 1 ? "" : "s"}`} defaultOpen={!selected}>
        <LayersList editor={editor} />
      </Section>
      <Section title="Theme" meta={doc.theme.name}>
        <ThemePanel key={presentationId} editor={editor} presentationId={presentationId} />
      </Section>
      <ColorsSection editor={editor} />
      <Section title="Accessibility" meta="WCAG 2.1 AA">
        <AccessibilityPanel
          document={doc}
          slideId={slide?.id}
          onSelect={(targetSlideId, elementId) => {
            const targetIndex = doc.slides.findIndex((candidate) => candidate.id === targetSlideId);
            if (targetIndex < 0) return;
            editor.setSlideIndex(targetIndex);
            if (elementId) {
              editor.setSelection((current) => ({ ...current, selectedIds: [elementId], primaryId: elementId }));
            }
          }}
        />
      </Section>
      <Section title="This session" meta={`${editor.historyEntries.length} change${editor.historyEntries.length === 1 ? "" : "s"}`}>
        <ol className="dk-history">
          {editor.historyEntries.slice(0, 20).map((entry) => (
            <li key={entry.id} className="dk-history__row">
              <span className={entry.source === "agent" ? "dk-history__who dk-history__who--agent" : "dk-history__who"}>
                {entry.source === "agent" ? "AI" : "You"}
              </span>
              <span>{entry.label}</span>
            </li>
          ))}
          {editor.historyEntries.length === 0 ? <li className="dk-history__row">No changes yet.</li> : null}
        </ol>
      </Section>
      {/* Every saved version, not only this session's edits. A drawer rather
          than a section: previewing a past version needs the room, and the
          editor behind it must not be edited while one is on screen. */}
      <button type="button" className="dk-inspector__link" onClick={onOpenHistory} data-testid="open-history">
        <Icon name="history" size={14} />
        <span className="dk-inspector__link-title">Version history</span>
        <span className="dk-inspector__link-meta">All saved versions</span>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------- header

const TYPE_ICON: Record<string, IconName> = {
  text: "text",
  shape: "rect",
  line: "line",
  image: "image",
  chart: "chart",
  diagram: "diagram",
  table: "table",
  code: "code",
  icon: "grid",
  group: "duplicate",
};

function ElementHeader({
  element,
  onReorder,
  onToggle,
  onUngroup,
  onDelete,
}: {
  element: PresentationElement;
  onReorder: (direction: ReorderDirection) => void;
  onToggle: (flag: "locked" | "visible") => void;
  onUngroup: () => void;
  onDelete: () => void;
}) {
  const locked = element.locked === true;
  const hidden = element.visible === false;
  return (
    <div className="dk-inspector__head">
      <span className="dk-inspector__type" aria-hidden="true">
        <Icon name={TYPE_ICON[element.type] ?? "rect"} size={14} />
      </span>
      <span className="dk-inspector__name" title={element.type}>
        {labelFor(element)}
      </span>
      {element.semanticRole ? <StatusChip tone="neutral">{element.semanticRole}</StatusChip> : null}
      <span className="dk-inspector__head-actions">
        {isGroup(element) ? (
          // Visible, not only a shortcut: a generated card is a group, and
          // someone who wants one word out of it should find the way out here.
          <Button size="sm" onClick={onUngroup} disabled={locked} data-testid="ungroup">
            Ungroup
          </Button>
        ) : null}
        <IconButton
          icon={locked ? "lock" : "unlock"}
          label={locked ? "Unlock" : "Lock"}
          size="sm"
          pressed={locked}
          onClick={() => onToggle("locked")}
        />
        <IconButton
          icon={hidden ? "eyeOff" : "eye"}
          label={hidden ? "Show" : "Hide"}
          size="sm"
          pressed={hidden}
          onClick={() => onToggle("visible")}
        />
        <Menu
          label="Arrange"
          align="end"
          trigger={(props) => <IconButton icon="more" label="More actions" size="sm" {...props} />}
          items={[
            { id: "front", label: "Bring to front", onSelect: () => onReorder("front") },
            { id: "forward", label: "Bring forward", onSelect: () => onReorder("forward") },
            { id: "backward", label: "Send backward", onSelect: () => onReorder("backward") },
            { id: "back", label: "Send to back", onSelect: () => onReorder("back") },
            ...(isGroup(element) && !locked ? [{ id: "ungroup", label: "Ungroup (Ctrl+Shift+G)", onSelect: onUngroup }] : []),
            { id: "delete", label: "Delete", icon: "trash", danger: true, onSelect: onDelete },
          ]}
        />
      </span>
    </div>
  );
}

// ----------------------------------------------------------------- sections

type AnyElement = PresentationElement & Record<string, unknown>;

const SHAPES = ["rectangle", "ellipse", "triangle", "diamond", "pill", "star", "arrow", "chevron", "parallelogram", "speechBubble"];

function options(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

/**
 * The selected element's own fields. Every change goes through `editor.apply`
 * with a coalesce key per property, so typing a name is one undo step rather
 * than one per character, and number fields commit once per intent
 * (`NumberField`) — Enter, blur or an arrow step.
 *
 * The content editors — text, fill and outline, chart data, table cells,
 * diagram boxes, picture — are what make a deck buildable without an agent or
 * the JSON view (manual-authoring review, part B). Each lives in its own file
 * beside this one and writes through the same `edit`.
 */
function ElementSections({ editor, element }: { editor: EditorApi; element: PresentationElement }) {
  const el = element as AnyElement;
  const disabled = element.locked === true;
  const doc = editor.document;
  const viewport = doc.viewport;
  const resolveAssetUrl = useAssetUrls(doc);

  const edit = (operations: PatchOperation[], label: string, coalesceKey?: string) => {
    if (operations.length === 0) return;
    editor.apply(operations, { label, ...(coalesceKey ? { coalesceKey } : {}) });
  };
  const change = (property: string, value: unknown, label = "Edit object") =>
    edit(setPropertyDeep(doc, element.id, property, value), label, `inspector:${element.id}:${property}`);

  /**
   * Width and height go through the same resize the canvas handles use
   * (MA-07). Written straight to `transform.width`, a group's box changed while
   * its children stayed their old size, so the same numbers typed here or
   * dragged on the canvas gave two different slides.
   */
  const resizeTo = (dimension: "width" | "height", value: number) => {
    const found = resolveElementById(doc, element.id);
    if (!found) return;
    edit(resizeOperations(doc, element.id, { ...found.element.transform, [dimension]: value }), "Resize object", `inspector:${element.id}:size`);
  };

  return (
    <>
      <Section title="Position & size" defaultOpen>
        <div className="dk-grid2">
          <NumberField label="X" ariaLabel="X position" value={Math.round(element.transform.x)} disabled={disabled} onCommit={(v) => change("transform.x", v, "Move object")} />
          <NumberField label="Y" ariaLabel="Y position" value={Math.round(element.transform.y)} disabled={disabled} onCommit={(v) => change("transform.y", v, "Move object")} />
          <NumberField label="W" ariaLabel="Width" value={Math.round(element.transform.width)} min={1} disabled={disabled} onCommit={(v) => resizeTo("width", v)} />
          <NumberField label="H" ariaLabel="Height" value={Math.round(element.transform.height)} min={1} disabled={disabled} onCommit={(v) => resizeTo("height", v)} />
          <NumberField label="R" ariaLabel="Rotation" unit="°" value={element.transform.rotation ?? 0} min={-360} max={360} disabled={disabled} onCommit={(v) => change("transform.rotation", v, "Rotate object")} />
        </div>
        <span className="dk-field__hint">
          Logical units, {viewport.width} × {viewport.height} space
        </span>
      </Section>

      {element.type === "text" ? <TextSection document={doc} element={element as TextElement} edit={edit} disabled={disabled} /> : null}
      {element.type === "equation" ? <EquationSection document={doc} element={element as EquationElement} edit={edit} disabled={disabled} /> : null}
      {element.type === "shape" ? <ShapeLabelSection document={doc} element={element} edit={edit} disabled={disabled} /> : null}
      {element.type === "chart" ? <ChartSection document={doc} element={element as ChartElement} edit={edit} disabled={disabled} /> : null}
      {element.type === "table" ? <TableSection document={doc} element={element as TableElement} edit={edit} disabled={disabled} /> : null}
      {element.type === "diagram" ? <DiagramSection document={doc} element={element as DiagramElement} edit={edit} disabled={disabled} /> : null}
      {element.type === "image" ? (
        <ImageSection document={doc} element={element as ImageElement} edit={edit} disabled={disabled} resolveAssetUrl={resolveAssetUrl} />
      ) : null}

      {element.type === "shape" || element.type === "line" || element.type === "icon" || isGroup(element) ? (
        <StyleSection document={doc} element={element} edit={edit} disabled={disabled} />
      ) : null}

      {element.type !== "line" ? (
        <EffectsSection
          shadows={element.style?.shadow as ShadowStyle[] | undefined}
          blur={(element.style?.backdropFilters as { type: string; radius?: number }[] | undefined)?.find((f) => f.type === "blur")?.radius}
          canBlur={element.type === "shape" || isGroup(element)}
          theme={doc.theme}
          disabled={disabled}
          onShadows={(shadows) => change("style.shadow", shadows, shadows ? "Change shadow" : "Remove shadow")}
          onBlur={(radius) =>
            change("style.backdropFilters", radius ? [{ type: "blur", radius }] : undefined, radius ? "Blur what is behind" : "Remove background blur")
          }
        />
      ) : null}

      <Section title="Appearance" defaultOpen>
        <div className="dk-grid2">
          <NumberField
            label="Opacity"
            unit="%"
            value={Math.round((element.opacity ?? 1) * 100)}
            min={0}
            max={100}
            integer
            disabled={disabled}
            onCommit={(v) => change("opacity", v / 100, "Change opacity")}
          />
        </div>

        {element.type === "shape" ? (
          <Select label="Shape" value={String(el.shape)} options={options(SHAPES)} disabled={disabled} onChange={(v) => change("shape", v, "Change shape")} />
        ) : null}

        {element.type === "icon" ? (
          <TextField label="Icon" value={String((el.icon as { name?: unknown } | undefined)?.name ?? "")} disabled={disabled} onChange={(v) => change("icon.name", v, "Change icon")} />
        ) : null}

        {element.type === "code" ? (
          <>
            <TextField label="Language" value={String(el.language ?? "")} disabled={disabled} onChange={(v) => change("language", v, "Change code language")} />
            <label className="dk-label" htmlFor={`code-${element.id}`}>
              Code
            </label>
            <textarea
              id={`code-${element.id}`}
              className="dk-input dk-textarea dk-textarea--mono"
              value={String(el.code ?? "")}
              disabled={disabled}
              rows={8}
              onChange={(event) => change("code", event.target.value, "Edit code")}
            />
          </>
        ) : null}

        {isGroup(element) ? (
          <Select
            label="Resize behaviour"
            value={element.resizeMode ?? (element.containerLayout ? "resizeContainer" : "scaleChildren")}
            options={[
              { value: "scaleChildren", label: "Scale objects and text" },
              { value: "resizeContainer", label: "Resize container only" },
            ]}
            disabled={disabled}
            onChange={(v) => change("resizeMode", v, "Change group resize behavior")}
          />
        ) : null}
      </Section>

      <Section title="Details" defaultOpen={needsAltText(element)}>
        <TextField label="Name" value={element.name ?? ""} placeholder="Optional" disabled={disabled} onChange={(v) => change("name", v, "Rename object")} />
        {needsAltText(element) ? (
          <>
            <label className="dk-label" htmlFor={`alt-${element.id}`}>
              Alt text
            </label>
            <textarea
              id={`alt-${element.id}`}
              className="dk-input dk-textarea"
              value={altTextFor(element)}
              placeholder="Describe the visual's meaning"
              disabled={disabled}
              rows={3}
              onChange={(event) => change(altTextProperty(element), event.target.value, "Edit alternative text")}
            />
          </>
        ) : null}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ helpers

function countElements(elements: readonly PresentationElement[]): number {
  let count = 0;
  for (const element of elements) {
    count += 1;
    if (isGroup(element)) count += countElements(element.children);
  }
  return count;
}

/**
 * The deck's palette at a glance, and the way into the Colours panel (colour
 * wizard, 2026-09-26): the brand roles and the named colours as swatches, and a
 * count of loose colours that will not follow a new theme.
 */
function ColorsSection({ editor }: { editor: EditorApi }) {
  const studio = useColorStudio();
  const doc = editor.document;
  const named = namedColors(doc);
  const loose = deckColors(doc).length;
  const colors = doc.theme.colors as unknown as Record<string, unknown>;
  const brand = ["accent", "secondary", "foreground", "background", "surface"].filter((token) => typeof colors[token] === "string");
  return (
    <Section title="Colours" meta={`${named.length} named${loose ? ` · ${loose} loose` : ""}`}>
      <div className="dk-swatches" aria-label="Deck colours">
        {brand.map((token) => (
          <span key={token} className="dk-swatch dk-swatch--static" title={token} style={{ background: resolveColorValue(doc, colors[token] as string) }} />
        ))}
        {named.map((color) => (
          <span key={color.name} className="dk-swatch dk-swatch--static" title={color.name} style={{ background: resolveColorValue(doc, color.value) }} />
        ))}
      </div>
      {studio ? (
        <Button size="sm" icon="theme" onClick={() => studio.open()} data-testid="open-color-studio">
          Edit colours…
        </Button>
      ) : null}
    </Section>
  );
}
