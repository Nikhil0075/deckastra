"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { buildDocumentScene, type DocumentScene } from "@deckastra/renderer";
import { ScaledSlide } from "@deckastra/renderer/react";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { SharedDocument } from "@deckastra/workspace-contracts";

import { deckLanguages, localizeDocument, PresentMode, useBrowserMeasurer, useChromeTheme } from "@deckastra/editor-ui";
import { Button } from "@deckastra/editor-ui/ui";

/**
 * A deck opened from a share link (gap register doc 01 S2).
 *
 * The audience's page. It has no session, no workspace, and no way into
 * anything else — the token in the URL is the entire credential, and the API
 * hands back one document and nothing about where it lives.
 *
 * Two deliberate absences:
 *
 * **No editor, ever, on this route.** A link may grant `editor`, and a colleague
 * who has one should open the real editor at `/edit/{id}` — which requires a
 * session. This page presents. Mixing the two would mean the public route had to
 * carry every editing surface, and every one of those is a place to leak a
 * workspace.
 *
 * **No sign-in prompt on failure.** A link that has expired, been revoked or was
 * never real all show the same thing, because telling a holder which it is
 * confirms that a deck exists behind the id they tried.
 *
 * **The language is the viewer's, and the link can suggest one** (integration
 * plan 01 §3.1): `?lang=hi-IN` opens the Hindi overlay, and the picker switches
 * between the deck's languages. It is applied to a copy here, exactly as the
 * editor shows a language — nothing about it is stored, and a link without
 * `lang` shows the deck as written.
 */

type State =
  | { phase: "loading" }
  | { phase: "ready"; deck: SharedDocument }
  | { phase: "unavailable" };

export default function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const client = useWorkspaceClient();
  const { token } = use(params);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [presenting, setPresenting] = useState(false);
  const [selected, setSelected] = useState(0);
  const [locale, setLocale] = useState<string | null>(null);

  // `?lang=` is read once the deck has arrived, and only a language the deck
  // has is honoured: a link naming one it lacks shows the deck as written.
  useEffect(() => {
    if (state.phase !== "ready" || typeof window === "undefined") return;
    const asked = new URLSearchParams(window.location.search).get("lang");
    const known = deckLanguages(state.deck.document).find((language) => !language.source && language.tag.toLowerCase() === asked?.toLowerCase());
    setLocale(known?.tag ?? null);
  }, [state]);

  const chooseLocale = (tag: string | null) => {
    setLocale(tag);
    // Kept in the address so the link a viewer copies opens where they are.
    const url = new URL(window.location.href);
    if (tag) url.searchParams.set("lang", tag);
    else url.searchParams.delete("lang");
    window.history.replaceState(null, "", url);
  };

  // Pictures and recordings load through the share's own route: the token in
  // the path authorises them, and only files this document cites are served.
  const resolveAssetUrl = useCallback(
    (assetId: string) => client.shares.assetUrl?.(token, assetId),
    [client, token],
  );

  useEffect(() => {
    let cancelled = false;

    client.shares
      .redeem(token)
      .then((deck) => {
        if (!cancelled) setState({ phase: "ready", deck });
      })
      .catch(() => {
        // Expired, revoked and never-existed answer alike on purpose, so there is
        // deliberately nothing here that could tell them apart.
        if (!cancelled) setState({ phase: "unavailable" });
      });

    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const measurer = useBrowserMeasurer();
  const [stage, stageWidth] = useWidth();
  // The viewer's light or dark choice, as everywhere else in the product.
  useChromeTheme();
  const languages = useMemo(() => (state.phase === "ready" ? deckLanguages(state.deck.document) : []), [state]);
  const scene: DocumentScene | null = useMemo(() => {
    if (state.phase !== "ready") return null;
    return buildDocumentScene(localizeDocument(state.deck.document, locale), { measurer });
  }, [state, locale, measurer]);
  const narrated = state.phase === "ready" && state.deck.document.playback?.mode === "narrated";

  if (state.phase === "loading") {
    return (
      <main className="dk-root dk-shared dk-shared--centred">
        <p className="dk-muted" role="status">
          Opening…
        </p>
      </main>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <main className="dk-root dk-shared dk-shared--centred">
        <div className="dk-shared__notice">
          <h1 className="dk-shared__title">This link is not available</h1>
          {/* One message for expired, revoked and never-real alike. Which of the
              three it is would tell a holder that a deck exists behind the id
              they tried. */}
          <p className="dk-muted">It may have expired or been turned off. Ask whoever sent it for a new one.</p>
        </div>
      </main>
    );
  }

  if (presenting && scene) {
    return (
      <PresentMode scene={scene} onExit={() => setPresenting(false)} initialSlide={selected} resolveAssetUrl={resolveAssetUrl} />
    );
  }

  const current = scene?.slides[selected];

  return (
    <main className="dk-root dk-shared">
      <header className="dk-shared__header">
        <div className="dk-shared__heading">
          <h1 className="dk-shared__title">{state.deck.title}</h1>
          <p className="dk-muted">{scene?.slides.length} slides · shared with you</p>
        </div>
        {languages.length > 1 ? (
          <label className="dk-field dk-shared__language">
            <span className="dk-label">Language</span>
            <select
              className="dk-input"
              value={locale ?? languages[0]!.tag}
              onChange={(event) => chooseLocale(languages.find((language) => language.tag === event.target.value)?.source ? null : event.target.value)}
              data-testid="shared-language"
            >
              {languages.map((language) => (
                <option key={language.tag} value={language.tag}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {/* Browsers refuse sound until someone clicks: presenting is that click,
            so a narrated deck says plainly that it will speak. */}
        <Button variant="primary" icon="play" onClick={() => setPresenting(true)}>
          {narrated ? "Play with sound" : "Present"}
        </Button>
      </header>

      {current ? (
        <div className="dk-shared__stage" ref={stage}>
          {stageWidth > 0 ? <ScaledSlide scene={current} width={stageWidth} mode="present" resolveAssetUrl={resolveAssetUrl} /> : null}
        </div>
      ) : null}

      {/* Arrow keys work here too, so the thumbnails are a real control rather
          than a mouse-only one (WCAG 2.1 AA, 2.1.1 keyboard). */}
      <div
        role="listbox"
        aria-label="Slides"
        className="dk-shared__strip"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") setSelected((index) => Math.min(index + 1, (scene?.slides.length ?? 1) - 1));
          if (event.key === "ArrowLeft") setSelected((index) => Math.max(index - 1, 0));
        }}
      >
        {scene?.slides.map((slide, index) => (
          <button
            key={slide.slideId}
            role="option"
            aria-selected={index === selected}
            aria-label={`Slide ${index + 1}${slide.keyMessage ? `: ${slide.keyMessage}` : ""}`}
            onClick={() => setSelected(index)}
            className="dk-shared__thumb"
          >
            <ScaledSlide scene={slide} width={168} mode="present" resolveAssetUrl={resolveAssetUrl} />
          </button>
        ))}
      </div>
    </main>
  );
}

/** The width of an element, kept current: the slide fills whatever the window gives it. */
function useWidth(): [(element: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
