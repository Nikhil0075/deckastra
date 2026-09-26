"use client";

import { useMemo, useState } from "react";
import { THEME_PRESETS, type ThemePreset } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import { applyPatch } from "@deckastra/transactions";

import { applyThemeOperations, restyleReach } from "../lib/theme-apply";
import type { EditorApi } from "../lib/useEditor";
import { useAssetUrls } from "../lib/asset-urls";
import { useBrowserMeasurer } from "../lib/measurer";
import { FinalFrameSlide } from "./FinalFrameSlide";
import { Button, cx } from "../ui";
import { resolveColor } from "./inspector/controls";
import { paintPreview } from "./inspector/paint";

/**
 * The theme gallery (Design tab review, 2026-09-26): every preset as a small
 * picture of itself, and one Apply.
 *
 * A preset card is drawn from the preset's own data — its background, a card in
 * its style kit, its heading face and accent — so what the card shows is what
 * applying it produces, not a screenshot that could drift from it.
 */
export function ThemeGallery({ editor }: { editor: EditorApi }) {
  const [chosen, setChosen] = useState<string>(() => THEME_PRESETS.find((p) => p.name === editor.document.theme.name)?.key ?? "");
  const [restyle, setRestyle] = useState(true);
  const [message, setMessage] = useState<string | undefined>();
  const preset = THEME_PRESETS.find((candidate) => candidate.key === chosen);
  const reach = restyleReach(editor.document);

  const groups: ThemePreset["category"][] = ["Styles", "Classic"];

  return (
    <div className="dk-gallery" data-testid="theme-gallery">
      {groups.map((category) => (
        <div key={category}>
          <span className="dk-label">{category}</span>
          <div className="dk-gallery__grid" role="radiogroup" aria-label={`${category} themes`}>
            {THEME_PRESETS.filter((candidate) => candidate.category === category).map((candidate) => (
              <PresetCard
                key={candidate.key}
                preset={candidate}
                selected={candidate.key === chosen}
                onSelect={() => {
                  setChosen(candidate.key);
                  setMessage(undefined);
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {preset ? (
        <div className="dk-gallery__apply">
          <p className="dk-field__hint">{preset.summary}</p>
          {/* Only for a theme other than the one on the deck: previewing what is
              already on screen says nothing. */}
          {preset.theme.name !== editor.document.theme.name ? <ThemePreview editor={editor} preset={preset} restyle={restyle} /> : null}
          <label className="dk-export__option">
            <input type="checkbox" checked={restyle} onChange={(event) => setRestyle(event.target.checked)} data-testid="theme-restyle" />
            Also restyle cards and backgrounds
            {restyle ? ` (${reach.cards} card${reach.cards === 1 ? "" : "s"}, ${reach.slides} slide${reach.slides === 1 ? "" : "s"})` : ""}
          </label>
          <Button
            size="sm"
            variant="primary"
            data-testid="theme-apply-preset"
            onClick={() => {
              const operations = applyThemeOperations(editor.document, preset.theme, restyle ? { restyle: preset.kit } : {});
              editor.apply(operations, { label: `Apply the ${preset.name} theme` });
              setMessage(`Applied ${preset.name}. Undo puts the previous look back.`);
            }}
          >
            Apply {preset.name}
          </Button>
          {message ? (
            <p className="dk-field__hint" role="status">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The slide on screen, drawn in the chosen theme before anything is applied
 * (design review, 2026-09-27). A preset card shows a swatch of the theme; this
 * shows what it does to real text, which is where a font that wraps
 * differently or an accent that fades into a chart gets noticed.
 */
function ThemePreview({ editor, preset, restyle }: { editor: EditorApi; preset: ThemePreset; restyle: boolean }) {
  const measurer = useBrowserMeasurer();
  const document = editor.document;
  const slide = document.slides[editor.slideIndex];
  const resolveAssetUrl = useAssetUrls(document);
  const scene = useMemo(() => {
    if (!slide) return undefined;
    const candidate = applyPatch(document, applyThemeOperations(document, preset.theme, restyle ? { restyle: preset.kit } : {})).document;
    const only = candidate.slides.find((s) => s.id === slide.id);
    return only ? buildDocumentScene({ ...candidate, slides: [only] }, { measurer }).slides[0] : undefined;
  }, [document, slide, preset, restyle, measurer]);
  if (!scene) return null;
  return (
    <figure className="dk-gallery__preview" data-testid="theme-preview" aria-label={`This slide in ${preset.name}`}>
      <FinalFrameSlide scene={scene} width={264} resolveAssetUrl={resolveAssetUrl} />
    </figure>
  );
}

function PresetCard({ preset, selected, onSelect }: { preset: ThemePreset; selected: boolean; onSelect: () => void }) {
  const theme = preset.theme;
  const colors = theme.colors as Record<string, string>;
  const card = preset.kit.card;
  const shadow = (card.shadow ?? [])
    .map((s) => `${s.type === "inner" ? "inset " : ""}${s.offsetX / 4}px ${s.offsetY / 4}px ${s.blur / 4}px ${(s.spread ?? 0) / 4}px ${resolveColor(theme, s.color as string) ?? s.color}`)
    .join(", ");
  const blur = card.backdropFilters?.find((filter) => filter.type === "blur") as { radius: number } | undefined;
  const heading = (theme.typography as unknown as { h1: { fontFamily: string } }).h1.fontFamily;
  const stroke = card.stroke?.paint.type === "solid" ? resolveColor(theme, card.stroke.paint.color as string) : undefined;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cx("dk-preset", selected && "dk-preset--selected")}
      onClick={onSelect}
      data-testid={`preset-${preset.key}`}
    >
      <span
        className="dk-preset__canvas"
        aria-hidden="true"
        style={{ background: paintPreview(theme, preset.kit.background?.paint) ?? colors.background }}
      >
        <span className="dk-preset__title" style={{ color: colors.foreground, fontFamily: heading }}>
          Aa
        </span>
        <span
          className="dk-preset__card"
          style={{
            background: paintPreview(theme, card.fill),
            border: stroke && card.stroke ? `${Math.max(1, card.stroke.width / 2)}px solid ${stroke}` : undefined,
            borderRadius: typeof card.cornerRadius === "number" ? card.cornerRadius / 3 : undefined,
            boxShadow: shadow || undefined,
            backdropFilter: blur ? `blur(${blur.radius / 3}px)` : undefined,
          }}
        >
          <span className="dk-preset__bar" style={{ background: colors.accent }} />
          <span className="dk-preset__bar dk-preset__bar--short" style={{ background: colors.secondary }} />
        </span>
      </span>
      <span className="dk-preset__name">{preset.name}</span>
    </button>
  );
}
