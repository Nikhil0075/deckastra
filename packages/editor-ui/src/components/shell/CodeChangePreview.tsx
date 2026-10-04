import { useMemo, useState } from "react";
import type { PatchOperation, PresentationDocument } from "@deckastra/presentation-schema";
import { buildDocumentScene } from "@deckastra/renderer";

import { useAssetUrls } from "../../lib/asset-urls";
import { useBrowserMeasurer } from "../../lib/measurer";
import { previewProposal } from "../../lib/proposal-preview";
import { IconButton } from "../../ui";
import { FinalFrameSlide } from "../FinalFrameSlide";

const THUMB_WIDTH = 112;

/** Before/After uses the same final-frame renderer as proposal review. */
export function CodeChangePreview({
  before,
  operations,
}: {
  before: PresentationDocument;
  operations: readonly PatchOperation[];
}) {
  const [at, setAt] = useState(0);
  const measurer = useBrowserMeasurer();
  const preview = useMemo(() => previewProposal(before, operations), [before, operations]);
  const beforeScene = useMemo(() => buildDocumentScene(before, { measurer }), [before, measurer]);
  const afterScene = useMemo(
    () => preview.after ? buildDocumentScene(preview.after, { measurer }) : null,
    [preview.after, measurer],
  );
  const resolveBefore = useAssetUrls(before);
  const resolveAfter = useAssetUrls(preview.after);
  const shown = [...preview.changedSlideIds, ...preview.removedSlideIds];
  const fallbackId = preview.deckWide ? before.slides[0]?.id : undefined;
  const ids = shown.length ? shown : fallbackId ? [fallbackId] : [];
  const safeAt = Math.min(at, Math.max(0, ids.length - 1));
  const slideId = ids[safeAt];
  const beforeSlide = beforeScene.slides.find((slide) => slide.slideId === slideId);
  const afterSlide = afterScene?.slides.find((slide) => slide.slideId === slideId);

  if (!slideId) return <p className="dk-muted dk-code-preview__empty">No slide pixels change.</p>;
  return (
    <div className="dk-code-preview" data-testid="code-preview">
      <div className="dk-code-preview__pair">
        <figure>
          <figcaption>Before</figcaption>
          {beforeSlide
            ? <FinalFrameSlide scene={beforeSlide} width={THUMB_WIDTH} resolveAssetUrl={resolveBefore} />
            : <span className="dk-code-preview__gap">New</span>}
        </figure>
        <figure>
          <figcaption>After</figcaption>
          {afterSlide
            ? <FinalFrameSlide scene={afterSlide} width={THUMB_WIDTH} resolveAssetUrl={resolveAfter} />
            : <span className="dk-code-preview__gap">Removed</span>}
        </figure>
      </div>
      {ids.length > 1 ? (
        <div className="dk-code-preview__stepper">
          <IconButton icon="chevronLeft" label="Previous changed slide" size="sm" disabled={safeAt === 0} onClick={() => setAt((value) => Math.max(0, value - 1))} />
          <span>{safeAt + 1} of {ids.length}</span>
          <IconButton icon="chevronRight" label="Next changed slide" size="sm" disabled={safeAt === ids.length - 1} onClick={() => setAt((value) => Math.min(ids.length - 1, value + 1))} />
        </div>
      ) : null}
    </div>
  );
}

