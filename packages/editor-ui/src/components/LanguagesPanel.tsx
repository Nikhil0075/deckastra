"use client";

import { serviceWords } from "../lib/assistant-words";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localeDirection, sameLanguage, sourceLocale } from "@deckastra/presentation-schema";
import {
  addLocaleOperations,
  removeLocaleOperations,
  setLocaleStatusOperations,
} from "@deckastra/presentation-core";
import { BUNDLED_FONTS, buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { LanguagesStatus, PaidServiceQuote } from "@deckastra/workspace-contracts";

import { deckLanguages, LANGUAGE_OPTIONS, languageLabel } from "../lib/languages";
import { localizeDocument } from "../lib/locale-lens";
import { useBrowserMeasurer } from "../lib/measurer";
import type { EditorApi } from "../lib/useEditor";
import { Button, Select, StatusChip, TextField } from "../ui";
import { FinalFrameSlide } from "./FinalFrameSlide";

/**
 * The Languages panel (integration plan 01 §3.2).
 *
 * One row per language the deck has: how much of it is translated and current,
 * and the three things a person does with a language — look at it, translate
 * what is missing or outdated, and say they have reviewed it. Translating is a
 * proposal like any agent change: it appears in Pending changes with Before and
 * After pictures in the target language, and nothing is written until a person
 * applies it (or, for a small change, the risk tier says it may apply now).
 *
 * The side-by-side review shows the slide on screen in the deck's own language
 * and in the chosen one — the check a translator actually makes, at the size an
 * audience sees.
 */
export function LanguagesPanel({
  editor,
  presentationId,
  resolveAssetUrl,
  onProposed,
}: {
  editor: EditorApi;
  presentationId: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
  /** A translation became a pending proposal; the caller refreshes its list. */
  onProposed?: () => void;
}) {
  const client = useWorkspaceClient();
  const source = editor.sourceDocument;
  const languages = deckLanguages(source);
  const sourceTag = sourceLocale(source);
  const [status, setStatus] = useState<LanguagesStatus | null>(null);
  const [adding, setAdding] = useState<string>(() => firstAvailable(source));
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [glossary, setGlossary] = useState("");
  const [quotes, setQuotes] = useState<Record<string, PaidServiceQuote>>({});

  useEffect(() => {
    let cancelled = false;
    client.languages
      ?.status()
      .then((answer) => {
        if (!cancelled) setStatus(validStatus(answer));
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    // Do-not-translate words follow the person, like the library's favourites.
    client.session
      .readPreference?.("translation")
      .then((value) => {
        const terms = (value as { glossary?: unknown } | undefined)?.glossary;
        if (!cancelled && Array.isArray(terms)) setGlossary(terms.filter((term) => typeof term === "string").join(", "));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  // A language just added is no longer one to offer; move the picker on.
  const languageCount = languages.length;
  useEffect(() => {
    setAdding((current) =>
      !current || deckLanguages(source).some((language) => sameLanguage(language.tag, current)) ? firstAvailable(source) : current,
    );
    // Only when the set of languages changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languageCount]);

  const terms = useMemo(
    () => glossary.split(",").map((term) => term.trim()).filter(Boolean).slice(0, 200),
    [glossary],
  );

  const saveGlossary = useCallback(() => {
    setQuotes({});
    void client.session.writePreference?.("translation", { glossary: terms }).catch(() => {});
  }, [client, terms]);

  const add = useCallback(() => {
    const tag = (custom.trim() || adding).trim();
    if (!tag) return;
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(tag)) {
      setMessage({ tone: "error", text: `"${tag}" is not a language tag. Use one like hi-IN, ar or pt-BR.` });
      return;
    }
    try {
      editor.apply(addLocaleOperations(source, tag, { direction: localeDirection(tag) }), { label: `Add ${languageLabel(tag)}` });
      setCustom("");
      setMessage({ tone: "ok", text: `${languageLabel(tag)} added. Translate it, or switch to it and type.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "That language could not be added." });
    }
  }, [adding, custom, editor, source]);

  const translate = useCallback(
    async (tag: string, scope: "missing" | "outdated") => {
      if (!client.languages) {
        setMessage({ tone: "error", text: "This surface has no translation service." });
        return;
      }
      setBusy(`${tag}:${scope}`);
      setMessage(null);
      try {
        // The translation is of the words on the server, so they must be saved.
        if (!(await editor.saveNow())) {
          setMessage({ tone: "error", text: "Your latest edits are not saved yet, so nothing was translated. Try again in a moment." });
          return;
        }
        const request = {
          scope,
          expected_version_id: editor.currentVersionId(),
          glossary: terms,
        } as const;
        const key = `${tag}:${scope}`;
        const quote = quotes[key];
        if (!quote) {
          const offered = await client.languages.quoteTranslation(presentationId, tag, request);
          setQuotes((current) => ({ ...current, [key]: offered }));
          setMessage({ tone: "ok", text: `This translation will use ${offered.credit_cost} credit${offered.credit_cost === 1 ? "" : "s"}. Press Confirm translation to continue.` });
          return;
        }
        const result = await client.languages.translate(presentationId, tag, { ...request, quote_token: quote.quote_token });
        setQuotes((current) => { const next = { ...current }; delete next[key]; return next; });
        if (result.outcome === "applied" && result.document && result.version_id) {
          editor.adoptDocument(result.document, result.version_id);
          setMessage({ tone: "ok", text: `Translated ${result.translated?.length ?? 0} item(s) into ${languageLabel(tag)}.` });
        } else if (result.outcome === "pending") {
          onProposed?.();
          setMessage({
            tone: "ok",
            text: `${result.translated?.length ?? 0} translation(s) are waiting for you in Pending changes, with Before and After pictures.`,
          });
        } else {
          setMessage({ tone: "ok", text: result.message ?? "Nothing to translate." });
        }
        if (result.refused?.length) {
          setMessage({
            tone: "error",
            text: `${result.refused.length} item(s) were left untranslated: the translation changed a number, a link or a kept word.`,
          });
        }
      } catch (error) {
        setQuotes({});
        setMessage({ tone: "error", text: error instanceof Error ? error.message : "The translation could not be made." });
      } finally {
        setBusy(null);
      }
    },
    [client, editor, onProposed, presentationId, quotes, terms],
  );

  const scriptFonts = useMemo(
    () => [{ value: "", label: "The theme's fonts" }, ...BUNDLED_FONTS.filter((font) => font.group === "World scripts").map((font) => ({ value: font.family, label: font.family }))],
    [],
  );

  const setFont = useCallback(
    (tag: string, family: string) => {
      const overlay = source.locales?.[tag];
      if (!overlay) return;
      const path = `/locales/${tag}/fonts`;
      if (!family) {
        if (overlay.fonts) editor.apply([{ op: "remove", path }], { label: "Use the theme's fonts" });
        return;
      }
      editor.apply([{ op: overlay.fonts ? "replace" : "add", path, value: { heading: family, body: family } }], {
        label: `Set ${languageLabel(tag)} font`,
      });
    },
    [editor, source],
  );

  return (
    <div className="dk-languages" data-testid="languages-panel">
      {status ? (
        <p className="dk-field__hint" data-testid="translation-route">
          {status.translation.available
            ? serviceWords(status.translation.reason, "Slide text is sent online to be translated when you press Translate.")
            : serviceWords(
                status.translation.reason && `Translation is not available: ${status.translation.reason}`,
                "Translation is not set up on this computer yet.",
              )}
        </p>
      ) : null}

      <ul className="dk-languages__list">
        {languages.map((language) => (
          <li key={language.tag} className="dk-languages__row" data-testid="language-row" data-language={language.tag}>
            <div className="dk-languages__head">
              <span className="dk-languages__name" dir="auto">
                {language.label}
              </span>
              {language.source ? (
                <StatusChip tone="neutral">Original</StatusChip>
              ) : language.status === "reviewed" ? (
                <StatusChip tone="action">Reviewed</StatusChip>
              ) : (
                <StatusChip tone="waiting">{language.status === "partially reviewed" ? "Partially reviewed" : "Draft"}</StatusChip>
              )}
            </div>
            {language.source ? (
              <p className="dk-muted">The words as written. Every other language translates these.</p>
            ) : (
              <>
                <div
                  className="dk-languages__bar"
                  role="progressbar"
                  aria-label={`${language.label} translated`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(language.done * 100)}
                >
                  <span style={{ width: `${Math.round(language.done * 100)}%` }} />
                </div>
                <p className="dk-languages__counts" data-testid="language-counts">
                  {language.translated} translated · {language.outdated} outdated · {language.missing} missing
                </p>
              </>
            )}
            <div className="dk-languages__actions">
              <Button
                size="sm"
                variant={(editor.locale ?? sourceTag) === language.tag ? "secondary" : "ghost"}
                icon="eye"
                aria-pressed={(editor.locale ?? sourceTag) === language.tag}
                onClick={() => editor.setLocale(language.source ? null : language.tag)}
                data-testid={`show-language-${language.tag}`}
              >
                Show
              </Button>
              {language.source ? null : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="language"
                    disabled={busy !== null || !language.missing || status?.translation.available === false}
                    onClick={() => void translate(language.tag, "missing")}
                    data-testid={`translate-missing-${language.tag}`}
                  >
                    {busy === `${language.tag}:missing` ? "Translating…" : quotes[`${language.tag}:missing`] ? `Confirm translation · ${quotes[`${language.tag}:missing`]!.credit_cost} credits` : `Translate missing (${language.missing})`}
                  </Button>
                  {language.outdated ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null || status?.translation.available === false}
                      onClick={() => void translate(language.tag, "outdated")}
                      data-testid={`translate-outdated-${language.tag}`}
                    >
                      {busy === `${language.tag}:outdated` ? "Translating…" : quotes[`${language.tag}:outdated`] ? `Confirm translation · ${quotes[`${language.tag}:outdated`]!.credit_cost} credits` : `Re-translate outdated (${language.outdated})`}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setReviewing((current) => (current === language.tag ? null : language.tag))}>
                    {reviewing === language.tag ? "Close review" : "Review side by side"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="check"
                    onClick={() =>
                      editor.apply(setLocaleStatusOperations(source, language.tag, language.status === "reviewed" ? "draft" : "reviewed"), {
                        label: language.status === "reviewed" ? "Mark as draft" : "Mark as reviewed",
                      })
                    }
                  >
                    {language.status === "reviewed" ? "Mark as draft" : "Mark reviewed"}
                  </Button>
                  <Select
                    label={`Font for ${language.label}`}
                    value={(source.locales?.[language.tag]?.fonts?.body as string | undefined) ?? ""}
                    options={scriptFonts}
                    onChange={(family) => setFont(language.tag, family)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={() => {
                      if (editor.locale === language.tag) editor.setLocale(null);
                      editor.apply(removeLocaleOperations(source, language.tag), { label: `Remove ${language.label}` });
                    }}
                    data-testid={`remove-language-${language.tag}`}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            {reviewing === language.tag ? <SideBySide editor={editor} tag={language.tag} resolveAssetUrl={resolveAssetUrl} /> : null}
          </li>
        ))}
      </ul>

      <div className="dk-languages__add">
        <Select
          label="Add a language"
          value={adding}
          options={LANGUAGE_OPTIONS.filter((option) => !languages.some((language) => sameLanguage(language.tag, option.tag))).map((option) => ({
            value: option.tag,
            label: languageLabel(option.tag),
          }))}
          onChange={setAdding}
          data-testid="add-language-select"
        />
        <TextField label="Or a language tag" value={custom} onChange={setCustom} placeholder="e.g. sw-KE" />
        <Button size="sm" variant="secondary" icon="plus" onClick={add} data-testid="add-language">
          Add language
        </Button>
      </div>

      <TextField
        label="Keep these words as they are"
        hint="Brand and product names, separated by commas. Numbers, links and {{placeholders}} are always kept."
        value={glossary}
        onChange={setGlossary}
        onBlur={saveGlossary}
        data-testid="translation-glossary"
      />

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "dk-languages__error" : "dk-muted"} data-testid="languages-message">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/** The slide on screen, in the deck's own words and in `tag`, at the same size. */
function SideBySide({
  editor,
  tag,
  resolveAssetUrl,
}: {
  editor: EditorApi;
  tag: string;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const measurer = useBrowserMeasurer();
  const source = editor.sourceDocument;
  const sourceScene = useMemo(() => buildDocumentScene(source, { measurer }), [source, measurer]);
  const localScene = useMemo(() => buildDocumentScene(localizeDocument(source, tag), { measurer }), [source, tag, measurer]);
  const index = Math.min(editor.slideIndex, sourceScene.slides.length - 1);
  const left = sourceScene.slides[index];
  const right = localScene.slides[index];
  if (!left || !right) return null;
  return (
    <div className="dk-languages__review" data-testid="language-review">
      <figure>
        <figcaption>{languageLabel(sourceLocale(source))}</figcaption>
        <FinalFrameSlide scene={left} width={150} resolveAssetUrl={resolveAssetUrl} />
      </figure>
      <figure>
        <figcaption dir="auto">{languageLabel(tag)}</figcaption>
        <FinalFrameSlide scene={right} width={150} resolveAssetUrl={resolveAssetUrl} />
      </figure>
    </div>
  );
}

function firstAvailable(document: EditorApi["sourceDocument"]): string {
  const present = new Set([sourceLocale(document).toLowerCase(), ...Object.keys(document.locales ?? {}).map((tag) => tag.toLowerCase())]);
  return LANGUAGE_OPTIONS.find((option) => !present.has(option.tag.toLowerCase()))?.tag ?? "";
}

/** A status answer with both halves, or nothing: an older service answers something else. */
function validStatus(answer: unknown): LanguagesStatus | null {
  const value = answer as Partial<LanguagesStatus> | null | undefined;
  return value?.translation && value.speech ? (value as LanguagesStatus) : null;
}
