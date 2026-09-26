"use client";

import { useRef, useState, type ReactNode } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { PatchOperation } from "@deckastra/presentation-schema";
import { contrastRatio, parseColor } from "@deckastra/renderer";

import { manifestOperations, uploadPicture } from "../lib/insert-image";
import {
  fontPairOperations,
  letterSpacingOperations,
  lineHeightOperations,
  placeLogoOperations,
  placedLogo,
  removeLogoOperations,
  SCALE_RATIOS,
  typeScaleOperations,
  writePath,
  type LogoCorner,
} from "../lib/theme-customise";
import type { EditorApi } from "../lib/useEditor";
import { Button, NumberField, Select } from "../ui";
import { ColorField, Hint, resolveColor } from "./inspector/controls";
import { FontPicker } from "./inspector/FontPicker";

type Typo = { fontFamily?: string; fontSize?: number; lineHeight?: number; letterSpacing?: number };

/**
 * Customise the design system (design review, 2026-09-27): everything a theme
 * holds besides its colours, which have the Colours view. Each control writes
 * the theme in one patch, so anything that refers to a token follows and one
 * Undo reverses it.
 */
export function ThemeCustomise({ editor }: { editor: EditorApi }) {
  const doc = editor.document;
  const theme = doc.theme;
  const typography = theme.typography as unknown as Record<string, Typo> & { scaleRatio?: number };
  const edit = (operations: PatchOperation[], label: string) => {
    if (operations.length) editor.apply(operations, { label });
  };
  const write = (path: string, value: unknown, label: string) => edit(writePath(doc, path, value), label);

  const chart = theme.chart as undefined | { gridlineColor?: string; axisColor?: string; showGridlines?: boolean; barCornerRadius?: number; lineWidth?: number; labelTypography?: Typo };
  // A chart theme must list its series; the first write brings the theme's own palette.
  const writeChart = (key: string, value: unknown, label: string) =>
    edit(
      chart ? writePath(doc, `theme.chart.${key}`, value) : writePath(doc, "theme.chart", { series: [...(theme.colors.chartSeries as string[])], [key]: value }),
      label,
    );
  const diagram = theme.diagram as undefined | { nodeRadius?: number; nodeTypography?: Typo; edgeStroke?: { paint?: { type: string; color?: string }; width?: number } };
  const table = (theme as { table?: { headerFill?: { type: string; color?: string }; headerColor?: string; borderColor?: string; borders?: string; banding?: string; fontSize?: number } }).table;
  const bodyFamily = "token:typography.body.fontFamily";

  const headerFill = table?.headerFill?.type === "solid" ? table.headerFill.color : undefined;
  const headerContrast = contrast(theme, table?.headerColor ?? "token:colors.foregroundMuted", headerFill ?? "token:colors.background");
  const safe = doc.viewport.safeArea;

  return (
    <div className="dk-customise" data-testid="theme-customise">
      <Group title="Fonts">
        <FontPicker label="Headings" value={typography.h1?.fontFamily ?? ""} document={doc} onChange={(family) => family && edit(fontPairOperations(doc, family), "Change heading font")} data-testid="theme-heading-font" />
        <FontPicker label="Body" value={typography.body?.fontFamily ?? ""} document={doc} onChange={(family) => family && edit(fontPairOperations(doc, undefined, family), "Change body font")} data-testid="theme-body-font" />
      </Group>

      <Group title="Type scale">
        <div className="dk-grid2">
          <NumberField
            label="Body"
            ariaLabel="Body text size"
            unit="px"
            value={typography.body?.fontSize ?? 24}
            min={10}
            max={64}
            onCommit={(size) => edit(typeScaleOperations(doc, size, typography.scaleRatio ?? 1.25), "Change type scale")}
            data-testid="theme-body-size"
          />
          <Select
            label="Scale"
            value={String(nearestRatio(typography.scaleRatio))}
            options={SCALE_RATIOS.map((ratio) => ({ value: String(ratio.value), label: ratio.label }))}
            onChange={(ratio) => edit(typeScaleOperations(doc, typography.body?.fontSize ?? 24, Number(ratio)), "Change type scale")}
          />
          <NumberField label="Heading lines" ariaLabel="Heading line height" step={0.05} value={typography.h1?.lineHeight ?? 1.1} min={0.8} max={2.5} onCommit={(v) => edit(lineHeightOperations(doc, "headings", v), "Change heading line height")} />
          <NumberField label="Body lines" ariaLabel="Body line height" step={0.05} value={typography.body?.lineHeight ?? 1.4} min={0.8} max={2.5} onCommit={(v) => edit(lineHeightOperations(doc, "body", v), "Change body line height")} />
          <NumberField label="Heading spacing" ariaLabel="Heading letter spacing" unit="px" step={0.5} value={typography.h1?.letterSpacing ?? 0} min={-10} max={20} onCommit={(v) => edit(letterSpacingOperations(doc, "headings", v), "Change heading letter spacing")} />
        </div>
        <TypePreview typography={typography} />
      </Group>

      <Group title="Spacing and corners">
        <div className="dk-grid2">
          <NumberField
            label="Safe margin"
            ariaLabel="Safe margin on every side"
            unit="px"
            value={safe?.left ?? 0}
            min={0}
            max={400}
            onCommit={(v) => write("viewport.safeArea", v ? { top: v, right: v, bottom: v, left: v } : undefined, "Change safe margin")}
          />
          <NumberField label="Small" ariaLabel="Small corner radius" value={theme.radii.sm} min={0} max={200} onCommit={(v) => write("theme.radii.sm", v, "Change corner radius")} />
          <NumberField label="Medium" ariaLabel="Medium corner radius" value={theme.radii.md} min={0} max={200} onCommit={(v) => write("theme.radii.md", v, "Change corner radius")} />
          <NumberField label="Large" ariaLabel="Large corner radius" value={theme.radii.lg} min={0} max={400} onCommit={(v) => write("theme.radii.lg", v, "Change corner radius")} />
        </div>
        <Hint>The safe margin is where Design Check expects objects to stay. Corners apply to anything using a theme radius.</Hint>
      </Group>

      <Group title="Charts">
        <ColorField label="Gridlines" value={chart?.gridlineColor} theme={theme} onChange={(v) => writeChart("gridlineColor", v, "Change chart gridlines")} />
        <ColorField label="Axis and labels" value={chart?.axisColor} theme={theme} onChange={(v) => writeChart("axisColor", v, "Change chart axis colour")} />
        <label className="dk-export__option">
          <input type="checkbox" checked={chart?.showGridlines !== false} onChange={(event) => writeChart("showGridlines", event.target.checked ? undefined : false, "Show or hide gridlines")} />
          Show gridlines
        </label>
        <div className="dk-grid2">
          <NumberField label="Bar corners" ariaLabel="Bar corner radius" value={chart?.barCornerRadius ?? 0} min={0} max={40} onCommit={(v) => writeChart("barCornerRadius", v, "Change bar corners")} />
          <NumberField label="Line width" ariaLabel="Chart line width" value={chart?.lineWidth ?? 3} min={1} max={20} onCommit={(v) => writeChart("lineWidth", v, "Change chart line width")} />
          <NumberField
            label="Label size"
            ariaLabel="Chart label size"
            unit="px"
            value={chart?.labelTypography?.fontSize ?? 16}
            min={8}
            max={48}
            onCommit={(v) => writeChart("labelTypography", { ...(chart?.labelTypography ?? {}), fontFamily: chart?.labelTypography?.fontFamily ?? bodyFamily, fontSize: v }, "Change chart label size")}
          />
        </div>
      </Group>

      <Group title="Diagrams">
        <div className="dk-grid2">
          <NumberField label="Box corners" ariaLabel="Diagram box corner radius" value={diagram?.nodeRadius ?? 12} min={0} max={80} onCommit={(v) => write("theme.diagram.nodeRadius", v, "Change diagram corners")} />
          <NumberField
            label="Label size"
            ariaLabel="Diagram label size"
            unit="px"
            value={diagram?.nodeTypography?.fontSize ?? 20}
            min={10}
            max={48}
            onCommit={(v) => write("theme.diagram.nodeTypography", { ...(diagram?.nodeTypography ?? {}), fontFamily: diagram?.nodeTypography?.fontFamily ?? bodyFamily, fontSize: v }, "Change diagram label size")}
          />
          <NumberField
            label="Line width"
            ariaLabel="Diagram connection width"
            value={diagram?.edgeStroke?.width ?? 2}
            min={1}
            max={12}
            onCommit={(v) => write("theme.diagram.edgeStroke", { paint: diagram?.edgeStroke?.paint ?? { type: "solid", color: "token:colors.borderStrong" }, width: v }, "Change diagram lines")}
          />
        </div>
        <ColorField
          label="Connections"
          value={diagram?.edgeStroke?.paint?.type === "solid" ? diagram.edgeStroke.paint.color : undefined}
          theme={theme}
          onChange={(color) => write("theme.diagram.edgeStroke", color ? { paint: { type: "solid", color }, width: diagram?.edgeStroke?.width ?? 2 } : undefined, "Change diagram line colour")}
        />
      </Group>

      <Group title="Tables">
        <ColorField
          label="Heading row"
          value={headerFill}
          theme={theme}
          allowNone
          data-testid="theme-table-header-fill"
          onChange={(color) => write("theme.table.headerFill", color ? { type: "solid", color } : undefined, "Change table heading row")}
        />
        <ColorField label="Heading text" value={table?.headerColor} theme={theme} onChange={(color) => write("theme.table.headerColor", color, "Change table heading text")} data-testid="theme-table-header-color" />
        {headerContrast !== undefined ? (
          <p className="dk-field__hint" role="status" data-testid="theme-table-contrast">
            Heading text is {headerContrast.toFixed(1)}:1 on its row{headerContrast < 4.5 ? " — too faint to read; pick a lighter or darker text." : "."}
          </p>
        ) : null}
        <ColorField label="Lines" value={table?.borderColor} theme={theme} onChange={(color) => write("theme.table.borderColor", color, "Change table lines")} />
        <div className="dk-grid2">
          <Select
            label="Lines"
            value={table?.borders ?? "horizontal"}
            options={[
              { value: "horizontal", label: "Between rows" },
              { value: "all", label: "Every cell" },
              { value: "outer", label: "Outside only" },
              { value: "none", label: "None" },
            ]}
            onChange={(v) => write("theme.table.borders", v, "Change table lines")}
          />
          <Select
            label="Banding"
            value={table?.banding ?? "none"}
            options={[
              { value: "none", label: "None" },
              { value: "rows", label: "Rows" },
              { value: "columns", label: "Columns" },
            ]}
            onChange={(v) => write("theme.table.banding", v === "none" ? undefined : v, "Change table banding")}
          />
          <NumberField label="Text" ariaLabel="Table text size" unit="px" value={table?.fontSize ?? 20} min={10} max={40} onCommit={(v) => write("theme.table.fontSize", v, "Change table text size")} />
        </div>
        <Hint>Tables with a style of their own keep it.</Hint>
      </Group>

      <LogoGroup editor={editor} edit={edit} />
    </div>
  );
}

