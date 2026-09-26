import type { Paint, PresentationDocument, ShadowStyle } from "@deckastra/presentation-schema";

import { Button, IconButton, NumberField, Section, Segmented, Select } from "../../ui";
import { ColorField, Hint, resolveColor } from "./controls";

/**
 * Fills and effects (Design tab review, 2026-09-26).
 *
 * A fill was a colour and nothing else, so none of the looks people ask for by
 * name could be made by hand: a gradient card, a frosted-glass panel, a soft
 * neumorphic tile, a hard brutalist shadow. Everything here writes the schema's
 * own shapes (`Paint`, `ShadowStyle`, `backdropFilters`), which the renderer
 * draws, the PDF prints and PowerPoint approximates with a line in the report.
 */

type Theme = PresentationDocument["theme"];
type GradientPaint = Extract<Paint, { type: "linearGradient" } | { type: "radialGradient" }>;

const MAX_STOPS = 4;

/** What a paint looks like as CSS, for a swatch. Tokens resolve through the theme. */
export function paintPreview(theme: Theme, paint: Paint | undefined): string | undefined {
  if (!paint || paint.type === "none") return undefined;
  if (paint.type === "solid") return resolveColor(theme, paint.color as string);
  if (paint.type === "linearGradient" || paint.type === "radialGradient") {
    const stops = paint.stops
      .map((stop) => `${resolveColor(theme, stop.color as string) ?? "transparent"} ${Math.round(stop.offset * 100)}%`)
      .join(", ");
    return paint.type === "linearGradient"
      ? `linear-gradient(${paint.angle ?? 180}deg, ${stops})`
      : `radial-gradient(circle, ${stops})`;
  }
  return undefined;
}

export interface PaintFieldProps {
  label: string;
  value: Paint | undefined;
  theme: Theme;
  onChange: (paint: Paint | undefined) => void;
  /** Offer "None" (a transparent shape). Otherwise the empty state is "Default". */
  allowNone?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
}

/**
 * A solid colour or a gradient.
 *
 * Switching from a colour to a gradient keeps the colour as the first stop and
 * runs it into the theme's accent, so the first gradient anyone makes already
 * belongs to the deck. Each change is one edit and one undo step.
 */
export function PaintField({ label, value, theme, onChange, allowNone, disabled, "data-testid": testId }: PaintFieldProps) {
  const kind =
    value === undefined || value.type === "none"
      ? "none"
      : value.type === "solid"
        ? "solid"
        : value.type === "linearGradient" || value.type === "radialGradient"
          ? "gradient"
          : "other";

  const firstColor = value?.type === "solid" ? (value.color as string) : gradientOf(value)?.stops[0]?.color as string | undefined;

  const toGradient = (): GradientPaint => ({
    type: "linearGradient",
    angle: 135,
    stops: [
      { offset: 0, color: firstColor ?? "token:colors.accent" },
      { offset: 1, color: firstColor === "token:colors.secondary" ? "token:colors.accent" : "token:colors.secondary" },
    ],
  });

  const gradient = gradientOf(value);

  return (
    <div className="dk-field dk-paintfield" data-testid={testId}>
      <span className="dk-label">{label}</span>
      {kind === "other" ? <Hint>This fill is a picture. Choosing a colour or gradient replaces it; Undo brings it back.</Hint> : null}
      <Segmented
        label={`${label} type`}
        size="sm"
        value={kind === "other" ? "none" : kind}
        onChange={(next) => {
          if (next === kind) return;
          if (next === "none") onChange(allowNone ? { type: "none" } : undefined);
          else if (next === "solid") onChange({ type: "solid", color: firstColor ?? "token:colors.accent" });
          else onChange(toGradient());
        }}
        items={[
          { value: "none", label: allowNone ? "None" : "Default", disabled },
          { value: "solid", label: "Colour", disabled },
          { value: "gradient", label: "Gradient", disabled },
        ]}
      />
      {kind === "solid" && value?.type === "solid" ? (
        <ColorField
          label={`${label} colour`}
          value={value.color as string}
          theme={theme}
          disabled={disabled}
          onChange={(color) => onChange(color ? { type: "solid", color } : allowNone ? { type: "none" } : undefined)}
        />
      ) : null}
      {gradient ? <GradientEditor label={label} gradient={gradient} theme={theme} disabled={disabled} onChange={onChange} /> : null}
    </div>
  );
}

