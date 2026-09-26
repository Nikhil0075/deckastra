import { useEffect, useId, useRef, useState } from "react";
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
import { Button, Drawer, IconButton, StatusChip, Tabs, TextField, cx } from "../ui";
import { ColorField } from "./inspector/controls";

/**
 * The Colours panel (colour wizard, 2026-09-26): one place to see and change
 * every colour a deck uses.
 *
 * Non-modal, so the slide stays live beside it and a colour changed here is seen
 * changing there. Four tabs, one per kind of colour a deck has:
 *
 * - **Theme**: the roles. Changing one changes everything that uses it, with the
 *   contrast against what it is read on shown as it changes.
 * - **Named**: the person's own colours, which elements refer to by name. Rename
 *   and delete rewrite every reference in the same patch.
 * - **In this deck**: loose colours on the slides, with how often each is used,
 *   and two ways to tidy them: name it (every use becomes the name), or replace
 *   it everywhere.
 * - **Charts**: the series palette every chart without its own draws from.
 *
 * Every change is one patch through the editor, so one Undo reverses it; a
 * colour dragged in the system picker is coalesced into one step per field.
 */

type Tab = "theme" | "named" | "deck" | "charts";

export interface ColorStudioPanelProps {
  editor: EditorApi;
  open: boolean;
  onClose: () => void;
  /** A theme role or a named colour to scroll to and mark. */
  focus?: string;
}

const GROUPS: ThemeColorGroup[] = ["Text", "Brand", "Surfaces", "Structure", "Status", "Charts"];