function LogoGroup({ editor, edit }: { editor: EditorApi; edit: (operations: PatchOperation[], label: string) => void }) {
  const client = useWorkspaceClient();
  const doc = editor.document;
  const images = doc.assets.filter((asset) => asset.type === "image");
  const placed = placedLogo(doc);
  const [assetId, setAssetId] = useState(placed?.assetId ?? doc.theme.logoAssetIds?.[0] ?? images[0]?.id ?? "");
  const [corner, setCorner] = useState<LogoCorner>("bottomRight");
  const [height, setHeight] = useState(48);
  const [problem, setProblem] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);

  return (
    <Group title="Logo">
      {images.length ? (
        <Select
          label="Picture"
          value={assetId}
          options={images.map((asset) => ({ value: asset.id, label: (asset as { fileName?: string }).fileName ?? asset.id }))}
          onChange={setAssetId}
        />
      ) : (
        <Hint>Upload your logo to put it on every slide.</Hint>
      )}
      <div className="dk-grid2">
        <Select
          label="Corner"
          value={corner}
          options={[
            { value: "topLeft", label: "Top left" },
            { value: "topRight", label: "Top right" },
            { value: "bottomLeft", label: "Bottom left" },
            { value: "bottomRight", label: "Bottom right" },
          ]}
          onChange={(value) => setCorner(value as LogoCorner)}
        />
        <NumberField label="Height" ariaLabel="Logo height" unit="px" value={height} min={16} max={240} onCommit={setHeight} />
      </div>
      <div className="dk-styles__actions">
        <Button size="sm" variant="primary" disabled={!assetId} onClick={() => edit(placeLogoOperations(doc, assetId, corner, height), "Put the logo on every slide")} data-testid="theme-logo-place">
          {placed ? "Move logo" : "Put on every slide"}
        </Button>
        {placed ? (
          <Button size="sm" onClick={() => edit(removeLogoOperations(doc), "Remove the logo")}>
            Remove from {placed.count} slide{placed.count === 1 ? "" : "s"}
          </Button>
        ) : null}
        <Button size="sm" icon="upload" onClick={() => input.current?.click()}>
          Upload…
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        aria-label="Logo file"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          try {
            const asset = await uploadPicture(client, file);
            edit(manifestOperations(editor.document, asset), "Upload a logo");
            setAssetId(asset.id);
            setProblem(undefined);
          } catch (error) {
            setProblem(error instanceof Error ? error.message : "The logo could not be uploaded.");
          }
        }}
      />
      {problem ? (
        <p className="dk-field__hint dk-field__hint--error" role="alert">
          {problem}
        </p>
      ) : null}
      <Hint>The logo is a locked picture on each slide, so it exports everywhere; delete it from a slide that should not carry it.</Hint>
    </Group>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="dk-customise__group">
      <legend className="dk-label">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Three lines in the theme's own faces and sizes, scaled down, so a change is seen before a slide is looked at. */
