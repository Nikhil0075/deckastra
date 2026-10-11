import { useEffect, useMemo, useState } from "react";
import type { PresentationDocument, Slide } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";
import type { PatternPreviews, WorkspaceClient } from "@deckastra/workspace-contracts";

import { useBrowserMeasurer } from "../../lib/measurer";
import { FinalFrameSlide } from "../FinalFrameSlide";
import { useSeen } from "../TemplatePreview";

/**
 * A pattern's tile, drawn as the slide Insert would add (UI audit follow-up,
 * 2026-10-11). Every tile used to be the same grid icon with a cut-off name, so
 * the library could not be read without inserting things to see them.
 *
 * The slides come from `GET /v1/patterns/preview`, one answer per design
 * language, and are drawn here in the deck's own theme, so a tile is the deck's
 * slide and not a generic one. A tile draws only once it is on screen.
 */

const answers = new Map<string, Promise<PatternPreviews>>();

/** For tests: forget what was read. */
export function forgetPatternPreviews(): void {
  answers.clear();
}

/** Every pattern's example slide in this deck's language, read once per language. */
export function usePatternPreviews(client: WorkspaceClient | null | undefined, language: string, active: boolean): PatternPreviews | null {
  const [previews, setPreviews] = useState<PatternPreviews | null>(null);
  useEffect(() => {
    const read = client?.presets.previewPatterns;
    if (!active || !read) return;
    let live = true;
    let pending = answers.get(language);
    if (!pending) {
      pending = read.call(client.presets, language);
      answers.set(language, pending);
      // A failed read is forgotten, so the next time the library opens asks again.
      pending.catch(() => answers.delete(language));
    }
    pending.then((value) => live && setPreviews(value)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, language, active]);
  return previews;
}

export function PatternThumb({
  slide,
  document,
  resolveAssetUrl,
}: {
  slide: unknown;
  document: PresentationDocument;
  resolveAssetUrl?: (assetId: string, storageKey?: string) => string | undefined;
}) {
  const { ref, width, onScreen } = useSeen<HTMLSpanElement>();
  const measurer = useBrowserMeasurer();
  const scene = useMemo(() => {
    if (!onScreen) return null;
    try {
      // The deck's theme and viewport around the pattern's one slide; nothing
      // else of the deck, so its languages and assets do not apply.
      const single = { ...document, slides: [slide as Slide], locales: undefined } as PresentationDocument;
      return buildDocumentScene(single, { measurer }).slides[0] ?? null;
    } catch {
      return null;
    }
  }, [onScreen, slide, document.theme, document.viewport, measurer]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span ref={ref} className="dk-library__thumb" aria-hidden="true">
      {scene && width > 0 ? <FinalFrameSlide scene={scene} width={width} resolveAssetUrl={resolveAssetUrl} /> : null}
    </span>
  );
}
