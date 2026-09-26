import { useMemo, useState } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";
import { BUNDLED_FONTS, SYSTEM_FONTS, bundledFont, type FontGroup } from "@deckastra/renderer";

import { Button, Popover, cx } from "../../ui";

/**
 * Choosing a font (Design tab review, 2026-09-26).
 *
 * A dropdown of eleven names, most of them fonts the viewer's machine may not
 * have, is how a deck ends up in Arial on the projector. This lists the theme's
 * own faces first (they re-theme with the deck), then the families the product
 * ships — each drawn in itself, so choosing is looking — then fonts uploaded
 * to this deck, and last the common system families, marked as depending on
 * the machine that shows them.
 */

export interface FontPickerProps {
  label: string;
  value: string;
  document: PresentationDocument;
  onChange: (family: string) => void;
  /** Offer "Upload a font…" and hand the file over. */
  onUpload?: (file: File) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

const THEME_ROLES: { token: string; label: string }[] = [
  { token: "h1", label: "Theme heading" },
  { token: "body", label: "Theme body" },
  { token: "code", label: "Theme code" },
];

const GROUPS: FontGroup[] = ["Sans", "Serif", "Display", "Mono", "Handwriting"];

/** The face a family draws in here: the bundled one when there is one. */
export function previewFamily(family: string): string {
  const bundled = bundledFont(family);
  return bundled ? `"${bundled.face}", "${bundled.family}"` : `"${family}"`;
}

export function FontPicker({ label, value, document, onChange, onUpload, disabled, "data-testid": testId }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const typography = document.theme.typography as unknown as Record<string, { fontFamily?: string } | undefined>;
  const themeFamily = (token: string) => typography[token]?.fontFamily ?? "";
  const uploaded = useMemo(
    () =>
      document.assets
        .filter((asset) => asset.type === "font")
        .map((asset) => (asset as { fontFamily?: string }).fontFamily)
        .filter((family): family is string => Boolean(family))
        .filter((family, index, all) => all.indexOf(family) === index),
    [document.assets],
  );

  const current = value.startsWith("token:typography.")
    ? `${THEME_ROLES.find((role) => value === `token:typography.${role.token}.fontFamily`)?.label ?? "Theme"} (${themeFamily(value.split(".")[1] ?? "")})`
    : value;

  const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const choose = (family: string) => {
    onChange(family);
    setOpen(false);
    setQuery("");
  };

  const option = (family: string, display: string, key = family, preview = family) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={family === value}
      className={cx("dk-fontpicker__option", family === value && "dk-fontpicker__option--selected")}
      style={{ fontFamily: previewFamily(preview) }}
      onClick={() => choose(family)}
    >
      {display}
    </button>
  );

  return (
    <div className="dk-field">
      <span className="dk-label">{label}</span>
      <Popover
        label={`${label} choices`}
        open={open}
        onOpenChange={setOpen}
        className="dk-fontpicker"
        trigger={(props) => (
          <button
            type="button"
            className="dk-input dk-fontpicker__trigger"
            disabled={disabled}
            data-testid={testId}
            aria-label={`${label}: ${current}`}
            style={{ fontFamily: previewFamily(value.startsWith("token:") ? themeFamily(value.split(".")[1] ?? "") : value) }}
            {...props}
          >
            {current}
          </button>
        )}
      >
        <input
          className="dk-input"
          type="search"
          placeholder="Search fonts"
          aria-label="Search fonts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="dk-fontpicker__list" role="listbox" aria-label={label}>
          <span className="dk-fontpicker__group">Theme</span>
          {THEME_ROLES.filter((role) => themeFamily(role.token) && match(`${role.label} ${themeFamily(role.token)}`)).map((role) =>
            option(`token:typography.${role.token}.fontFamily`, `${role.label} · ${themeFamily(role.token)}`, role.token, themeFamily(role.token)),
          )}
          {GROUPS.map((group) => {
            const fonts = BUNDLED_FONTS.filter((font) => font.group === group && match(font.family));
            if (fonts.length === 0) return null;
            return [
              <span key={`group-${group}`} className="dk-fontpicker__group">
                {group}
              </span>,
              ...fonts.map((font) => option(font.family, font.family)),
            ];
          })}
          {uploaded.filter(match).length ? <span className="dk-fontpicker__group">Uploaded to this deck</span> : null}
          {uploaded.filter(match).map((family) => option(family, family, `upload-${family}`))}
          {SYSTEM_FONTS.filter(match).length ? <span className="dk-fontpicker__group">On this computer</span> : null}
          {SYSTEM_FONTS.filter(match).map((family) => option(family, family, `system-${family}`))}
        </div>
        {onUpload ? (
          <UploadFont
            onFile={(file) => {
              setOpen(false);
              onUpload(file);
            }}
          />
        ) : null}
      </Popover>
    </div>
  );
}

function UploadFont({ onFile }: { onFile: (file: File) => void }) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  return (
    <>
      <Button size="sm" variant="ghost" icon="upload" onClick={() => input?.click()} data-testid="font-upload">
        Upload a font (.ttf, .otf, .woff2)…
      </Button>
      <input
        ref={setInput}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
        hidden
        data-testid="font-upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}