function TypePreview({ typography }: { typography: Record<string, Typo> }) {
  const line = (token: string, text: string) => {
    const style = typography[token];
    if (!style) return null;
    return (
      <span
        className="dk-customise__sample"
        style={{
          fontFamily: String(style.fontFamily ?? "").startsWith("token:") ? undefined : style.fontFamily,
          fontSize: Math.max(10, Math.round((style.fontSize ?? 20) / 3)),
          lineHeight: style.lineHeight,
        }}
      >
        {text} <span className="dk-muted">{style.fontSize}px</span>
      </span>
    );
  };
  return (
    <div className="dk-customise__preview" aria-label="Type scale preview">
      {line("h1", "Heading")}
      {line("h3", "Subheading")}
      {line("body", "Body text reads like this")}
      {line("caption", "Caption")}
    </div>
  );
}

function nearestRatio(value: number | undefined): number {
  const target = value ?? 1.25;
  return SCALE_RATIOS.reduce((best, ratio) => (Math.abs(ratio.value - target) < Math.abs(best - target) ? ratio.value : best), SCALE_RATIOS[1].value as number);
}

function contrast(theme: Parameters<typeof resolveColor>[0], foreground: string, background: string): number | undefined {
  const from = parseColor(resolveColor(theme, foreground));
  const to = parseColor(resolveColor(theme, background));
  return from && to ? contrastRatio(from, to) : undefined;
}
