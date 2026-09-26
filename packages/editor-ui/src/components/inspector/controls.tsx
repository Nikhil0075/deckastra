import { useEffect, useId, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { Select, cx } from "../../ui";

/**
 * Controls the inspector's element sections share (manual-authoring review
 * MA-14 to MA-19).
 */

// ------------------------------------------------------------------- colour

const COLOR_TOKENS: { token: string; label: string }[] = [
  { token: "foreground", label: "Text" },
  { token: "foregroundMuted", label: "Muted text" },
  { token: "accent", label: "Accent" },
  { token: "accentForeground", label: "On accent" },
  { token: "secondary", label: "Secondary" },
  { token: "background", label: "Background" },
  { token: "surface", label: "Surface" },
  { token: "surfaceAlt", label: "Surface (alt)" },
  { token: "border", label: "Border" },
  { token: "success", label: "Success" },
  { token: "warning", label: "Warning" },
  { token: "danger", label: "Danger" },
  { token: "info", label: "Info" },
];

const CUSTOM = "custom";
const NONE = "none";
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A theme colour token or literal, resolved to something CSS can draw, for the swatch. */
export function resolveColor(theme: PresentationDocument["theme"], value: string | undefined, depth = 0): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("token:")) return value;
  if (depth > 4) return undefined;
  const path = value.slice("token:".length).split(".");
  let cursor: unknown = theme;
  for (const key of path) cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
  return typeof cursor === "string" ? resolveColor(theme, cursor, depth + 1) : undefined;
}

export interface ColorFieldProps {
  label: string;
  value: string | undefined;
  theme: PresentationDocument["theme"];
  /** `undefined` means "none" when `allowNone`, and "remove the override" otherwise. */
  onChange: (value: string | undefined) => void;
  allowNone?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
}

/**
 * A colour, chosen from the theme first.
 *
 * Tokens come first because a deck built from tokens re-themes cleanly and one
 * built from hex values does not (doc 02 §0.4). A literal is still allowed —
 * "Custom" with a hex field — because a brand colour the theme lacks is a real
 * need; the validator's W203 is where a near-miss literal gets flagged, not
 * here. A hex value is committed once, when it is complete and valid, never per
 * keystroke: "#1e4" on the way to "#1e4bd2" is not a colour anyone chose.
 */
export function ColorField({ label, value, theme, onChange, allowNone, disabled, "data-testid": testId }: ColorFieldProps) {
  const isToken = value?.startsWith("token:colors.");
  const tokenName = isToken ? value!.slice("token:colors.".length) : undefined;
  const available = COLOR_TOKENS.filter(({ token }) => (theme.colors as Record<string, unknown>)[token] !== undefined);
  const known = tokenName && available.some((option) => option.token === tokenName);
  const selected = value === undefined ? (allowNone ? NONE : "") : isToken ? value! : CUSTOM;

  const options = [
    ...(allowNone ? [{ value: NONE, label: "None" }] : value === undefined ? [{ value: "", label: "Default" }] : []),
    ...available.map(({ token, label: name }) => ({ value: `token:colors.${token}`, label: `${name}` })),
    ...(isToken && !known ? [{ value: value!, label: tokenName! }] : []),
    { value: CUSTOM, label: "Custom colour…" },
  ];

  const [hex, setHex] = useState(() => (value && !isToken ? value : ""));
  const [custom, setCustom] = useState(selected === CUSTOM);
  useEffect(() => {
    if (value && !value.startsWith("token:")) setHex(value);
    setCustom(value !== undefined && !value.startsWith("token:"));
  }, [value]);
  const [error, setError] = useState<string | undefined>();
  const hexId = useId();

  const commitHex = () => {
    const trimmed = hex.trim();
    if (!HEX.test(trimmed)) {
      setError("Use a hex colour such as #1E4BD2.");
      return;
    }
    setError(undefined);
    if (trimmed !== value) onChange(trimmed);
  };

  const swatch = resolveColor(theme, value);
  return (
    <div className="dk-field dk-colorfield" data-testid={testId}>
      <div className="dk-colorfield__row">
        <span
          className={cx("dk-colorfield__swatch", !swatch && "dk-colorfield__swatch--none")}
          aria-hidden="true"
          style={swatch ? { background: swatch } : undefined}
        />
        <Select
          label={label}
          value={custom ? CUSTOM : selected}
          options={options}
          disabled={disabled}
          onChange={(choice) => {
            if (choice === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(choice === NONE || choice === "" ? undefined : choice);
          }}
        />
      </div>
      {custom ? (
        <>
          <label className="dk-visually-hidden" htmlFor={hexId}>
            {label} hex value
          </label>
          <input
            id={hexId}
            className={cx("dk-input", error && "dk-input--invalid")}
            value={hex}
            placeholder="#1E4BD2"
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setHex(event.target.value)}
            onBlur={commitHex}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitHex();
              }
            }}
          />
          {error ? <span className="dk-field__hint dk-field__hint--error">{error}</span> : null}
        </>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------- cells

export interface CellInputProps {
  value: string;
  /** Return a message to refuse the text; the cell keeps it and says why. */
  onCommit: (text: string) => string | void;
  label: string;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  align?: "left" | "right";
  header?: boolean;
  "data-testid"?: string;
}

/**
 * One grid cell. It edits a draft and commits on Enter or blur — one edit, one
 * undo step, like every other inspector field — and Escape abandons the draft.
 * An outside change (undo, the canvas) replaces the draft unless the cell is
 * being typed in.
 */
export function CellInput({ value, onCommit, label, onPaste, disabled, align, header, "data-testid": testId }: CellInputProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | undefined>();
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setDraft(value);
      setError(undefined);
    }
  }, [value]);

  const commit = () => {
    editing.current = false;
    if (draft === value) {
      setError(undefined);
      return;
    }
    const refusal = onCommit(draft);
    setError(refusal || undefined);
  };

  return (
    <input
      className={cx("dk-cell", header && "dk-cell--header", error && "dk-input--invalid")}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      title={error}
      value={draft}
      disabled={disabled}
      data-testid={testId}
      style={align === "right" ? { textAlign: "right" } : undefined}
      onChange={(event) => {
        editing.current = true;
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onPaste={onPaste}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          editing.current = false;
          setDraft(value);
          setError(undefined);
        }
      }}
    />
  );
}

/** A short explanation under a group of controls. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="dk-field__hint">{children}</p>;
}
