import { useEffect, useId, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import { Button, IconButton, Popover, TextField, cx } from "../../ui";
import { useColorStudio } from "../../lib/color-studio";
import {
  HEX_COLOR,
  THEME_COLOR_ROLES,
  addNamedColorOperations,
  deckColors,
  namedColorOf,
  namedColorProblem,
  namedColorToken,
  normaliseColor,
  promoteColorOperations,
  themeColorToken,
} from "../../lib/colors";

/**
 * Controls the inspector's element sections share (manual-authoring review
 * MA-14 to MA-19).
 */

// ------------------------------------------------------------------- colour

const CUSTOM = "custom";
const NONE = "none";
const HEX = HEX_COLOR;

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

/** What a value is called in a picker: a role's label, a named colour's name, or the hex. */
export function colorName(theme: PresentationDocument["theme"], value: string | undefined): string {
  if (!value) return "None";
  const named = namedColorOf(value);
  if (named !== undefined) return named;
  if (value.startsWith("token:colors.")) {
    const role = value.slice("token:colors.".length);
    const series = /^chartSeries\.(\d+)$/.exec(role);
    if (series) return `Theme series ${Number(series[1]) + 1}`;
    return THEME_COLOR_ROLES.find((option) => option.token === role)?.label ?? role;
  }
  return value.startsWith("token:") ? value.slice("token:".length) : value.toUpperCase();
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

interface EyeDropperResult {
  sRGBHex: string;
}

/**
 * A colour, chosen from the deck's own palette first (colour wizard, 2026-09-26).
 *
 * The picker shows, in order: the theme's colours, the deck's named colours, and
 * the loose colours already on its slides — because the colour someone wants is
 * almost always one the deck already uses, and picking it by eye from a hex
 * field is how a deck ends up with eleven slightly different blues. Tokens and
 * names come first because they re-theme; a literal is still a click away
 * ("Custom colour…", the system picker, or the eyedropper), and one that is
 * worth keeping can be named on the spot, which turns every use of it into a
 * reference in one undo step.
 *
 * A hex value is committed once, when it is complete and valid, never per
 * keystroke: "#1e4" on the way to "#1e4bd2" is not a colour anyone chose.
 */
export function ColorField({ label, value, theme, onChange, allowNone, disabled, "data-testid": testId }: ColorFieldProps) {
  const studio = useColorStudio();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(() => (value && !value.startsWith("token:") ? value : ""));
  const [error, setError] = useState<string | undefined>();
  const [naming, setNaming] = useState<string | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  const hexRef = useRef<HTMLInputElement>(null);
  const hexId = useId();

  useEffect(() => {
    if (value && !value.startsWith("token:")) setHex(value);
  }, [value]);

  const colors = theme.colors as Record<string, unknown>;
  const roles = THEME_COLOR_ROLES.filter(({ token }) => typeof colors[token] === "string");
  const named = Object.entries((colors.custom as Record<string, string> | undefined) ?? {});
  const inDeck = studio ? deckColors(studio.document).filter((color) => normaliseColor(color.value) !== normaliseColor(value ?? "")).slice(0, 12) : [];
  const literal = value !== undefined && !value.startsWith("token:");

  const choose = (next: string | undefined) => {
    setOpen(false);
    setError(undefined);
    if (next !== value) onChange(next);
  };

  const commitHex = (candidate = hex) => {
    const trimmed = candidate.trim();
    if (!HEX.test(trimmed)) {
      setError("Use a hex colour such as #1E4BD2.");
      return;
    }
    setError(undefined);
    if (trimmed !== value) onChange(trimmed);
  };

  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pick = async () => {
    try {
      const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<EyeDropperResult> } }).EyeDropper;
      const result = await new Dropper().open();
      setHex(result.sRGBHex.toUpperCase());
      commitHex(result.sRGBHex.toUpperCase());
    } catch {
      // Escape while picking is a person changing their mind, not an error.
    }
  };

  /**
   * Name the current literal. Where the value is on the slides, every use of it
   * becomes the name in one patch (so this field follows); otherwise the name is
   * made and this field is pointed at it.
   */
  const saveNamed = () => {
    if (!studio || !literal || naming === undefined) return;
    const problem = namedColorProblem(studio.document, naming);
    if (problem) {
      setNameError(problem);
      return;
    }
    const promoted = promoteColorOperations(studio.document, value!, naming);
    const usedOnSlides = promoted.length > 1;
    if (usedOnSlides) {
      studio.apply(promoted, `Name colour "${naming.trim()}"`);
    } else {
      const made = addNamedColorOperations(studio.document, naming, normaliseColor(value!));
      studio.apply(made.operations, `Name colour "${naming.trim()}"`);
      onChange(made.token);
    }
    setNaming(undefined);
    setNameError(undefined);
  };

  const swatch = resolveColor(theme, value);
  const current = value === undefined ? (allowNone ? "None" : "Default") : colorName(theme, value);

  const option = (key: string, name: string, color: string | undefined, next: string | undefined, meta?: string) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={next === value}
      aria-label={name}
      title={meta ? `${name} · ${meta}` : name}
      className={cx("dk-swatch", next === value && "dk-swatch--selected", !color && "dk-swatch--none")}
      style={color ? { background: color } : undefined}
      onClick={() => choose(next)}
    />
  );

  return (
    <div className="dk-field dk-colorfield" data-testid={testId}>
      <span className="dk-label">{label}</span>
      <Popover
        label={`${label} choices`}
        open={open}
        onOpenChange={setOpen}
        className="dk-colorpicker"
        trigger={(props) => (
          <button
            type="button"
            className="dk-input dk-colorfield__trigger"
            aria-label={`${label}: ${current}`}
            disabled={disabled}
            {...props}
          >
            <span
              className={cx("dk-colorfield__swatch", !swatch && "dk-colorfield__swatch--none")}
              aria-hidden="true"
              style={swatch ? { background: swatch } : undefined}
            />
            <span className="dk-colorfield__name">{current}</span>
          </button>
        )}
      >
        <div role="listbox" aria-label={label} className="dk-colorpicker__body">
          <div className="dk-colorpicker__group">
            <span className="dk-colorpicker__heading">Theme</span>
            <div className="dk-swatches">
              {allowNone || value === undefined
                ? option(allowNone ? NONE : "default", allowNone ? "None" : "Default", undefined, undefined)
                : null}
              {roles.map(({ token, label: name }) =>
                option(token, name, resolveColor(theme, colors[token] as string), themeColorToken(token)),
              )}
            </div>
          </div>
          {named.length ? (
            <div className="dk-colorpicker__group">
              <span className="dk-colorpicker__heading">Named colours</span>
              <div className="dk-swatches">
                {named.map(([name, color]) => option(`named-${name}`, name, resolveColor(theme, color), namedColorToken(name)))}
              </div>
            </div>
          ) : null}
          {inDeck.length ? (
            <div className="dk-colorpicker__group">
              <span className="dk-colorpicker__heading">In this deck</span>
              <div className="dk-swatches">
                {inDeck.map((color) => option(`deck-${color.value}`, color.value, color.value, color.value, `used ${color.count}×`))}
              </div>
            </div>
          ) : null}
          <button
            type="button"
            role="option"
            aria-selected={false}
            className="dk-colorpicker__custom"
            onClick={() => {
              setHex(literal ? value! : swatch && HEX.test(swatch) ? swatch : "");
              requestAnimationFrame(() => hexRef.current?.focus());
            }}
          >
            Custom colour…
          </button>
        </div>

        <div className="dk-colorpicker__hex">
          <input
            type="color"
            className="dk-colorpicker__native"
            aria-label={`${label} colour picker`}
            value={HEX.test(hex) && hex.length === 7 ? hex : swatch && /^#[0-9a-f]{6}$/i.test(swatch) ? swatch : "#000000"}
            disabled={disabled}
            onChange={(event) => {
              setHex(event.target.value.toUpperCase());
              commitHex(event.target.value.toUpperCase());
            }}
          />
          <label className="dk-visually-hidden" htmlFor={hexId}>
            {label} hex value
          </label>
          <input
            id={hexId}
            ref={hexRef}
            className={cx("dk-input", error && "dk-input--invalid")}
            value={hex}
            placeholder="#1E4BD2"
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setHex(event.target.value)}
            onBlur={() => hex.trim() && commitHex()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitHex();
              }
            }}
          />
          {eyedropper ? (
            <IconButton icon="eyedropper" label="Pick a colour from the screen" size="sm" onClick={() => void pick()} />
          ) : null}
        </div>
        {error ? <span className="dk-field__hint dk-field__hint--error">{error}</span> : null}

        {studio && literal ? (
          naming === undefined ? (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setNaming("")} data-testid="color-save-named">
              Save {value!.toUpperCase()} as a named colour
            </Button>
          ) : (
            <div className="dk-colorpicker__name">
              <TextField
                label="Colour name"
                value={naming}
                placeholder="Brand blue"
                error={nameError}
                autoFocus
                onChange={(next) => {
                  setNaming(next);
                  setNameError(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    saveNamed();
                  }
                }}
              />
              <Button size="sm" variant="primary" onClick={saveNamed} data-testid="color-save-named-confirm">
                Save
              </Button>
            </div>
          )
        ) : null}
        {studio ? (
          <Button
            size="sm"
            variant="ghost"
            icon="theme"
            data-testid="open-colors"
            onClick={() => {
              setOpen(false);
              studio.open(namedColorOf(value) ?? (value?.startsWith("token:colors.") ? value.slice("token:colors.".length) : undefined));
            }}
          >
            Edit colours…
          </Button>
        ) : null}
      </Popover>
      {!open && error ? <span className="dk-field__hint dk-field__hint--error">{error}</span> : null}
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
