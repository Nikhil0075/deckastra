import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PresentationDocument } from "@deckastra/presentation-schema";

import type { EditorApi } from "../lib/useEditor";
import {
  HEX_COLOR,
  THEME_COLOR_ROLES,
  addNamedColorOperations,
  contrastBetween,
  contrastVerdict,
  deckColors,
  deleteNamedColorOperations,
  namedColorProblem,
  namedColors,
  normaliseColor,
  promoteColorOperations,
  renameNamedColorOperations,
  replaceColorOperations,
  resolveColorValue,
  setChartSeriesOperations,
  setNamedColorOperations,
  setThemeColorOperations,
  themeColorToken,
  tokenUseCount,
  type ThemeColorGroup,
} from "../lib/colors";
import {
  addModeOperations,
  aliasOf,
  colorModes,
  generateOppositeMode,
  modeColor,
  modeNameProblem,
  removeModeOperations,
  setModeColorOperations,
  standardRolesOperations,
  STANDARD_ROLES,
  wouldLoop,
} from "../lib/color-modes";
import { Button, Icon, IconButton, Segmented, Select, StatusChip, Tabs, TextField, cx } from "../ui";
import { ColorField } from "./inspector/controls";
import { ColorRamp } from "./inspector/ColorRamp";

/**
 * The Colours view (colour wizard, 2026-09-26; docked in the design review of
 * the same day).
 *
 * It takes the right-hand panel's place rather than floating over the editor:
 * the slide stays in view, nothing is covered, and the back arrow returns to the
 * Design panel exactly as it was. Each tab has the same shape — the colour being
 * edited at the top, with a square to pick it by eye, a hue strip, a ramp of
 * lighter and darker versions, the hex for whoever has a brand guide open, and
 * its contrast; below it, the colours to choose from.
 *
 * - **Theme**: the roles. Changing one changes everything that uses it.
 * - **Named**: the person's own colours, which elements refer to by name.
 *   Rename and delete rewrite every reference in the same patch.
 * - **In deck**: loose colours on the slides, with "Name it" and "replace
 *   everywhere".
 * - **Charts**: the series palette every chart without its own draws from.
 *
 * Every change is one patch through the editor, so one Undo reverses it; a drag
 * in the picker commits once, when it is let go of.
 */

type Tab = "theme" | "named" | "deck" | "charts";

export interface ColorStudioPanelProps {
  editor: EditorApi;
  open: boolean;
  onClose: () => void;
  /** A theme role or a named colour to open at. */
  focus?: string;
}

const GROUPS: ThemeColorGroup[] = ["Text", "Brand", "Surfaces", "Structure", "Status", "Charts"];

type Apply = (operations: Parameters<EditorApi["apply"]>[0], label: string, coalesceKey?: string) => void;

