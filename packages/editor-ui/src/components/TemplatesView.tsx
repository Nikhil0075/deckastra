"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { DeckPreset, PresetCatalog, PresetSlotValue, PresetTheme, PurposeGroup } from "@deckastra/workspace-contracts";

import { Button, Drawer, InlineError, Select, SkeletonCards, StatusChip } from "../ui";
import { cx } from "../ui/cx";
import { TemplateContactSheet, TemplateCoverPreview } from "./TemplatePreview";

/**
 * The template catalog as a destination of its own (UI audit 2026-10-10, unit 1).
 *
 * It used to sit above the person's decks in one scroll. Here it has the whole
 * main area, a featured row, and a detail drawer, which is where a template is
 * looked at before it is used. The bar's search is this view's search while it
 * is showing (`query`), so there is exactly one search box and it is never
 * ambiguous about what it searches.
 *
 * Creating stays where it was: `client.presets.create`, the reviewed preset
 * route. Nothing here composes geometry; content entered in "Start with my
 * content" is named slot text, the same map an agent sends `deck_from_template`.
 */

export const PURPOSE_LABELS: Record<PurposeGroup | "all", string> = {
  all: "All",
  business: "Business",
  product: "Product",
  teaching: "Teaching",
  technical: "Technical",
  team: "Team",
  personal: "Personal",
};

type Content = Record<string, Record<string, PresetSlotValue>>;

export interface TemplatesViewProps {
  projectId: string | null;
  /** The bar's search text, which searches templates while this view shows. */
  query: string;
  disabled?: boolean;
  /** Bumped to move keyboard focus to the catalog (File › New from template). */
  focusToken?: number;
  onCreated: (presentationId: string) => void;
  /** Open the host's agent set-up (desktop Settings › Agents). Absent: not offered. */
  onBuildWithAgent?: () => void;
}

