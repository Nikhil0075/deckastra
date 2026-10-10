"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildDocumentScene } from "@deckastra/renderer";
import { useWorkspaceClient } from "@deckastra/workspace-client/react";
import type { TemplatePreviewResult, WorkspaceClient } from "@deckastra/workspace-contracts";

import { useAssetUrls } from "../lib/asset-urls";
import { useBrowserMeasurer } from "../lib/measurer";
import { FinalFrameSlide } from "./FinalFrameSlide";

/**
 * A template drawn as itself (UI audit 2026-10-10, unit 2).
 *
 * The gallery used to draw every template as one CSS mock — an eyebrow, a
 * headline, a line and three tiles — so templates that compose very differently
 * looked alike. These ask the service to compose the template exactly as "Use
 * template" would (`client.presets.previewTemplate`, which stores nothing) and
 * draw the result with `FinalFrameSlide`, the renderer every other thumbnail
 * and export uses.
 *
 * Twenty-four covers must not mean twenty-four compositions at once, so:
 * - a cover is asked for only once its card is on screen, and the request is
 *   abandoned if the card leaves before it answers;
 * - at most `CONCURRENCY` previews are composing at any moment;
 * - answers are kept for the page's life, keyed by template, theme and slides.
 *   The catalog ships with the build, so it cannot change under a running page;
 *   across pages the service's ETag (which names the catalog revision) decides.
 */

type Slides = "cover" | "all";

const CONCURRENCY = 4;
const answers = new Map<string, TemplatePreviewResult>();

/** Clear the page's previews. Tests only: a real catalog cannot change under a page. */
export function forgetTemplatePreviews(): void {
  answers.clear();
}

let running = 0;
const waiting: Array<() => void> = [];

/** Run `work` when one of the composing slots is free; give the slot up when it ends. */
async function limited<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (running >= CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        const at = waiting.indexOf(go);
        if (at >= 0) waiting.splice(at, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      waiting.push(go);
    });
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function keyFor(templateId: string, themeKey: string, slides: Slides): string {
  return `${templateId}|${themeKey}|${slides}`;
}

/** The composed preview once `active`, or null while it is coming or could not be had. */
function useTemplatePreview(templateId: string, themeKey: string, slides: Slides, active: boolean): TemplatePreviewResult | null {
  const client: WorkspaceClient = useWorkspaceClient();
  const key = keyFor(templateId, themeKey, slides);
  const [result, setResult] = useState<TemplatePreviewResult | null>(() => answers.get(key) ?? null);

  useEffect(() => {
    const known = answers.get(key) ?? null;
    setResult(known);
    if (known || !active) return;
    const controller = new AbortController();
    limited(
      () =>
        client.presets.previewTemplate(
          templateId,
          { theme_key: themeKey || undefined, slides },
          { signal: controller.signal },
        ),
      controller.signal,
    )
      .then((answer) => {
        answers.set(key, answer);
        if (!controller.signal.aborted) setResult(answer);
      })
      .catch(() => {
        // An abandoned or refused preview leaves the drawn stand-in in place:
        // the card's name and its Use template button work either way.
      });
    // Leaving the screen, or a new theme, abandons a request still waiting.
    return () => controller.abort();
  }, [active, client, key, slides, templateId, themeKey]);

  return result;
}

/** A box that reports its width and whether it is on screen. */
function useSeen<T extends HTMLElement>(): { ref: React.RefObject<T | null>; width: number; onScreen: boolean } {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    // A margin, so a cover is on its way just before it scrolls into sight.
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)), {
      rootMargin: "200px 0px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, width, onScreen };
}

/**
 * A card's cover: the template's first slide, composed and drawn for real.
 * `fallback` is shown until it arrives, and for good if it cannot.
 */
export function TemplateCoverPreview({
  templateId,
  themeKey,
  fallback,
}: {
  templateId: string;
  themeKey: string;
  fallback: ReactNode;
}) {
  const { ref, width, onScreen } = useSeen<HTMLSpanElement>();
  const preview = useTemplatePreview(templateId, themeKey, "cover", onScreen);
  const measurer = useBrowserMeasurer();
  const resolveAssetUrl = useAssetUrls(preview?.document ?? null);
  const first = useMemo(
    () => (preview ? (buildDocumentScene(preview.document, { measurer }).slides[0] ?? null) : null),
    [preview, measurer],
  );
  return (
    <span ref={ref} className="dk-template-cover" data-template-preview={first ? "rendered" : "pending"}>
      {first && width > 0 ? <FinalFrameSlide scene={first} width={width} resolveAssetUrl={resolveAssetUrl} /> : fallback}
    </span>
  );
}

/** Every slide of a template, for the detail drawer: the deck before it exists. */
export function TemplateContactSheet({ templateId, themeKey }: { templateId: string; themeKey: string }) {
  const { ref, width } = useSeen<HTMLDivElement>();
  const preview = useTemplatePreview(templateId, themeKey, "all", true);
  const measurer = useBrowserMeasurer();
  const resolveAssetUrl = useAssetUrls(preview?.document ?? null);
  const scenes = useMemo(() => (preview ? buildDocumentScene(preview.document, { measurer }).slides : []), [preview, measurer]);
  // Two across, with the sheet's gap between them.
  const tile = width > 0 ? Math.floor((width - 8) / 2) : 0;
  return (
    <div ref={ref} className="dk-template-sheet" data-testid="template-sheet" aria-busy={!preview}>
      {preview && tile > 0
        ? scenes.map((scene, index) => (
            <figure key={scene.slideId} className="dk-template-sheet__slide">
              <FinalFrameSlide scene={scene} width={tile} resolveAssetUrl={resolveAssetUrl} />
              <figcaption>{index + 1}</figcaption>
            </figure>
          ))
        : Array.from({ length: 4 }, (_, index) => <span key={index} className="dk-template-sheet__pending" aria-hidden="true" />)}
    </div>
  );
}
