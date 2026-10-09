"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { DeckPreset, PresetCatalog, PurposeGroup } from "@deckastra/workspace-contracts";

import { Button, Select, StatusChip } from "../ui";
import { cx } from "../ui/cx";

const PURPOSE_LABELS: Record<PurposeGroup | "all", string> = {
  all: "All",
  business: "Business",
  product: "Product",
  teaching: "Teaching",
  technical: "Technical",
  team: "Team",
  personal: "Personal",
};

export function NewDeckStart({
  projectId,
  disabled = false,
  focusToken = 0,
  onCreated,
  onBlank,
  onOpenFile,
  onBuildWithAgent,
}: {
  projectId: string;
  disabled?: boolean;
  focusToken?: number;
  onCreated: (presentationId: string) => void;
  onBlank?: () => void;
  onOpenFile?: () => void;
  onBuildWithAgent?: () => void;
}) {
  const client = useWorkspaceClient();
  const [catalog, setCatalog] = useState<PresetCatalog | null>(null);
  const [purpose, setPurpose] = useState<PurposeGroup | "all">("all");
  const [query, setQuery] = useState("");
  const [themeKey, setThemeKey] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.presets.list({ fresh: true }).then((value) => {
      if (cancelled) return;
      setCatalog(value);
      setThemeKey(value.presets[0]?.themeKey ?? value.themes[0]?.key ?? "");
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Templates could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [client, projectId]);

  useEffect(() => {
    if (focusToken) start.current?.focus();
  }, [focusToken]);

  const shown = useMemo(
    () => {
      const needle = query.trim().toLocaleLowerCase();
      return catalog?.presets.filter((preset) => {
        if (purpose !== "all" && preset.purpose !== purpose) return false;
        if (!needle) return true;
        return [preset.name, preset.summary, preset.purpose, ...preset.tags]
          .some((value) => value.toLocaleLowerCase().includes(needle));
      }) ?? [];
    },
    [catalog, purpose, query],
  );

  const choose = async (preset: DeckPreset) => {
    setCreating(preset.id);
    setError(null);
    try {
      const made = await client.presets.create({
        template_id: preset.id,
        project_id: projectId,
        theme_key: themeKey || preset.themeKey,
      });
      onCreated(made.presentation_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The deck could not be created.");
      setCreating(null);
    }
  };

  return (
    <section ref={start} tabIndex={-1} className="dk-template-start" aria-labelledby="new-from-template" data-testid="template-start">
      <div className="dk-template-start__heading">
        <div>
          <span className="dk-label">Start a deck</span>
          <h2 id="new-from-template">New from template</h2>
          <p className="dk-muted">Choose the job first. Every template stays fully editable.</p>
        </div>
        <div className="dk-template-start__utilities">
          {onBlank ? <Button variant="secondary" onClick={onBlank} disabled={disabled} data-testid="new-deck">Blank deck</Button> : null}
          {onOpenFile ? <Button variant="ghost" icon="upload" onClick={onOpenFile} data-testid="open-deck-file">Open .mydeck file</Button> : null}
        </div>
      </div>

      <div className="dk-template-start__controls">
        <div className="dk-template-start__purposes" role="group" aria-label="Filter templates by purpose">
          {(Object.keys(PURPOSE_LABELS) as Array<PurposeGroup | "all">).map((key) => (
            <button
              key={key}
              type="button"
              className={cx("dk-template-start__purpose", purpose === key && "dk-template-start__purpose--current")}
              aria-pressed={purpose === key}
              onClick={() => setPurpose(key)}
            >
              {PURPOSE_LABELS[key]}
            </button>
          ))}
        </div>
        <label className="dk-template-start__search">
          <span>Search templates</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Pitch, workshop, architecture…"
          />
        </label>
        {catalog?.themes.length ? (
          <Select
            label="Preview theme"
            value={themeKey}
            onChange={setThemeKey}
            options={catalog.themes.map((theme) => ({ value: theme.key, label: theme.name }))}
            data-testid="template-theme"
          />
        ) : null}
      </div>

      {error ? <p className="dk-decks__error" role="alert">{error}</p> : null}
      {!catalog && !error ? <p className="dk-muted" role="status">Loading templates…</p> : null}
      {catalog ? <p className="dk-template-start__result-count" role="status">{shown.length} reviewed template{shown.length === 1 ? "" : "s"}</p> : null}

      <div className="dk-template-start__grid">
        {shown.map((preset) => {
          const theme = catalog?.themes.find((candidate) => candidate.key === (themeKey || preset.themeKey));
          const background = theme?.preview.background ?? "#ffffff";
          const foreground = theme?.preview.foreground ?? "#111111";
          const accent = theme?.preview.accent ?? "#2563eb";
          const surface = theme?.preview.surface ?? "#f3f4f6";
          const opening = preset.slides[0];
          const openingHeadline = opening && typeof opening.slots.headline === "string" ? opening.slots.headline : preset.name;
          const openingEyebrow = opening && typeof opening.slots.eyebrow === "string" ? opening.slots.eyebrow : PURPOSE_LABELS[preset.purpose];
          const motionName = catalog?.motionStyles?.[preset.motionStyle]?.name ?? preset.motionStyle;
          return (
            <article key={preset.id} className="dk-template-card">
              <div
                className="dk-template-card__preview"
                style={{ background, color: foreground } as CSSProperties}
                aria-hidden="true"
              >
                <span className="dk-template-card__kicker" style={{ color: accent }}>{openingEyebrow}</span>
                <strong>{openingHeadline}</strong>
                <span className="dk-template-card__line" style={{ background: accent }} />
                <span className="dk-template-card__tiles">
                  {[0, 1, 2].map((tile) => <i key={tile} style={{ background: surface, borderColor: foreground }} />)}
                </span>
              </div>
              <div className="dk-template-card__body">
                <div>
                  <h3>{preset.name}</h3>
                  <p>{preset.summary}</p>
                </div>
                <span className="dk-template-card__meta">
                  <StatusChip tone="neutral">{preset.slides.length} slides</StatusChip>
                  <span>{motionName} motion</span>
                  <span>{new Set(preset.slides.map((slide) => slide.pattern)).size} patterns</span>
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void choose(preset)}
                  disabled={disabled || creating !== null}
                  data-testid={`use-template-${preset.id}`}
                >
                  {creating === preset.id ? "Creating…" : "Use template"}
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      <details className="dk-agent-start" data-testid="build-with-agent">
        <summary>Build with your agent</summary>
        <div className="dk-agent-start__body">
          <div>
            <h3>Your agent writes the story; Deckastra composes the deck.</h3>
            <p className="dk-muted">Connect once, ask it to list presets, then let it create or compose through MCP. It never has to guess coordinates.</p>
          </div>
          <ol>
            <li>Open Settings › Agents and copy the setup for your client.</li>
            <li>Ask the agent to call <code>preset_list</code>.</li>
            <li>Use <code>deck_from_template</code> or <code>deck_compose</code>.</li>
          </ol>
          {onBuildWithAgent ? <Button variant="secondary" onClick={onBuildWithAgent}>Set up an agent</Button> : null}
        </div>
      </details>
    </section>
  );
}