export function TemplatesView({ projectId, query, disabled = false, focusToken = 0, onCreated, onBuildWithAgent }: TemplatesViewProps) {
  const client = useWorkspaceClient();
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [purpose, setPurpose] = useState<PurposeGroup | "all">("all");
  const [themeKey, setThemeKey] = useState("");
  // Design-language filters (UI audit unit 7b): one language, or the look
  // described by its axes. Both filter the catalog; nothing generates from them.
  const [language, setLanguage] = useState("");
  const [poles, setPoles] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeckPreset | null>(null);
  const start = useRef<HTMLElement | null>(null);

  // The catalog's own failure, apart from a failed "Use template": only this
  // one is answered by reading the catalog again.
  const [catalogFailed, setCatalogFailed] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setCatalogFailed(null);
    client.presets
      .list({ fresh: true })
      .then((value) => {
        if (cancelled) return;
        setCatalog(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setCatalogFailed(caught instanceof Error ? caught.message : "Templates could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, catalogAttempt]);

  useEffect(() => {
    if (focusToken) start.current?.focus();
  }, [focusToken]);

  const needle = query.trim().toLocaleLowerCase();
  const shown = useMemo(
    () =>
      catalog?.presets.filter((preset) => {
        if (purpose !== "all" && preset.purpose !== purpose) return false;
        if (language && preset.designLanguage !== language) return false;
        if (poles.size && !matchesLook(catalog.designLanguages?.[preset.designLanguage ?? ""]?.axes, poles)) return false;
        if (!needle) return true;
        const languageName = catalog.designLanguages?.[preset.designLanguage ?? ""]?.name ?? "";
        return [preset.name, preset.summary, preset.purpose, languageName, ...preset.tags].some((value) => value.toLocaleLowerCase().includes(needle));
      }) ?? [],
    [catalog, purpose, language, poles, needle],
  );
  const filtered = purpose !== "all" || Boolean(language) || poles.size > 0;
  const languages = Object.values(catalog?.designLanguages ?? {}).filter((one) => catalog?.presets.some((preset) => preset.designLanguage === one.id));

  // The featured row: the first template of each purpose, which is the
  // hand-written foundation one. Only on the unfiltered catalog — a featured row
  // above a search result would show things the search did not ask for.
  const featured = useMemo(() => {
    if (!catalog || filtered || needle) return [];
    const seen = new Set<string>();
    return catalog.presets.filter((preset) => (seen.has(preset.purpose) ? false : (seen.add(preset.purpose), true))).slice(0, 3);
  }, [catalog, filtered, needle]);
  const featuredIds = new Set(featured.map((preset) => preset.id));
  const rest = shown.filter((preset) => !featuredIds.has(preset.id));

  // "Preview theme" is a choice the person makes; until they do, each card
  // shows its own template's theme.
  const themeFor = (preset: DeckPreset): PresetTheme | undefined =>
    catalog?.themes.find((candidate) => candidate.key === (themeKey || preset.themeKey));

  const choose = async (preset: DeckPreset, content?: Content) => {
    if (!projectId) return;
    setCreating(preset.id);
    setError(null);
    try {
      const made = await client.presets.create({
        template_id: preset.id,
        project_id: projectId,
        theme_key: themeKey || preset.themeKey,
        ...(content && Object.keys(content).length > 0 ? { content } : {}),
      });
      onCreated(made.presentation_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The deck could not be created.");
      setCreating(null);
    }
  };

  const unavailable = disabled || !projectId || creating !== null;
  const card = (preset: DeckPreset, featuredCard = false) => (
    <TemplateCard
      key={preset.id}
      preset={preset}
      theme={themeFor(preset)}
      themeKey={themeKey || preset.themeKey}
      motionName={catalog?.motionStyles?.[preset.motionStyle]?.name ?? preset.motionStyle}
      languageName={preset.designLanguage && preset.designLanguage !== "neutral" ? catalog?.designLanguages?.[preset.designLanguage]?.name : undefined}
      featured={featuredCard}
      creating={creating === preset.id}
      disabled={unavailable}
      onOpen={() => setDetail(preset)}
      onUse={() => void choose(preset)}
    />
  );

  return (
    <section ref={start} tabIndex={-1} className="dk-templates" aria-labelledby="templates-title" data-testid="template-start">
      <div className="dk-templates__heading">
        <div>
          <span className="dk-label">Start a deck</span>
          <h2 id="templates-title" className="dk-decks__title">
            Templates
          </h2>
          <p className="dk-muted">Choose the job first. Every template stays fully editable.</p>
        </div>
        {catalog?.themes.length ? (
          <Select
            label="Preview theme"
            value={themeKey}
            onChange={setThemeKey}
            options={[{ value: "", label: "Each template's own" }, ...catalog.themes.map((theme) => ({ value: theme.key, label: theme.name }))]}
            data-testid="template-theme"
          />
        ) : null}
        {languages.length ? (
          <Select
            label="Design language"
            value={language}
            onChange={setLanguage}
            options={[{ value: "", label: "Any language" }, ...languages.map((one) => ({ value: one.id, label: one.name }))]}
            data-testid="template-language"
          />
        ) : null}
      </div>

      <div className="dk-templates__purposes" role="group" aria-label="Filter templates by purpose">
        {(Object.keys(PURPOSE_LABELS) as Array<PurposeGroup | "all">).map((key) => (
          <button
            key={key}
            type="button"
            className={cx("dk-templates__purpose", purpose === key && "dk-templates__purpose--current")}
            aria-pressed={purpose === key}
            onClick={() => setPurpose(key)}
          >
            {PURPOSE_LABELS[key]}
          </button>
        ))}
      </div>

      {languages.length ? (
        <div className="dk-templates__looks" role="group" aria-label="Filter templates by look">
          {LOOK_POLES.map(([axis, value, label]) => {
            const key = `${axis}:${value}`;
            const on = poles.has(key);
            return (
              <button
                key={key}
                type="button"
                className={cx("dk-templates__look", on && "dk-templates__look--current")}
                aria-pressed={on}
                data-testid={`template-look-${value}`}
                onClick={() =>
                  setPoles((current) => {
                    const next = new Set(current);
                    if (on) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                {label}
              </button>
            );
          })}
          {filtered ? (
            <button
              type="button"
              className="dk-templates__look dk-templates__look--clear"
              onClick={() => {
                setPurpose("all");
                setLanguage("");
                setPoles(new Set());
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <InlineError data-testid="templates-error">{error}</InlineError> : null}
      {catalogFailed ? (
        <InlineError onRetry={() => setCatalogAttempt((count) => count + 1)} data-testid="templates-catalog-error">
          {catalogFailed}
        </InlineError>
      ) : null}
      {!catalog && !catalogFailed ? (
        <SkeletonCards label="Loading templates" count={6} gridClassName="dk-templates__grid" data-testid="templates-loading" />
      ) : null}
      {catalog ? (
        <p className="dk-templates__count" role="status">
          {shown.length} reviewed template{shown.length === 1 ? "" : "s"}
          {needle ? ` matching “${query.trim()}”` : ""}
        </p>
      ) : null}

      {featured.length ? (
        <>
          <h3 className="dk-templates__section">Featured</h3>
          <div className="dk-templates__featured" aria-label="Featured templates" role="group">
            {featured.map((preset) => card(preset, true))}
          </div>
          <h3 className="dk-templates__section">All templates</h3>
        </>
      ) : null}
      <div className="dk-templates__grid">{rest.map((preset) => card(preset))}</div>

      <details className="dk-agent-start" data-testid="build-with-agent">
        <summary>Build with your agent</summary>
        <div className="dk-agent-start__body">
          <div>
            <h3>Your agent writes the story; Deckastra composes the deck.</h3>
            <p className="dk-muted">Connect once, ask it to list presets, then let it create or compose through MCP. It never has to guess coordinates.</p>
          </div>
          <ol>
            <li>Open Settings › Agents and copy the setup for your client.</li>
            <li>
              Ask the agent to call <code>preset_list</code>.
            </li>
            <li>
              Use <code>deck_from_template</code> or <code>deck_compose</code>.
            </li>
          </ol>
          {onBuildWithAgent ? (
            <Button variant="secondary" onClick={onBuildWithAgent}>
              Set up an agent
            </Button>
          ) : null}
        </div>
      </details>

      <TemplateDetail
        preset={detail}
        catalog={catalog}
        theme={detail ? themeFor(detail) : undefined}
        themeKey={detail ? themeKey || detail.themeKey : ""}
        creating={detail !== null && creating === detail.id}
        disabled={unavailable}
        onClose={() => setDetail(null)}
        onUse={(content) => detail && void choose(detail, content)}
      />
    </section>
  );
}

/**
 * The cover drawn from the first slide's words in the template's colours. Shown
 * while the real composed cover (`TemplateCoverPreview`) is on its way, and in
 * its place if the service cannot compose one.
 */
function TemplateCover({ preset, theme, large = false }: { preset: DeckPreset; theme?: PresetTheme; large?: boolean }) {
  const background = theme?.preview.background ?? "#ffffff";
  const foreground = theme?.preview.foreground ?? "#111111";
  const accent = theme?.preview.accent ?? "#2563eb";
  const surface = theme?.preview.surface ?? "#f3f4f6";
  const opening = preset.slides[0];
  const headline = opening && typeof opening.slots.headline === "string" ? opening.slots.headline : preset.name;
  const eyebrow = opening && typeof opening.slots.eyebrow === "string" ? opening.slots.eyebrow : PURPOSE_LABELS[preset.purpose];
  return (
    <div className={cx("dk-template-card__preview", large && "dk-template-card__preview--large")} style={{ background, color: foreground } as CSSProperties} aria-hidden="true">
      <span className="dk-template-card__kicker" style={{ color: accent }}>
        {eyebrow}
      </span>
      <strong>{headline}</strong>
      <span className="dk-template-card__line" style={{ background: accent }} />
      <span className="dk-template-card__tiles">
        {[0, 1, 2].map((tile) => (
          <i key={tile} style={{ background: surface, borderColor: foreground }} />
        ))}
      </span>
    </div>
  );
}

function TemplateCard({
  preset,
  theme,
  themeKey,
  motionName,
  languageName,
  featured,
  creating,
  disabled,
  onOpen,
  onUse,
}: {
  preset: DeckPreset;
  theme?: PresetTheme;
  themeKey: string;
  motionName: string;
  /** The design language, when it is one of the named ones. */
  languageName?: string;
  featured: boolean;
  creating: boolean;
  disabled: boolean;
  onOpen: () => void;
  onUse: () => void;
}) {
  return (
    <article className={cx("dk-template-card", featured && "dk-template-card--featured")} data-template-id={preset.id}>
      <button type="button" className="dk-template-card__open" onClick={onOpen} aria-label={`Look at ${preset.name}`} data-testid={`template-card-${preset.id}`}>
        <TemplateCoverPreview templateId={preset.id} themeKey={themeKey} fallback={<TemplateCover preset={preset} theme={theme} />} />
      </button>
      <div className="dk-template-card__body">
        <div>
          <h3>{preset.name}</h3>
          <p>{preset.summary}</p>
        </div>
        <span className="dk-template-card__meta">
          {languageName ? <strong className="dk-template-card__language">{languageName}</strong> : null}
          <StatusChip tone="neutral">{preset.slides.length} slides</StatusChip>
          <span>{motionName} motion</span>
        </span>
        <span className="dk-template-card__actions">
          <Button variant="primary" size="sm" onClick={onUse} disabled={disabled} data-testid={`use-template-${preset.id}`}>
            {creating ? "Creating…" : "Use template"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Details
          </Button>
        </span>
      </div>
    </article>
  );
}

/** The words an agent needs to build this template, ready to paste. */
export function agentPrompt(preset: DeckPreset): string {
  return [
    `Using Deckastra, create a deck from the reviewed template "${preset.name}" (template_id: ${preset.id}).`,
    "Call preset_list to read its slides and named slots, then call deck_from_template with that template_id",
    "and a content map (slide key -> slot -> text) written for my topic. Do not supply coordinates, sizes or colours.",
    "My topic: ",
  ].join(" ");
}

function TemplateDetail({
  preset,
  catalog,
  theme,
  themeKey,
  creating,
  disabled,
  onClose,
  onUse,
}: {
  preset: DeckPreset | null;
  catalog: PresetCatalog | null;
  theme?: PresetTheme;
  themeKey: string;
  creating: boolean;
  disabled: boolean;
  onClose: () => void;
  onUse: (content?: Content) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [content, setContent] = useState<Record<string, Record<string, string>>>({});
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  // A different template starts clean: words written for one template's slots
  // do not belong in another's.
  useEffect(() => {
    setWriting(false);
    setContent({});
    setCopied(null);
  }, [preset?.id]);

  if (!preset) return null;

  const slotsOf = (pattern: string) => catalog?.patternDefinitions?.[pattern as keyof PresetCatalog["patternDefinitions"]]?.slots ?? {};
  const set = (slide: string, slot: string, value: string) =>
    setContent((current) => ({ ...current, [slide]: { ...current[slide], [slot]: value } }));

  // Only what was written is sent. A list slot is one item per line; metric
  // slots keep the template's own example values.
  const written = (): Content => {
    const out: Content = {};
    for (const slide of preset.slides) {
      const definitions = slotsOf(slide.pattern);
      for (const [slot, value] of Object.entries(content[slide.key] ?? {})) {
        const text = value.trim();
        if (!text) continue;
        const kind = definitions[slot]?.kind;
        out[slide.key] ??= {};
        out[slide.key]![slot] = kind === "text-list" ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : text;
      }
    }
    return out;
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt(preset));
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Drawer open onClose={onClose} title={preset.name} meta={`${PURPOSE_LABELS[preset.purpose]} · ${preset.slides.length} slides`} width={560} data-testid="template-detail">
      <div className="dk-template-detail">
        <TemplateCoverPreview templateId={preset.id} themeKey={themeKey} fallback={<TemplateCover preset={preset} theme={theme} large />} />
        <p>{preset.summary}</p>

        <div className="dk-template-detail__actions">
          <Button variant="primary" onClick={() => onUse()} disabled={disabled} data-testid="template-use">
            {creating ? "Creating…" : "Use template"}
          </Button>
          <Button variant="secondary" onClick={() => setWriting((open) => !open)} aria-expanded={writing} data-testid="template-write">
            Start with my content
          </Button>
          <Button variant="ghost" icon="copy" onClick={() => void copyPrompt()} data-testid="template-ask-agent">
            Ask your agent
          </Button>
        </div>
        {copied ? (
          <p className="dk-muted" role="status">
            {copied === "copied"
              ? "Copied. Paste it into your agent and add your topic."
              : "This window could not copy. Select the text below instead."}
          </p>
        ) : null}
        {copied === "failed" ? <pre className="dk-template-detail__prompt">{agentPrompt(preset)}</pre> : null}

        {writing ? (
          <form
            className="dk-template-detail__form"
            data-testid="template-content-form"
            onSubmit={(event) => {
              event.preventDefault();
              onUse(written());
            }}
          >
            <p className="dk-muted">Write what you have. Anything left empty keeps the template's example words.</p>
            {preset.slides.map((slide, index) => {
              const editable = Object.entries(slotsOf(slide.pattern)).filter(([, definition]) => definition.kind !== "metrics");
              if (editable.length === 0) return null;
              return (
                <fieldset key={slide.key} className="dk-template-detail__slide">
                  <legend>
                    {index + 1}. {slide.purpose}
                  </legend>
                  {editable.map(([slot, definition]) => {
                    const example = slide.slots[slot];
                    const placeholder = Array.isArray(example)
                      ? example.map((item) => (typeof item === "string" ? item : item.label)).join("\n")
                      : typeof example === "string"
                        ? example
                        : "";
                    const id = `slot-${slide.key}-${slot}`;
                    return (
                      <label key={slot} className="dk-field" htmlFor={id}>
                        <span className="dk-label">{definition.label}</span>
                        {definition.kind === "text-list" ? (
                          <textarea
                            id={id}
                            className="dk-input"
                            rows={3}
                            placeholder={placeholder}
                            value={content[slide.key]?.[slot] ?? ""}
                            onChange={(event) => set(slide.key, slot, event.currentTarget.value)}
                          />
                        ) : (
                          <input
                            id={id}
                            className="dk-input"
                            placeholder={placeholder}
                            maxLength={definition.recommendedMaxChars ? definition.recommendedMaxChars * 2 : undefined}
                            value={content[slide.key]?.[slot] ?? ""}
                            onChange={(event) => set(slide.key, slot, event.currentTarget.value)}
                          />
                        )}
                      </label>
                    );
                  })}
                </fieldset>
              );
            })}
            <Button variant="primary" type="submit" disabled={disabled} data-testid="template-use-content">
              {creating ? "Creating…" : "Create with my content"}
            </Button>
          </form>
        ) : (
          <>
          {/* Every slide, composed for real: the deck before it exists. */}
          <TemplateContactSheet templateId={preset.id} themeKey={themeKey} />
          <ol className="dk-template-detail__slides" aria-label="Slides in this template">
            {preset.slides.map((slide) => (
              <li key={slide.key}>
                <span>{slide.purpose}</span>
                <span className="dk-muted">{catalog?.patternDefinitions?.[slide.pattern]?.name ?? slide.pattern}</span>
              </li>
            ))}
          </ol>
          </>
        )}
      </div>
    </Drawer>
  );
}

type LanguageAxes = NonNullable<NonNullable<PresetCatalog["designLanguages"]>[string]>["axes"];

/** The ten poles of the five axes, in the order a person reads them. */
const LOOK_POLES: ReadonlyArray<[keyof LanguageAxes, string, string]> = [
  ["expression", "editorial", "Editorial"],
  ["expression", "expressive", "Expressive"],
  ["density", "dense", "Dense"],
  ["density", "spacious", "Spacious"],
  ["imagery", "photographic", "Photographic"],
  ["imagery", "graphic", "Graphic"],
  ["motion", "calm", "Calm"],
  ["motion", "kinetic", "Kinetic"],
  ["tone", "formal", "Formal"],
  ["tone", "playful", "Playful"],
];

/**
 * Whether a language has the chosen look. Within one axis, choosing both poles
 * means either; across axes, every axis chosen must match.
 */
export function matchesLook(axes: LanguageAxes | undefined, poles: ReadonlySet<string>): boolean {
  if (!axes) return false;
  const byAxis = new Map<string, Set<string>>();
  for (const pole of poles) {
    const [axis, value] = pole.split(":") as [string, string];
    if (!byAxis.has(axis)) byAxis.set(axis, new Set());
    byAxis.get(axis)!.add(value);
  }
  for (const [axis, values] of byAxis) {
    if (!values.has(String(axes[axis as keyof LanguageAxes]))) return false;
  }
  return true;
}