export function ColorStudioPanel({ editor, open, onClose, focus }: ColorStudioPanelProps) {
  const document = editor.document;
  const named = namedColors(document);
  const [tab, setTab] = useState<Tab>(() => (focus && named.some((color) => color.name === focus) ? "named" : "theme"));

  useEffect(() => {
    if (!focus) return;
    setTab(named.some((color) => color.name === focus) ? "named" : "theme");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  if (!open) return null;

  const apply: Apply = (operations, label, coalesceKey) => {
    if (operations.length === 0) return;
    editor.apply(operations, { label, ...(coalesceKey ? { coalesceKey } : {}) });
  };
  const deck = deckColors(document);

  return (
    <section className="dk-colorstudio" aria-label="Colours" data-testid="color-studio">
      <div className="dk-colorstudio__head">
        <IconButton icon="chevronLeft" label="Close colours" size="sm" onClick={onClose} title="Back to Design" />
        <h2 className="dk-colorstudio__title">Colours</h2>
        <span className="dk-colorstudio__meta">
          {named.length} named · {deck.length} loose
        </span>
      </div>
      <Tabs
        label="Colour kind"
        value={tab}
        onChange={setTab}
        className="dk-colorstudio__tabs"
        items={[
          { value: "theme", label: "Theme", panel: <ThemeColors document={document} apply={apply} focus={focus} /> },
          { value: "named", label: `Named (${named.length})`, panel: <NamedColors document={document} apply={apply} focus={focus} /> },
          { value: "deck", label: `In deck (${deck.length})`, panel: <DeckColors document={document} apply={apply} /> },
          { value: "charts", label: "Charts", panel: <ChartPalette document={document} apply={apply} /> },
        ]}
      />
    </section>
  );
}

// -------------------------------------------------------------------- editor

/**
 * One colour, edited: picked by eye (the ramp), by hex, or from the screen.
 * The hex commits once, when it is whole and valid; the ramp commits on release.
 */
function ColorEditor({
  title,
  meta,
  value,
  resolved,
  against,
  onCommit,
  coalesceKey,
  hexTestId,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  value: string;
  resolved: string | undefined;
  /** What this colour is read on, for the contrast readout. */
  against?: { label: string; color: string | undefined };
  onCommit: (value: string, coalesceKey?: string) => void;
  coalesceKey: string;
  hexTestId?: string;
  children?: ReactNode;
}) {
  const [hex, setHex] = useState(resolved ?? "");
  const [error, setError] = useState<string | undefined>();
  const id = useId();
  useEffect(() => setHex(resolved ?? ""), [resolved]);
  const label = typeof title === "string" ? title : "Colour";

  const commit = () => {
    const next = hex.trim();
    if (!HEX_COLOR.test(next)) {
      setError("Use a hex colour such as #1E4BD2.");
      return;
    }
    setError(undefined);
    if (normaliseColor(next) !== normaliseColor(resolved ?? "")) onCommit(next.toUpperCase());
  };
  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const ratio = against ? contrastBetween(resolved?.slice(0, 7), against.color?.slice(0, 7)) : undefined;
  const verdict = contrastVerdict(ratio);

  return (
    <div className="dk-coloreditor" data-testid="color-editor">
      <div className="dk-coloreditor__head">
        <span className="dk-coloreditor__swatch" aria-hidden="true" style={{ background: resolved }} />
        <span className="dk-colorstudio__name">
          <strong>{title}</strong>
          {meta ? <span className="dk-colorstudio__meta">{meta}</span> : null}
        </span>
      </div>
      <ColorRamp label={label} value={resolved} alpha onCommit={(next) => onCommit(next)} />
      <span className="dk-colorstudio__input">
        <label className="dk-visually-hidden" htmlFor={id}>
          {label} hex value
        </label>
        <input
          id={id}
          className={cx("dk-input", error && "dk-input--invalid")}
          value={hex}
          placeholder={value.startsWith("token:") ? "" : "#1E4BD2"}
          data-testid={hexTestId ?? "color-editor-hex"}
          aria-invalid={error ? true : undefined}
          title={error}
          onChange={(event) => setHex(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        {eyedropper ? (
          <IconButton
            icon="eyedropper"
            label="Pick a colour from the screen"
            size="sm"
            onClick={() => {
              const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
              void new Dropper()
                .open()
                .then((result) => onCommit(result.sRGBHex.toUpperCase(), coalesceKey))
                .catch(() => undefined);
            }}
          />
        ) : null}
      </span>
      {error ? <span className="dk-field__hint dk-field__hint--error">{error}</span> : null}
      {verdict && against ? (
        <div className="dk-coloreditor__contrast" title={`Contrast ${ratio}:1`}>
          <StatusChip tone={verdict === "AA" ? "neutral" : verdict === "AA large" ? "waiting" : "danger"}>{verdict === "Low" ? "Low" : verdict}</StatusChip>
          <span>
            On {against.label.toLowerCase()} <strong>{ratio}:1</strong>
            {verdict === "AA large" ? " — large text only" : verdict === "Low" ? " — hard to read" : ""}
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A colour in a list: pick it to edit it at the top. */
function ColorRow({
  id,
  name,
  meta,
  color,
  selected,
  onSelect,
  testId,
  trailing,
}: {
  id: string;
  name: string;
  meta?: string;
  color: string | undefined;
  selected: boolean;
  onSelect: () => void;
  testId?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={cx("dk-colorrow", selected && "dk-colorrow--selected")} data-color-row={id} data-testid={testId}>
      <button type="button" className="dk-colorrow__pick" aria-pressed={selected} aria-label={`Edit ${name}`} onClick={onSelect}>
        <span className="dk-colorfield__swatch" aria-hidden="true" style={{ background: color }} />
        <span className="dk-colorrow__name">{name}</span>
        {meta ? <span className="dk-colorstudio__meta">{meta}</span> : null}
        <Icon name="chevronRight" size={14} />
      </button>
      {trailing}
    </div>
  );
}

// --------------------------------------------------------------------- tabs

const THEME_MODE = "__theme";

function ThemeColors({ document, apply, focus }: { document: PresentationDocument; apply: Apply; focus?: string }) {
  const colors = document.theme.colors as unknown as Record<string, unknown>;
  const available = THEME_COLOR_ROLES.filter((role) => typeof colors[role.token] === "string");
  const [selected, setSelected] = useState(() => (focus && available.some((role) => role.token === focus) ? focus : "accent"));
  const modes = colorModes(document);
  const [modeName, setModeName] = useState<string>(THEME_MODE);
  const mode = modes.some((candidate) => candidate.name === modeName) ? modeName : undefined;
  useEffect(() => {
    if (focus && available.some((role) => role.token === focus)) setSelected(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const role = available.find((candidate) => candidate.token === selected) ?? available[0];
  const modeColors = (name: string | undefined) => (name ? ((document.theme.modes?.[name]?.colors ?? {}) as Record<string, string>) : {});
  const colorOf = (token: string) => (mode ? modeColor(document, mode, token) : resolveColorValue(document, colors[token] as string | undefined));
  const overridden = (token: string) => Boolean(mode && modeColors(mode)[token] !== undefined);
  const opposite = (document.theme.mode ?? "light") === "dark" ? "Light" : "Dark";

  return (
    <div className="dk-colorstudio__list">
      <ModeBar document={document} apply={apply} value={mode ?? THEME_MODE} onChange={setModeName} opposite={opposite} />
      {role ? (
        <ColorEditor
          title={role.label}
          meta={
            mode
              ? `${mode} mode · ${overridden(role.token) ? "its own colour" : "same as the theme"}`
              : `Theme colour · ${usesText(tokenUseCount(document, themeColorToken(role.token)))}`
          }
          value={mode ? (modeColors(mode)[role.token] ?? (colors[role.token] as string)) : (colors[role.token] as string)}
          resolved={colorOf(role.token)}
          against={role.against ? { label: THEME_COLOR_ROLES.find((r) => r.token === role.against)?.label ?? role.against, color: colorOf(role.against) } : undefined}
          coalesceKey={`colors:${mode ?? "theme"}:${role.token}`}
          hexTestId={`theme-color-${role.token}`}
          onCommit={(value, key) =>
            mode
              ? apply(setModeColorOperations(document, mode, role.token, value), `Change ${role.label} in ${mode} mode`, key)
              : apply(setThemeColorOperations(document, role.token, value), `Change ${role.label} colour`, key)
          }
        >
          {mode && overridden(role.token) ? (
            <Button size="sm" variant="ghost" onClick={() => apply(setModeColorOperations(document, mode, role.token, undefined), `Use the theme colour for ${role.label} in ${mode} mode`)}>
              Use the theme colour
            </Button>
          ) : null}
        </ColorEditor>
      ) : null}
      {GROUPS.map((group) => {
        const roles = available.filter((candidate) => candidate.group === group);
        if (roles.length === 0) return null;
        return (
          <section key={group} className="dk-colorstudio__group">
            <h4 className="dk-colorpicker__heading">{group}</h4>
            {roles.map((candidate) => (
              <ColorRow
                key={candidate.token}
                id={candidate.token}
                name={candidate.label}
                meta={mode ? (overridden(candidate.token) ? `${mode} only` : "as theme") : usesText(tokenUseCount(document, themeColorToken(candidate.token)))}
                color={colorOf(candidate.token)}
                selected={candidate.token === role?.token}
                onSelect={() => setSelected(candidate.token)}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Which colours are being edited: the theme's own, or a mode's (design review,
 * 2026-09-27). A mode starts generated from the theme and is then the
 * person's to adjust; slides choose it under Slide design.
 */
function ModeBar({
  document,
  apply,
  value,
  onChange,
  opposite,
}: {
  document: PresentationDocument;
  apply: Apply;
  value: string;
  onChange: (next: string) => void;
  opposite: string;
}) {
  const modes = colorModes(document);
  const inUse = (name: string) => document.slides.filter((slide) => slide.colorMode === name).length;
  const canAdd = !modeNameProblem(document, opposite);
  return (
    <div className="dk-colorstudio__modes" data-testid="color-modes">
      {modes.length ? (
        <Segmented
          label="Colour mode"
          size="sm"
          value={value}
          onChange={onChange}
          items={[{ value: THEME_MODE, label: "Theme" }, ...modes.map((mode) => ({ value: mode.name, label: mode.name }))]}
        />
      ) : null}
      <div className="dk-styles__actions">
        {canAdd ? (
          <Button
            size="sm"
            icon="plus"
            data-testid="color-mode-add"
            onClick={() => {
              apply(addModeOperations(document, opposite, generateOppositeMode(document)), `Add ${opposite.toLowerCase()} mode`);
              onChange(opposite);
            }}
          >
            {opposite} mode
          </Button>
        ) : null}
        {value !== THEME_MODE ? (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={() => {
              apply(removeModeOperations(document, value), `Delete ${value} mode`);
              onChange(THEME_MODE);
            }}
          >
            Delete {value} mode{inUse(value) ? ` (${inUse(value)} slide${inUse(value) === 1 ? "" : "s"} go back to the theme)` : ""}
          </Button>
        ) : null}
      </div>
      {value !== THEME_MODE ? <p className="dk-field__hint">Choose which slides use it under Slide design, Colours.</p> : null}
    </div>
  );
}

function usesText(count: number): string {
  return count ? `used ${count}×` : "not used on a slide";
}

function NamedColors({ document, apply, focus }: { document: PresentationDocument; apply: Apply; focus?: string }) {
  const named = namedColors(document);
  const [selected, setSelected] = useState<string | undefined>(() => (focus && named.some((c) => c.name === focus) ? focus : named[0]?.name));
  const [name, setName] = useState("");
  const [value, setValue] = useState("#1E4BD2");
  const [problem, setProblem] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (focus && named.some((color) => color.name === focus)) setSelected(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const current = named.find((color) => color.name === selected) ?? named[0];

  const add = () => {
    const nameProblem = namedColorProblem(document, name);
    if (nameProblem) {
      setProblem(nameProblem);
      return;
    }
    if (!HEX_COLOR.test(value.trim())) {
      setProblem("Use a hex colour such as #1E4BD2.");
      return;
    }
    const trimmed = name.trim().replace(/\s+/g, " ");
    apply(addNamedColorOperations(document, trimmed, value.trim().toUpperCase()).operations, `Add colour "${trimmed}"`);
    setSelected(trimmed);
    setName("");
    setProblem(undefined);
  };

  return (
    <div className="dk-colorstudio__list">
      {current ? (
        <ColorEditor
          title={current.name}
          meta={`Named colour · ${tokenUseCount(document, current.token) ? `used ${tokenUseCount(document, current.token)}×` : "unused"}`}
          value={current.value}
          resolved={resolveColorValue(document, current.value)}
          against={{ label: "Background", color: resolveColorValue(document, "token:colors.background") }}
          coalesceKey={`colors:named:${current.name}`}
          onCommit={(next, key) => apply(setNamedColorOperations(document, current.name, next), `Change colour "${current.name}"`, key)}
        >
          <RenameField
            document={document}
            name={current.name}
            apply={apply}
            onRenamed={(next) => setSelected(next)}
          />
          <FollowsField document={document} name={current.name} value={current.value} apply={apply} />
          {deleting ? (
            <div className="dk-colorstudio__confirm" role="group" aria-label={`Delete ${current.name}`}>
              <span className="dk-field__hint">
                {tokenUseCount(document, current.token)
                  ? `${tokenUseCount(document, current.token)} place${tokenUseCount(document, current.token) === 1 ? "" : "s"} use "${current.name}". They keep its colour as a plain colour.`
                  : `Nothing uses "${current.name}".`}
              </span>
              <Button
                size="sm"
                variant="danger"
                data-testid="named-color-delete"
                onClick={() => {
                  apply(deleteNamedColorOperations(document, current.name), `Delete colour "${current.name}"`);
                  setDeleting(false);
                  setSelected(named.find((color) => color.name !== current.name)?.name);
                }}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleting(true)} aria-label={`Delete ${current.name}`}>
              Delete colour
            </Button>
          )}
        </ColorEditor>
      ) : (
        <p className="dk-field__hint">
          A named colour is yours to reuse on text, shapes, charts, tables, diagrams and equations. Change it once and every use
          changes with it.
        </p>
      )}

      {standardRolesOperations(document).length ? (
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          data-testid="color-roles-add"
          title={STANDARD_ROLES.map((role) => role.name).join(", ")}
          onClick={() => apply(standardRolesOperations(document), "Add colour roles")}
        >
          Add colour roles (Primary, On primary, Surface…)
        </Button>
      ) : null}

      {named.map((color) => (
        <ColorRow
          key={color.name}
          id={color.name}
          name={color.name}
          meta={`${aliasOf(color.value) ? `follows ${aliasLabel(document, color.value)} · ` : ""}${tokenUseCount(document, color.token) ? `used ${tokenUseCount(document, color.token)}×` : "unused"}`}
          color={resolveColorValue(document, color.value)}
          selected={color.name === current?.name}
          testId="named-color-row"
          onSelect={() => {
            setSelected(color.name);
            setDeleting(false);
          }}
        />
      ))}

      <div className="dk-colorstudio__add">
        <h4 className="dk-colorpicker__heading">Add a colour</h4>
        <TextField
          label="New colour name"
          value={name}
          placeholder="Brand blue"
          data-testid="named-color-name"
          onChange={(next) => {
            setName(next);
            setProblem(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <ColorRamp label="New colour" value={HEX_COLOR.test(value) ? value : undefined} onCommit={setValue} />
        <span className="dk-colorstudio__input">
          <span className="dk-colorfield__swatch" aria-hidden="true" style={{ background: HEX_COLOR.test(value) ? value : undefined }} />
          <TextField label="New colour hex value" hideLabel value={value} data-testid="named-color-value" onChange={setValue} />
        </span>
        <Button variant="primary" icon="plus" onClick={add} data-testid="named-color-add">
          Add colour
        </Button>
        {problem ? (
          <span className="dk-field__hint dk-field__hint--error" role="status">
            {problem}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a named colour is: a colour of its own, or a role that follows another
 * colour (design review, 2026-09-27). Following keeps it in step with the
 * colour it names, in every mode; choosing "its own" keeps the colour it has
 * now as a plain value.
 */
function FollowsField({ document, name, value, apply }: { document: PresentationDocument; name: string; value: string; apply: Apply }) {
  const own = "__own";
  const colors = document.theme.colors as unknown as Record<string, unknown>;
  const options = [
    { value: own, label: "Its own colour" },
    ...THEME_COLOR_ROLES.filter((role) => typeof colors[role.token] === "string").map((role) => ({
      value: themeColorToken(role.token),
      label: `Theme: ${role.label}`,
    })),
    ...namedColors(document)
      .filter((color) => color.name !== name && !wouldLoop(document, name, color.token))
      .map((color) => ({ value: color.token, label: `Named: ${color.name}` })),
  ];
  const current = aliasOf(value) ?? own;
  return (
    <Select
      label="Follows"
      value={options.some((option) => option.value === current) ? current : own}
      options={options}
      data-testid="named-color-follows"
      onChange={(next) => {
        if (next === current) return;
        const target = next === own ? (resolveColorValue(document, value) ?? value) : next;
        apply(setNamedColorOperations(document, name, target), next === own ? `Give "${name}" its own colour` : `Make "${name}" follow ${aliasLabel(document, next)}`);
      }}
    />
  );
}

function aliasLabel(document: PresentationDocument, token: string): string {
  void document;
  const path = token.slice("token:colors.".length);
  if (path.startsWith("custom.")) return path.slice("custom.".length);
  return THEME_COLOR_ROLES.find((role) => role.token === path)?.label ?? path;
}

/** A named colour's name, renamed on Enter or blur; every reference is rewritten with it. */
function RenameField({ document, name, apply, onRenamed }: { document: PresentationDocument; name: string; apply: Apply; onRenamed: (next: string) => void }) {
  const [draft, setDraft] = useState(name);
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    if (draft.trim() === name) return;
    const reason = namedColorProblem(document, draft, name);
    if (reason) {
      setProblem(reason);
      return;
    }
    setProblem(undefined);
    const next = draft.trim().replace(/\s+/g, " ");
    apply(renameNamedColorOperations(document, name, next), `Rename colour "${name}"`);
    onRenamed(next);
  };
  return (
    <span className="dk-field">
      <label className="dk-label" htmlFor={`rename-${name}`}>
        Name
      </label>
      <input
        id={`rename-${name}`}
        className={cx("dk-input dk-colorstudio__rename", problem && "dk-input--invalid")}
        aria-label={`Name of ${name}`}
        value={draft}
        title={problem}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setDraft(name);
            setProblem(undefined);
          }
        }}
      />
      {problem ? <span className="dk-field__hint dk-field__hint--error">{problem}</span> : null}
    </span>
  );
}

function DeckColors({ document, apply }: { document: PresentationDocument; apply: Apply }) {
  const colors = deckColors(document);
  const [naming, setNaming] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement>(null);

  if (colors.length === 0) {
    return (
      <p className="dk-field__hint">
        Every colour on these slides comes from the theme or a named colour, so the deck re-themes cleanly.
      </p>
    );
  }
  return (
    <div className="dk-colorstudio__list">
      <p className="dk-field__hint">
        These colours are written onto objects directly, so a new theme will not change them. Name one to reuse and re-theme
        it, or replace it everywhere.
      </p>
      {colors.map((color) => (
        <div key={color.value} className="dk-colorstudio__row" data-testid="deck-color-row" data-color-value={color.value}>
          <span className="dk-colorfield__swatch" aria-hidden="true" style={{ background: color.value }} />
          <span className="dk-colorstudio__name">
            {color.value}
            <span className="dk-colorstudio__meta">used {color.count}×</span>
          </span>
          {naming === color.value ? (
            <span className="dk-colorstudio__confirm">
              <TextField
                ref={nameRef}
                label={`Name for ${color.value}`}
                value={name}
                placeholder="Brand blue"
                error={problem}
                autoFocus
                data-testid="deck-color-name"
                onChange={(next) => {
                  setName(next);
                  setProblem(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const reason = namedColorProblem(document, name);
                  if (reason) {
                    setProblem(reason);
                    return;
                  }
                  apply(promoteColorOperations(document, color.value, name), `Name colour "${name.trim()}"`);
                  setNaming(undefined);
                  setName("");
                }}
              />
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              data-testid="deck-color-promote"
              onClick={() => {
                setNaming(color.value);
                setName("");
                setProblem(undefined);
              }}
            >
              Name it
            </Button>
          )}
          <ColorField
            label={`Replace ${color.value} with`}
            value={color.value}
            theme={document.theme}
            onChange={(next) => {
              if (next) apply(replaceColorOperations(document, color.value, next), `Replace ${color.value} everywhere`);
            }}
          />
        </div>
      ))}
    </div>
  );
}

function ChartPalette({ document, apply }: { document: PresentationDocument; apply: Apply }) {
  const series = ((document.theme.colors as unknown as { chartSeries?: string[] }).chartSeries ?? []).slice();
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, series.length - 1);
  const write = (next: string[], label: string, key?: string) => apply(setChartSeriesOperations(document, next), label, key);
  const color = series[index];
  return (
    <div className="dk-colorstudio__list">
      {color !== undefined ? (
        <ColorEditor
          title={`Series ${index + 1}`}
          meta="Every chart without its own colours"
          value={color}
          resolved={resolveColorValue(document, color)}
          coalesceKey={`colors:series:${index}`}
          onCommit={(next, key) => {
            const updated = series.slice();
            updated[index] = next;
            write(updated, `Change series ${index + 1} colour`, key);
          }}
        >
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            disabled={series.length <= 6}
            title={series.length <= 6 ? "A chart palette keeps at least six colours" : undefined}
            onClick={() => {
              write(series.filter((_, at) => at !== index), `Remove series ${index + 1} colour`);
              setSelected(Math.max(0, index - 1));
            }}
          >
            Remove this colour
          </Button>
        </ColorEditor>
      ) : null}
      <p className="dk-field__hint">Series take these colours in order: the first series the first colour, always.</p>
      {series.map((value, at) => (
        <ColorRow
          key={at}
          id={`series-${at}`}
          name={`Series ${at + 1}`}
          color={resolveColorValue(document, value)}
          selected={at === index}
          testId="chart-series-row"
          onSelect={() => setSelected(at)}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon="plus"
        onClick={() => {
          write([...series, "#888888"], "Add a series colour");
          setSelected(series.length);
        }}
      >
        Add a series colour
      </Button>
    </div>
  );
}