function gradientOf(paint: Paint | undefined): GradientPaint | undefined {
  return paint && (paint.type === "linearGradient" || paint.type === "radialGradient") ? paint : undefined;
}

function GradientEditor({
  label,
  gradient,
  theme,
  disabled,
  onChange,
}: {
  label: string;
  gradient: GradientPaint;
  theme: Theme;
  disabled?: boolean;
  onChange: (paint: Paint) => void;
}) {
  const stops = gradient.stops;
  const setStops = (next: GradientPaint["stops"]) => onChange({ ...gradient, stops: next } as GradientPaint);

  return (
    <div className="dk-gradient">
      <span
        className="dk-gradient__preview"
        aria-hidden="true"
        style={{ background: paintPreview(theme, gradient) }}
      />
      <Segmented
        label={`${label} gradient shape`}
        size="sm"
        value={gradient.type}
        onChange={(type) => {
          if (type === gradient.type) return;
          onChange(
            type === "linearGradient"
              ? { type: "linearGradient", angle: 135, stops }
              : { type: "radialGradient", stops },
          );
        }}
        items={[
          { value: "linearGradient", label: "Linear", disabled },
          { value: "radialGradient", label: "Radial", disabled },
        ]}
      />
      {gradient.type === "linearGradient" ? (
        <NumberField
          label="Angle"
          ariaLabel={`${label} gradient angle`}
          value={gradient.angle}
          min={0}
          max={360}
          step={15}
          unit="°"
          disabled={disabled}
          onCommit={(angle) => onChange({ ...gradient, angle })}
        />
      ) : null}
      {stops.map((stop, index) => (
        <div key={index} className="dk-gradient__stop">
          <ColorField
            label={`Stop ${index + 1}`}
            value={stop.color as string}
            theme={theme}
            disabled={disabled}
            onChange={(color) => {
              if (!color) return;
              setStops(stops.map((other, at) => (at === index ? { ...other, color } : other)));
            }}
          />
          <NumberField
            label="At"
            ariaLabel={`Stop ${index + 1} position`}
            value={Math.round(stop.offset * 100)}
            min={0}
            max={100}
            unit="%"
            disabled={disabled}
            onCommit={(percent) =>
              setStops(
                stops
                  .map((other, at) => (at === index ? { ...other, offset: percent / 100 } : other))
                  // Kept in order: a stop dragged past its neighbour is a
                  // gradient that runs backwards between them otherwise.
                  .sort((a, b) => a.offset - b.offset),
              )
            }
          />
          {stops.length > 2 ? (
            <IconButton
              icon="trash"
              label={`Remove stop ${index + 1}`}
              size="sm"
              disabled={disabled}
              onClick={() => setStops(stops.filter((_, at) => at !== index))}
            />
          ) : null}
        </div>
      ))}
      {stops.length < MAX_STOPS ? (
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={disabled}
          onClick={() => {
            // Between the two stops furthest apart, where a new colour has room.
            let at = 0;
            for (let index = 1; index < stops.length - 1; index += 1) {
              if (stops[index + 1]!.offset - stops[index]!.offset > stops[at + 1]!.offset - stops[at]!.offset) at = index;
            }
            const offset = (stops[at]!.offset + stops[at + 1]!.offset) / 2;
            setStops([...stops.slice(0, at + 1), { offset, color: stops[at]!.color }, ...stops.slice(at + 1)]);
          }}
        >
          Add stop
        </Button>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- effects

/** Named shadow looks. Each is the schema's own list, so a preset is data, not code. */
export const SHADOW_PRESETS: Record<string, { label: string; shadows: ShadowStyle[] }> = {
  none: { label: "None", shadows: [] },
  soft: { label: "Soft", shadows: [{ type: "drop", offsetX: 0, offsetY: 8, blur: 24, spread: 0, color: "#0000001F" }] },
  lifted: {
    label: "Lifted",
    shadows: [
      { type: "drop", offsetX: 0, offsetY: 18, blur: 40, spread: -8, color: "#00000038" },
      { type: "drop", offsetX: 0, offsetY: 4, blur: 10, spread: 0, color: "#0000001A" },
    ],
  },
  hard: { label: "Hard (brutalist)", shadows: [{ type: "drop", offsetX: 8, offsetY: 8, blur: 0, spread: 0, color: "#000000" }] },
  neumorphic: {
    label: "Neumorphic",
    shadows: [
      { type: "drop", offsetX: 10, offsetY: 10, blur: 22, spread: 0, color: "#00000029" },
      { type: "drop", offsetX: -10, offsetY: -10, blur: 22, spread: 0, color: "#FFFFFFB3" },
    ],
  },
  inset: { label: "Pressed in", shadows: [{ type: "inner", offsetX: 0, offsetY: 3, blur: 10, spread: 0, color: "#00000040" }] },
  glow: { label: "Glow", shadows: [{ type: "drop", offsetX: 0, offsetY: 0, blur: 32, spread: 2, color: "token:colors.accent" }] },
};

export function shadowPresetOf(shadows: readonly ShadowStyle[] | undefined): string {
  const list = shadows ?? [];
  for (const [name, preset] of Object.entries(SHADOW_PRESETS)) {
    if (JSON.stringify(preset.shadows) === JSON.stringify(list)) return name;
  }
  return "custom";
}

export interface EffectsSectionProps {
  shadows: ShadowStyle[] | undefined;
  blur: number | undefined;
  /** Glass blurs what is behind the element; only boxes that can be translucent get it. */
  canBlur: boolean;
  theme: Theme;
  disabled?: boolean;
  onShadows: (value: ShadowStyle[] | undefined) => void;
  onBlur: (radius: number | undefined) => void;
}

/**
 * Shadow and background blur for one element. (Opacity is in Appearance.)
 *
 * The presets are where the named looks come from; a shadow that matches none
 * of them (an agent wrote it, or a theme did) is shown as Custom with its first
 * shadow editable, rather than being overwritten by opening the panel.
 */
export function EffectsSection({
  shadows,
  blur,
  canBlur,
  theme,
  disabled,
  onShadows,
  onBlur,
}: EffectsSectionProps) {
  const preset = shadowPresetOf(shadows);
  const first = shadows?.[0];
  const summary = [preset !== "none" ? SHADOW_PRESETS[preset]?.label ?? "Custom shadow" : "", blur ? "glass" : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <Section title="Effects" meta={summary || undefined} defaultOpen={Boolean(summary)}>
      <Select
        label="Shadow"
        value={preset}
        disabled={disabled}
        data-testid="shadow-preset"
        options={[
          ...Object.entries(SHADOW_PRESETS).map(([name, entry]) => ({ value: name, label: entry.label })),
          ...(preset === "custom" ? [{ value: "custom", label: "Custom" }] : []),
        ]}
        onChange={(name) => {
          if (name === "custom") return;
          const chosen = SHADOW_PRESETS[name]!.shadows;
          onShadows(chosen.length ? structuredClone(chosen) : undefined);
        }}
      />
      {first ? (
        <div className="dk-grid2">
          <NumberField
            label="X"
            ariaLabel="Shadow horizontal offset"
            value={first.offsetX}
            min={-200}
            max={200}
            disabled={disabled}
            onCommit={(offsetX) => onShadows([{ ...first, offsetX }, ...(shadows ?? []).slice(1)])}
          />
          <NumberField
            label="Y"
            ariaLabel="Shadow vertical offset"
            value={first.offsetY}
            min={-200}
            max={200}
            disabled={disabled}
            onCommit={(offsetY) => onShadows([{ ...first, offsetY }, ...(shadows ?? []).slice(1)])}
          />
          <NumberField
            label="Blur"
            ariaLabel="Shadow blur"
            value={first.blur}
            min={0}
            max={200}
            disabled={disabled}
            onCommit={(value) => onShadows([{ ...first, blur: value }, ...(shadows ?? []).slice(1)])}
          />
          <ColorField
            label="Shadow colour"
            value={first.color as string}
            theme={theme}
            disabled={disabled}
            onChange={(color) => color && onShadows([{ ...first, color }, ...(shadows ?? []).slice(1)])}
          />
        </div>
      ) : null}
      {canBlur ? (
        <>
          <NumberField
            label="Background blur"
            ariaLabel="Background blur"
            value={blur ?? 0}
            min={0}
            max={80}
            step={2}
            unit="px"
            disabled={disabled}
            data-testid="backdrop-blur"
            onCommit={(radius) => onBlur(radius > 0 ? radius : undefined)}
          />
          <Hint>Frosted glass: blurs whatever is behind the object. Give it a see-through fill (a colour with transparency, or lower the opacity of a gradient stop) to see it.</Hint>
        </>
      ) : null}
    </Section>
  );
}