export function ColorStudioPanel({ editor, open, onClose, focus }: ColorStudioPanelProps) {
  const document = editor.document;
  const named = namedColors(document);
  const [tab, setTab] = useState<Tab>("theme");

  useEffect(() => {
    if (!open || !focus) return;
    setTab(named.some((color) => color.name === focus) ? "named" : "theme");
    // After the tab has rendered: bring the row into view.
    const timer = setTimeout(() => {
      window.document.querySelector(`[data-color-row="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "center" });
    }, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focus]);

  const apply = (operations: Parameters<EditorApi["apply"]>[0], label: string, coalesceKey?: string) => {
    if (operations.length === 0) return;
    editor.apply(operations, { label, ...(coalesceKey ? { coalesceKey } : {}) });
  };

  const deck = deckColors(document);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Colours"
      meta={`${named.length} named · ${deck.length} loose`}
      modal={false}
      width={400}
      data-testid="color-studio"
    >
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
    </Drawer>
  );
}

type Apply = (operations: Parameters<EditorApi["apply"]>[0], label: string, coalesceKey?: string) => void;

/**
 * A colour value edited by hand: the system picker and a hex field. The picker
 * reports every position while it is dragged, so its commits carry a coalesce key
 * and become one undo step; the hex field commits once, when it is valid.
 */
function ColorInput({
  label,
  value,
  resolved,
  onCommit,
  coalesceKey,
  testId,
}: {
  label: string;
  value: string;
  resolved: string | undefined;
  onCommit: (value: string, coalesceKey?: string) => void;
  coalesceKey: string;
  testId?: string;
}) {
  const [hex, setHex] = useState(resolved ?? "");
  const [error, setError] = useState<string | undefined>();
  const id = useId();
  useEffect(() => setHex(resolved ?? ""), [resolved]);
  const commit = () => {
    const next = hex.trim();
    if (!HEX_COLOR.test(next)) {
      setError("Use a hex colour such as #1E4BD2.");
      return;
    }
    setError(undefined);
    if (normaliseColor(next) !== normaliseColor(resolved ?? "")) onCommit(next.toUpperCase());
  };
  const six = resolved && /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : resolved && /^#[0-9a-f]{3}$/i.test(resolved) ? normaliseColor(resolved) : "#000000";
  return (
    <span className="dk-colorstudio__input">
      <input
        type="color"
        aria-label={`${label} colour picker`}
        value={six.slice(0, 7)}
        onChange={(event) => onCommit(event.target.value.toUpperCase(), coalesceKey)}
      />
      <label className="dk-visually-hidden" htmlFor={id}>
        {label} hex value
      </label>
      <input
        id={id}
        className={cx("dk-input", error && "dk-input--invalid")}
        value={hex}
        placeholder={value.startsWith("token:") ? "" : "#1E4BD2"}
        data-testid={testId}
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
    </span>
  );
}

function Contrast({ ratio }: { ratio: number | undefined }) {
  const verdict = contrastVerdict(ratio);
  if (!verdict) return null;
  return (
    <StatusChip tone={verdict === "AA" ? "neutral" : verdict === "AA large" ? "waiting" : "danger"} title={`Contrast ${ratio}:1`}>
      {ratio}:1 {verdict === "Low" ? "low" : verdict}
    </StatusChip>
  );
}

function ThemeColors({ document, apply, focus }: { document: PresentationDocument; apply: Apply; focus?: string }) {
  const colors = document.theme.colors as unknown as Record<string, unknown>;
  return (
    <div className="dk-colorstudio__list">
      <p className="dk-field__hint">
        Theme colours are roles. Everything that uses a role follows it, on every slide, and a new theme replaces them all at
        once.
      </p>
      {GROUPS.map((group) => {
        const roles = THEME_COLOR_ROLES.filter((role) => role.group === group && typeof colors[role.token] === "string");
        if (roles.length === 0) return null;
        return (
          <section key={group} className="dk-colorstudio__group">
            <h4 className="dk-colorpicker__heading">{group}</h4>
            {roles.map((role) => {
              const stored = colors[role.token] as string;
              const resolved = resolveColorValue(document, stored);
              const against = role.against ? resolveColorValue(document, colors[role.against] as string | undefined) : undefined;
              const uses = tokenUseCount(document, themeColorToken(role.token));
              return (
                <div
                  key={role.token}
                  className={cx("dk-colorstudio__row", focus === role.token && "dk-colorstudio__row--focus")}
                  data-color-row={role.token}
                >
                  <span className="dk-colorfield__swatch" aria-hidden="true" style={{ background: resolved }} />
                  <span className="dk-colorstudio__name">
                    {role.label}
                    <span className="dk-colorstudio__meta">
                      {stored.startsWith("token:") ? `→ ${stored.slice(stored.lastIndexOf(".") + 1)} · ` : ""}
                      {uses ? `used ${uses}×` : "not used on a slide"}
                    </span>
                  </span>
                  {against ? <Contrast ratio={contrastBetween(resolved, against)} /> : null}
                  <ColorInput
                    label={role.label}
                    value={stored}
                    resolved={resolved}
                    coalesceKey={`colors:theme:${role.token}`}
                    testId={`theme-color-${role.token}`}
                    onCommit={(value, key) => apply(setThemeColorOperations(document, role.token, value), `Change ${role.label} colour`, key)}
                  />
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function NamedColors({ document, apply, focus }: { document: PresentationDocument; apply: Apply; focus?: string }) {
  const named = namedColors(document);
  const [name, setName] = useState("");
  const [value, setValue] = useState("#1E4BD2");
  const [problem, setProblem] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<string | undefined>();

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
    apply(addNamedColorOperations(document, name, value.trim().toUpperCase()).operations, `Add colour "${name.trim()}"`);
    setName("");
    setProblem(undefined);
  };

  return (
    <div className="dk-colorstudio__list">
      <p className="dk-field__hint">
        A named colour is yours to reuse on text, shapes, charts, tables, diagrams and equations. Change it here and every use
        changes with it.
      </p>
      <div className="dk-colorstudio__add">
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
        <span className="dk-colorstudio__input">
          <input type="color" aria-label="New colour picker" value={HEX_COLOR.test(value) && value.length === 7 ? value : "#1E4BD2"} onChange={(event) => setValue(event.target.value.toUpperCase())} />
          <TextField label="New colour hex value" hideLabel value={value} data-testid="named-color-value" onChange={setValue} />
        </span>
        <Button size="sm" variant="primary" icon="plus" onClick={add} data-testid="named-color-add">
          Add
        </Button>
      </div>
      {problem ? (
        <span className="dk-field__hint dk-field__hint--error" role="status">
          {problem}
        </span>
      ) : null}

      {named.length === 0 ? <p className="dk-field__hint">No named colours yet.</p> : null}
      {named.map((color) => {
        const resolved = resolveColorValue(document, color.value);
        const uses = tokenUseCount(document, color.token);
        return (
          <div
            key={color.name}
            className={cx("dk-colorstudio__row", focus === color.name && "dk-colorstudio__row--focus")}
            data-color-row={color.name}
            data-testid="named-color-row"
          >
            <span className="dk-colorfield__swatch" aria-hidden="true" style={{ background: resolved }} />
            <RenameField document={document} name={color.name} apply={apply} />
            <span className="dk-colorstudio__meta">{uses ? `used ${uses}×` : "unused"}</span>
            <ColorInput
              label={color.name}
              value={color.value}
              resolved={resolved}
              coalesceKey={`colors:named:${color.name}`}
              onCommit={(next, key) => apply(setNamedColorOperations(document, color.name, next), `Change colour "${color.name}"`, key)}
            />
            <IconButton icon="trash" label={`Delete ${color.name}`} size="sm" onClick={() => setDeleting(color.name)} />
            {deleting === color.name ? (
              <div className="dk-colorstudio__confirm" role="group" aria-label={`Delete ${color.name}`}>
                <span className="dk-field__hint">
                  {uses
                    ? `${uses} place${uses === 1 ? "" : "s"} use "${color.name}". They keep ${resolved ?? "its colour"} as a plain colour.`
                    : `Nothing uses "${color.name}".`}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  data-testid="named-color-delete"
                  onClick={() => {
                    apply(deleteNamedColorOperations(document, color.name), `Delete colour "${color.name}"`);
                    setDeleting(undefined);
                  }}
                >
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(undefined)}>
                  Keep
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A named colour's name, renamed on Enter or blur; every reference is rewritten with it. */
function RenameField({ document, name, apply }: { document: PresentationDocument; name: string; apply: Apply }) {
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
    apply(renameNamedColorOperations(document, name, draft), `Rename colour "${name}"`);
  };
  return (
    <span className="dk-colorstudio__name">
      <input
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
  const write = (next: string[], label: string, key?: string) => apply(setChartSeriesOperations(document, next), label, key);
  return (
    <div className="dk-colorstudio__list">
      <p className="dk-field__hint">
        Series take these colours in order: the first series the first colour, always. A chart can set its own in the inspector.
      </p>
      {series.map((color, index) => {
        const resolved = resolveColorValue(document, color);
        return (
          <div key={index} className="dk-colorstudio__row" data-testid="chart-series-row">
            <span className="dk-colorfield__swatch" aria-hidden="true" style={{ background: resolved }} />
            <span className="dk-colorstudio__name">Series {index + 1}</span>
            <ColorInput
              label={`Series ${index + 1}`}
              value={color}
              resolved={resolved}
              coalesceKey={`colors:series:${index}`}
              onCommit={(next, key) => {
                const updated = series.slice();
                updated[index] = next;
                write(updated, `Change series ${index + 1} colour`, key);
              }}
            />
            <IconButton
              icon="trash"
              label={`Remove series ${index + 1} colour`}
              size="sm"
              disabled={series.length <= 6}
              onClick={() => write(series.filter((_, at) => at !== index), `Remove series ${index + 1} colour`)}
            />
          </div>
        );
      })}
      <Button
        size="sm"
        variant="ghost"
        icon="plus"
        onClick={() => write([...series, "#888888"], "Add a series colour")}
      >
        Add a series colour
      </Button>
    </div>
  );
}
